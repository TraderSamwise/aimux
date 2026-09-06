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
const exchangeStore = await import(new URL("dist/runtime-core/exchange-store.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function normalize(value, base) {
  const roots = [base];
  try {
    const canonical = realpathSync(base);
    if (canonical !== base) roots.push(canonical);
  } catch {
    // Temporary directory may be gone.
  }
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return roots.reduce((text, root) => text.replaceAll(root, "<root>"), nested);
    }),
  );
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

async function withProject(label, fn) {
  const base = mkdtempSync(join(tmpdir(), `aimux-notifications-store-contract-${label}-`));
  try {
    const projectRoot = join(base, "repo");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    await paths.initPaths(projectRoot);
    const runtimeExchangePath = paths.getReadOnlyProjectPathsFor(projectRoot).runtimeExchangePath;
    exchangeStore.createRuntimeExchangeStore(runtimeExchangePath).write(seedExchange());
    return normalize(await fn(projectRoot, runtimeExchangePath), base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const cases = [];
const add = async (name, scenario, fn) => {
  const input = { scenario };
  cases.push({
    id: `notifications-store-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/notifications.test.ts, native/crates/aimux/tests/project_service_notifications.rs",
    input,
    output: await withProject(scenario, fn),
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

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/notifications.test.ts",
  generatedBy: "scripts/capture-notifications-store-contract.mjs",
  description: "Notification store listing, filtering, unread counts, mark-read, and clear contracts captured by running TypeScript notifications helpers over a seeded runtime exchange.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
