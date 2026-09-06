#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/notifications/inbox-cleanup.json", ROOT);
const cleanup = await import(new URL("dist/inbox-cleanup.js", ROOT));

const NOW = "2026-06-19T00:00:00.000Z";
const OLD = "2026-05-01T00:00:00.000Z";
const RECENT = "2026-06-18T00:00:00.000Z";
const CONFIG = { cleanupEnabled: true, retentionDays: 14, cleanupIntervalMs: 86400000, maxSize: 10 };
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const notif = (id, over = {}) => ({
  id,
  title: "title",
  body: "body",
  unread: false,
  cleared: false,
  createdAt: RECENT,
  updatedAt: RECENT,
  ...over,
});
const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `notifications-inbox-cleanup-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/inbox-cleanup.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}
function plan(input) {
  return cleanup.buildInboxCleanupPlan({ ...input, protectedIds: input.protectedIds ? new Set(input.protectedIds) : undefined });
}

for (const [name, input] of [
  [
    "ages out read notifications past retention but never unread ones",
    { now: NOW, config: { ...CONFIG, maxSize: 100 }, notifications: [notif("old-read", { unread: false, createdAt: OLD }), notif("old-unread", { unread: true, createdAt: OLD }), notif("recent-read", { unread: false, createdAt: RECENT })] },
  ],
  [
    "trims overflow beyond maxSize, evicting oldest read first",
    { now: NOW, config: { ...CONFIG, maxSize: 2 }, notifications: ["10", "11", "12", "13", "14"].map((day, index) => notif(`r${index + 1}`, { createdAt: `2026-06-${day}T00:00:00.000Z` })) },
  ],
  [
    "never evicts a protected unread actionable row even when over cap",
    { now: NOW, config: { ...CONFIG, maxSize: 1 }, notifications: [notif("u1", { unread: true }), notif("r1", { unread: false }), notif("r2", { unread: false })], protectedIds: ["u1"] },
  ],
  ["keeps a protected row even when maxSize is 0", { now: NOW, config: { ...CONFIG, maxSize: 0 }, notifications: [notif("u1", { unread: true })] }],
  [
    "defaults to protecting every unread notification",
    { now: NOW, config: { ...CONFIG, maxSize: 0 }, notifications: [notif("u1", { unread: true }), notif("r1", { unread: false })] },
  ],
  [
    "returns no targets when cleanup is disabled",
    { now: NOW, config: { ...CONFIG, cleanupEnabled: false, maxSize: 0 }, notifications: [notif("r1", { unread: false })] },
  ],
]) {
  record(name, "buildInboxCleanupPlan", input, plan(input));
}

const runPlanInput = {
  now: NOW,
  config: { ...CONFIG, maxSize: 0 },
  notifications: [notif("r1", { unread: false })],
  protectedIds: [],
};
const runPlan = plan(runPlanInput);
record("runInboxCleanup does not clear on dry run", "runInboxCleanup", { plan: runPlan, dryRun: true, clearResults: { r1: 1 } }, cleanup.runInboxCleanup(runPlan, { clear: () => 1 }, { dryRun: true }));
record("runInboxCleanup clears targets and reports failures", "runInboxCleanup", { plan: runPlan, dryRun: false, clearResults: { r1: 1 }, missResults: { r1: 0 } }, { ok: cleanup.runInboxCleanup(runPlan, { clear: () => 1 }), miss: cleanup.runInboxCleanup(runPlan, { clear: () => 0 }) });

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/inbox-cleanup.test.ts",
  generatedBy: "scripts/capture-inbox-cleanup-contract.mjs",
  description: "Notification inbox cleanup planning and execution contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
