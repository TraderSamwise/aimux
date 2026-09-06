#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/notifications/store.json", ROOT);

const paths = await import(new URL("dist/paths.js", ROOT));
const notifications = await import(new URL("dist/notifications.js", ROOT));
const notificationContext = await import(new URL("dist/notification-context.js", ROOT));
const projectEvents = await import(new URL("dist/project-events.js", ROOT));
const exchangeStore = await import(new URL("dist/runtime-core/exchange-store.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function dynamicNormalizer() {
  const ids = new Map();
  const idToken = (id) => {
    if (!ids.has(id)) ids.set(id, `<id:${ids.size + 1}>`);
    return ids.get(id);
  };
  const timestampPattern = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/g;
  const generatedNotificationIdPattern = /\bnotification-(?:record-)?[A-Za-z0-9_.:-]*-[A-Za-z0-9_.:-]+\b/g;
  const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const normalizeString = (input) =>
    input
      .replace(timestampPattern, "<ts>")
      .replace(generatedNotificationIdPattern, (id) => idToken(id))
      .replace(uuidPattern, (id) => idToken(id));
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, key === "projectId" ? "<project-id>" : normalize(nested)]),
      );
    }
    return typeof value === "string" ? normalizeString(value) : value;
  };
  return { normalize, ids };
}

function assertDynamicStructure(value, label) {
  const failures = [];
  const visit = (node, path = "$") => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    const createdAt = typeof node.createdAt === "string" ? Date.parse(node.createdAt) : undefined;
    const updatedAt = typeof node.updatedAt === "string" ? Date.parse(node.updatedAt) : undefined;
    if (Number.isFinite(createdAt) && Number.isFinite(updatedAt) && createdAt > updatedAt) {
      failures.push(`${path}: createdAt is after updatedAt`);
    }
    const ts = typeof node.ts === "string" ? Date.parse(node.ts) : undefined;
    const deliveredAt = typeof node.deliveredAt === "string" ? Date.parse(node.deliveredAt) : undefined;
    if (Number.isFinite(ts) && Number.isFinite(deliveredAt) && ts > deliveredAt) {
      failures.push(`${path}: ts is after deliveredAt`);
    }
    for (const [key, nested] of Object.entries(node)) {
      if (
        ["id", "threadId", "messageId", "lastMessageId", "notificationId", "projectId"].includes(key) &&
        typeof nested === "string" &&
        nested.trim() === ""
      ) {
        failures.push(`${path}.${key}: id-like field is empty`);
      }
      visit(nested, `${path}.${key}`);
    }
  };
  visit(value);
  if (failures.length > 0) throw new Error(`${label} dynamic structure failed:\n${failures.join("\n")}`);
}

function normalize(value, base, { dynamic = false } = {}) {
  const roots = [base];
  try {
    const canonical = realpathSync(base);
    if (canonical !== base) roots.push(canonical);
  } catch {
    // Temporary directory may be gone.
  }
  const rooted = JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return roots.reduce((text, root) => text.replaceAll(root, "<root>"), nested);
    }),
  );
  if (!dynamic) return rooted;
  assertDynamicStructure(rooted, base);
  return dynamicNormalizer().normalize(rooted);
}

function seedExchange() {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    threads: [
      {
        id: "thread-1",
        title: "Needs input",
        kind: "conversation",
        status: "open",
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
        createdBy: "aimux",
        participants: ["aimux", "codex-1"],
        tags: ["notification"],
      },
      {
        id: "thread-2",
        title: "Build done",
        kind: "conversation",
        status: "open",
        createdAt: "2026-01-01T00:00:02.000Z",
        updatedAt: "2026-01-01T00:00:04.000Z",
        createdBy: "aimux",
        participants: ["aimux", "codex-2"],
        tags: ["notification"],
      },
      {
        id: "thread-other",
        title: "Workflow",
        kind: "conversation",
        status: "open",
        createdAt: "2026-01-01T00:00:05.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
        createdBy: "user",
        participants: ["user", "codex-1"],
        tags: [],
      },
    ],
    messages: [
      {
        id: "message-1",
        threadId: "thread-1",
        ts: "2026-01-01T00:00:01.000Z",
        from: "aimux",
        to: ["codex-1"],
        kind: "note",
        body: "old body",
        metadata: {
          notificationRecordId: "record-1",
          notificationSessionId: "codex-1",
          notificationTargetKey: "session:codex-1",
          notificationTargetKind: "session",
        },
      },
      {
        id: "message-2",
        threadId: "thread-2",
        ts: "2026-01-01T00:00:04.000Z",
        from: "aimux",
        to: ["codex-2"],
        kind: "note",
        body: "new body",
        metadata: {
          notificationRecordId: "record-2",
          notificationSessionId: "codex-2",
          notificationTargetKey: "session:codex-2",
          notificationTargetKind: "session",
          notificationKind: "needs_input",
          notificationInteractionId: "interact-2",
          notificationInteractionType: "permission",
          notificationInteractionSummary: "Allow command",
          notificationInteractionTelemetry: true,
        },
      },
      {
        id: "message-other",
        threadId: "thread-other",
        ts: "2026-01-01T00:00:05.000Z",
        from: "user",
        to: ["codex-1"],
        kind: "request",
        body: "not a notification",
      },
    ],
    tasks: [],
    handoffs: [],
    reviews: [],
    waits: [],
    inbox: [
      {
        id: "inbox:codex-1:thread:thread-1",
        participantId: "codex-1",
        subjectKind: "thread",
        subjectId: "thread-1",
        state: "done",
        urgency: 0,
        updatedAt: "2026-01-01T00:00:03.000Z",
      },
      {
        id: "inbox:codex-2:thread:thread-2",
        participantId: "codex-2",
        subjectKind: "thread",
        subjectId: "thread-2",
        state: "unread",
        urgency: 3,
        updatedAt: "2026-01-01T00:00:04.000Z",
      },
    ],
    planRefs: [],
    continuityRefs: [],
    attachmentRefs: [],
  };
}

async function withProject(label, fn, options = {}) {
  const base = mkdtempSync(join(tmpdir(), `aimux-notifications-store-contract-${label}-`));
  try {
    const projectRoot = join(base, "repo");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    await paths.initPaths(projectRoot);
    const runtimeExchangePath = paths.getReadOnlyProjectPathsFor(projectRoot).runtimeExchangePath;
    if (options.seed !== false) {
      exchangeStore.createRuntimeExchangeStore(runtimeExchangePath).write(seedExchange());
    }
    return normalize(await fn(projectRoot, runtimeExchangePath), base, { dynamic: options.dynamic === true });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const cases = [];
const add = async (name, scenario, fn, options) => {
  const input = { scenario };
  cases.push({
    id: `notifications-store-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/notifications.test.ts, native/crates/aimux/tests/project_service_notifications.rs",
    input,
    output: await withProject(scenario, fn, options),
    inputSha256: hash(input),
  });
};

await add("lists notification threads from latest message metadata", "list", (projectRoot) =>
  notifications.listNotificationSnapshot({ projectRoot, limit: 10 }),
);

await add("filters unread notifications by session and limit", "filter-unread-session-limit", (projectRoot) =>
  notifications.listNotificationSnapshot({ projectRoot, unreadOnly: true, sessionId: "codex-2", limit: 1 }),
);

await add("marks matching notification inbox entries read", "mark-read", (projectRoot, runtimeExchangePath) => {
  const updated = notifications.markNotificationsRead({ projectRoot, id: "record-2", sessionId: "codex-2" });
  const exchange = exchangeStore.createRuntimeExchangeStore(runtimeExchangePath).read();
  return {
    updated,
    inbox: exchange.inbox,
    snapshot: notifications.listNotificationSnapshot({ projectRoot }),
  };
});

await add("clears matching notification messages and inbox entries", "clear", (projectRoot, runtimeExchangePath) => {
  const cleared = notifications.clearNotifications({ projectRoot, ids: ["record-1", "record-2"] });
  const exchange = exchangeStore.createRuntimeExchangeStore(runtimeExchangePath).read();
  return {
    cleared,
    messages: exchange.messages,
    snapshot: notifications.listNotificationSnapshot({ projectRoot }),
    includeCleared: notifications.listNotificationSnapshot({ projectRoot, includeCleared: true }),
  };
});

await add("counts unread notifications by session", "unread-count", (projectRoot) => ({
  all: notifications.unreadNotificationCount({ projectRoot }),
  codex1: notifications.unreadNotificationCount({ projectRoot, sessionId: "codex-1" }),
  codex2: notifications.unreadNotificationCount({ projectRoot, sessionId: "codex-2" }),
}));

await add(
  "adds unread notifications and records runtime-exchange side effects",
  "add-notifications",
  (projectRoot, runtimeExchangePath) => {
    const first = notifications.addNotification({
      title: "Build done",
      body: "All tests passed",
      sessionId: "claude-1",
      kind: "task_done",
      projectRoot,
    });
    const second = notifications.addNotification({
      title: "Need input",
      body: "Approve migration",
      sessionId: "claude-2",
      kind: "needs_input",
      projectRoot,
    });
    return {
      first,
      second,
      snapshot: notifications.listNotificationSnapshot({ projectRoot, includeCleared: true }),
      exchange: exchangeStore.createRuntimeExchangeStore(runtimeExchangePath).read(),
    };
  },
  { seed: false, dynamic: true },
);

await add(
  "upserts user-facing notifications by session target",
  "upsert-session-target",
  (projectRoot, runtimeExchangePath) => {
    const first = notifications.upsertNotification({
      title: "codex needs input",
      body: "approve command",
      sessionId: "codex-1",
      kind: "needs_input",
      projectRoot,
    });
    const second = notifications.upsertNotification({
      title: "codex finished",
      body: "done",
      sessionId: "codex-1",
      kind: "task_done",
      projectRoot,
    });
    return {
      first,
      second,
      snapshot: notifications.listNotificationSnapshot({ projectRoot, includeCleared: true, sessionId: "codex-1" }),
      exchange: exchangeStore.createRuntimeExchangeStore(runtimeExchangePath).read(),
    };
  },
  { seed: false, dynamic: true },
);

await add(
  "records directly focused-session alerts without marking them unread",
  "focused-alert",
  (projectRoot, runtimeExchangePath) => {
    notificationContext.updateNotificationContext(
      "tui",
      {
        focused: true,
        sessionId: "codex-1",
        screen: "agent",
      },
      projectRoot,
    );
    const bus = new projectEvents.ProjectEventBus();
    const events = [];
    const unsubscribe = bus.subscribe((event) => events.push(event));
    const published = bus.publishAlert({
      kind: "needs_input",
      sessionId: "codex-1",
      title: "codex needs input",
      message: "ready",
      projectName: "aimux",
      projectRoot,
      worktreeName: "notifications",
      worktreePath: join(projectRoot, ".aimux/worktrees/notifications"),
      branch: "notifications",
      categoryLabel: "Needs input",
      reasonLabel: "Agent is waiting for input",
    });
    unsubscribe();
    return {
      published,
      events,
      contexts: notificationContext.loadNotificationContexts(projectRoot),
      unreadCount: notifications.unreadNotificationCount({ projectRoot, sessionId: "codex-1" }),
      snapshot: notifications.listNotificationSnapshot({ projectRoot, includeCleared: true, sessionId: "codex-1" }),
      exchange: exchangeStore.createRuntimeExchangeStore(runtimeExchangePath).read(),
    };
  },
  { seed: false, dynamic: true },
);

await add(
  "includes durable notification ids on live alert events",
  "live-alert-event-id",
  (projectRoot, runtimeExchangePath) => {
    const bus = new projectEvents.ProjectEventBus();
    const events = [];
    const unsubscribe = bus.subscribe((event) => events.push(event));
    const published = bus.publishAlert({
      kind: "needs_input",
      sessionId: "codex-1",
      title: "codex needs input",
      message: "ready",
      projectName: "aimux",
      projectRoot,
      worktreeName: "notifications",
      worktreePath: join(projectRoot, ".aimux/worktrees/notifications"),
      branch: "notifications",
      categoryLabel: "Needs input",
      reasonLabel: "Agent is waiting for input",
    });
    unsubscribe();
    return {
      published,
      events,
      record: notifications.listNotifications({ projectRoot, includeCleared: true, sessionId: "codex-1" })[0],
      exchange: exchangeStore.createRuntimeExchangeStore(runtimeExchangePath).read(),
    };
  },
  { seed: false, dynamic: true },
);

await add(
  "publishes project-update invalidation after live alert events",
  "alert-project-update",
  (projectRoot, runtimeExchangePath) => {
    const bus = new projectEvents.ProjectEventBus();
    const events = [];
    const unsubscribe = bus.subscribe((event) => events.push(event));
    const published = bus.publishAlert({
      kind: "message_waiting",
      sessionId: "codex-1",
      title: "Message waiting",
      message: "Please review",
    });
    unsubscribe();
    return {
      published,
      events,
      exchange: exchangeStore.createRuntimeExchangeStore(runtimeExchangePath).read(),
    };
  },
  { seed: false, dynamic: true },
);

await add(
  "records every alert source as its own session notification",
  "multiple-alert-sources",
  (projectRoot, runtimeExchangePath) => {
    const bus = new projectEvents.ProjectEventBus();
    bus.publishAlert({
      kind: "needs_input",
      sessionId: "claude-1",
      title: "claude-1 needs input",
      message: "from hook",
    });
    bus.publishAlert({
      kind: "notification",
      sessionId: "claude-1",
      title: "Claude Code",
      message: "from terminal notification",
    });
    return {
      notifications: notifications.listNotifications({ projectRoot, includeCleared: true, sessionId: "claude-1" }),
      exchange: exchangeStore.createRuntimeExchangeStore(runtimeExchangePath).read(),
    };
  },
  { seed: false, dynamic: true },
);

await add(
  "preserves repeated dedupe keys and interaction metadata from alert events",
  "dedupe-and-interaction-alerts",
  (projectRoot, runtimeExchangePath) => {
    const bus = new projectEvents.ProjectEventBus();
    bus.publishAlert({
      kind: "needs_input",
      sessionId: "claude-1",
      title: "claude-1 needs input",
      message: "first",
      dedupeKey: "needs_input:claude-1",
      cooldownMs: 60_000,
    });
    bus.publishAlert({
      kind: "needs_input",
      sessionId: "claude-1",
      title: "claude-1 needs input",
      message: "second",
      dedupeKey: "needs_input:claude-1",
      cooldownMs: 60_000,
    });
    bus.publishAlert({
      kind: "interaction_request",
      sessionId: "claude-1",
      title: "claude-1 needs a response",
      message: "Approve command",
      interaction: {
        id: "interaction-1",
        type: "permission",
        summary: "Bash: yarn test",
        telemetry: true,
        toolName: "Bash",
        toolInputJSON: '{"command":"yarn test"}',
      },
    });
    return {
      notifications: notifications.listNotifications({ projectRoot, includeCleared: true, sessionId: "claude-1" }),
      exchange: exchangeStore.createRuntimeExchangeStore(runtimeExchangePath).read(),
    };
  },
  { seed: false, dynamic: true },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/notifications.test.ts",
  generatedBy: "scripts/capture-notifications-store-contract.mjs",
  description:
    "Notification store listing, filtering, unread counts, mark-read, clear, add/upsert, live alert, and runtime-exchange side-effect contracts captured by running TypeScript notifications helpers.",
  normalization: {
    ids: "Generated notification, notification-record, UUID, and message-derived IDs are replaced with <id:n> in first-appearance order for dynamic cases.",
    timestamps: "ISO timestamps are replaced with <ts> for dynamic cases after per-object monotonicity checks.",
    projectRoots: "Temporary project roots are replaced with <root>.",
    projectIds: "Temporary root-derived project IDs are replaced with <project-id>.",
  },
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
