#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/notifications/inbox-cleanup-runtime.json", ROOT);

const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { addNotification, listNotificationSnapshot, markNotificationsRead } = await import(
  new URL("dist/notifications.js", ROOT)
);
const { persistenceMethods } = await import(new URL("dist/multiplexer/persistence-methods.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function makeNormalizer(preservedStrings = new Set()) {
  const ids = new Map();
  const timestamps = new Map();
  const nextId = (value) => {
    if (!ids.has(value)) ids.set(value, `<id:${ids.size + 1}>`);
    return ids.get(value);
  };
  const nextTimestamp = (value) => {
    if (!timestamps.has(value)) timestamps.set(value, `<ts:${timestamps.size + 1}>`);
    return timestamps.get(value);
  };
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  function normalize(value) {
    if (typeof value === "string") {
      if (preservedStrings.has(value)) return value;
      if (uuidLike.test(value)) return nextId(value);
      if (isoTimestamp.test(value)) return nextTimestamp(value);
      return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, (id) =>
        nextId(id),
      );
    }
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
    }
    return value;
  }

  return normalize;
}

function cleanupInboxHost(overrides = {}) {
  const calls = {
    isDashboardScreen: [],
    metadataServerNotifyChange: [],
    refreshCoordinationFromService: [],
    renderCurrentDashboardView: [],
  };
  const host = {
    mode: "dashboard",
    dashboardInputEpoch: 0,
    notificationIndex: 0,
    threadEntries: [],
    dashboardTeammatesCache: [],
    getDashboardSessions: () => [],
    getDashboardServices: () => [],
    metadataServer: {
      notifyChange: (...args) => {
        calls.metadataServerNotifyChange.push(args);
      },
    },
    isDashboardScreen: (screen) => {
      calls.isDashboardScreen.push([screen]);
      return overrides.isDashboardScreen ?? true;
    },
    refreshCoordinationFromService: async (...args) => {
      calls.refreshCoordinationFromService.push(args);
      return true;
    },
    renderCurrentDashboardView: (...args) => {
      calls.renderCurrentDashboardView.push(args);
    },
    ...overrides.host,
  };
  return { host, calls };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function withRepo(fn) {
  const repoRoot = await mkdtemp(join(tmpdir(), "aimux-inbox-cleanup-runtime-"));
  await mkdir(join(repoRoot, ".git"), { recursive: true });
  try {
    await initPaths(repoRoot);
    return await fn(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

const scenarios = [
  {
    name: "archives a read+aged notification and refreshes service-backed consumers",
    sourceName: "archives a read+aged notification and refreshes service-backed consumers",
    preserveTimestamps: ["2026-01-01T00:00:00.000Z", "2026-05-18T00:00:00.000Z", "2026-06-01T00:00:00.000Z"],
    setup() {
      const record = addNotification({
        title: "needs input",
        body: "waiting",
        sessionId: "claude-1",
        kind: "needs_input",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      markNotificationsRead({ id: record.id });
      return { record };
    },
    input: { now: "2026-06-01T00:00:00.000Z" },
  },
  {
    name: "does not refresh or notify when nothing is eligible",
    sourceName: "does not refresh or notify when nothing is eligible",
    preserveTimestamps: ["2026-05-18T00:00:00.000Z", "2026-06-01T00:00:00.000Z"],
    setup() {
      const record = addNotification({
        title: "needs input",
        body: "waiting",
        sessionId: "claude-1",
        kind: "needs_input",
      });
      return { record };
    },
    input: { now: "2026-06-01T00:00:00.000Z" },
  },
];

const cases = [];
for (const scenario of scenarios) {
  const raw = await withRepo(async () => {
    const setup = scenario.setup();
    const before = listNotificationSnapshot({ includeCleared: true });
    const { host, calls } = cleanupInboxHost();
    const result = await persistenceMethods.cleanupInbox.call(host, scenario.input);
    await flushMicrotasks();
    const after = listNotificationSnapshot({ includeCleared: true });
    return {
      setup,
      input: scenario.input,
      output: {
        result,
        calls,
        notificationsBefore: before,
        notificationsAfter: after,
      },
    };
  });
  const normalize = makeNormalizer(new Set(scenario.preserveTimestamps));
  const input = normalize(raw.input);
  const output = normalize(raw.output);
  cases.push({
    id: `notifications-inbox-cleanup-runtime-${String(cases.length + 1).padStart(3, "0")}`,
    name: scenario.name,
    source: "src/multiplexer/inbox-cleanup-runtime.test.ts",
    sourceName: scenario.sourceName,
    api: "persistenceMethods.cleanupInbox",
    input,
    output,
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/inbox-cleanup-runtime.test.ts",
  generatedBy: "scripts/capture-inbox-cleanup-runtime-contract.mjs",
  description:
    "Dashboard cleanupInbox runtime side effects captured by running TypeScript persistenceMethods.cleanupInbox.",
  normalization: {
    ids: "UUID-like identifiers are replaced with <id:n> tokens in first-appearance order after TypeScript execution.",
    timestamps:
      "Timestamps not fixed by the test scenario are replaced with <ts:n> tokens in first-appearance order after TypeScript execution.",
  },
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
