#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const HISTORY_FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/guard-repair-history.json", ROOT);
const DRIFT_FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/drift.json", ROOT);
const history = await import(new URL("dist/runtime-guard-repair-history.js", ROOT));
const drift = await import(new URL("dist/runtime-drift.js", ROOT));
const {
  clearRuntimeGuardRepairAttempts,
  loadRuntimeGuardRepairAttempts,
  recordRuntimeGuardRepairAttempt,
  runtimeGuardRepairHistoryPath,
} = history;
const { isAimuxBuildDriftError } = drift;

const WINDOW = 120_000;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
function record(cases, prefix, source, name, api, input, output) {
  cases.push({
    id: `${prefix}-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}
function withHome(callback) {
  const previousHome = process.env.AIMUX_HOME;
  const home = mkdtempSync(join(tmpdir(), "aimux-guard-history-contract-"));
  process.env.AIMUX_HOME = home;
  try {
    return callback(home);
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

const historyCases = [];
record(historyCases, "runtime-state-guard-repair-history", "src/runtime-guard-repair-history.test.ts", "survives the process that recorded it, which is the entire point", "recordAndLoad", { projectRoot: "/p", windowMs: WINDOW, attempts: [1000, 2000], loadNow: 2000 }, withHome(() => {
  recordRuntimeGuardRepairAttempt("/p", WINDOW, 1000);
  recordRuntimeGuardRepairAttempt("/p", WINDOW, 2000);
  return loadRuntimeGuardRepairAttempts("/p", WINDOW, 2000);
}));
record(historyCases, "runtime-state-guard-repair-history", "src/runtime-guard-repair-history.test.ts", "counts up to a limit rather than resetting", "recordAndCount", { projectRoot: "/p", windowMs: WINDOW, attempts: [1, 2, 3, 4, 5], loadNow: 5 }, withHome(() => {
  for (const at of [1, 2, 3, 4, 5]) recordRuntimeGuardRepairAttempt("/p", WINDOW, at);
  return { count: loadRuntimeGuardRepairAttempts("/p", WINDOW, 5).length };
}));
record(historyCases, "runtime-state-guard-repair-history", "src/runtime-guard-repair-history.test.ts", "forgets attempts older than the window", "pruneWindow", { projectRoot: "/p", windowMs: WINDOW, attempts: [1_000_000 - WINDOW - 1, 1_000_000], loadNow: 1_000_000 }, withHome(() => {
  recordRuntimeGuardRepairAttempt("/p", WINDOW, 1_000_000 - WINDOW - 1);
  recordRuntimeGuardRepairAttempt("/p", WINDOW, 1_000_000);
  return loadRuntimeGuardRepairAttempts("/p", WINDOW, 1_000_000);
}));
record(historyCases, "runtime-state-guard-repair-history", "src/runtime-guard-repair-history.test.ts", "keeps projects separate, so one flapping project does not spend another's budget", "separateProjects", { windowMs: WINDOW, records: [["/a", 1000], ["/a", 2000], ["/b", 3000]], loadNow: 3000 }, withHome(() => {
  recordRuntimeGuardRepairAttempt("/a", WINDOW, 1000);
  recordRuntimeGuardRepairAttempt("/a", WINDOW, 2000);
  recordRuntimeGuardRepairAttempt("/b", WINDOW, 3000);
  return {
    a: loadRuntimeGuardRepairAttempts("/a", WINDOW, 3000),
    b: loadRuntimeGuardRepairAttempts("/b", WINDOW, 3000),
  };
}));
record(historyCases, "runtime-state-guard-repair-history", "src/runtime-guard-repair-history.test.ts", "normalizes the key, so the same project by another spelling is the same project", "normalizeProjectKey", { recordRoot: "/p/../p", loadRoot: "/p", windowMs: WINDOW, now: 1000 }, withHome(() => {
  recordRuntimeGuardRepairAttempt("/p/../p", WINDOW, 1000);
  return loadRuntimeGuardRepairAttempts("/p", WINDOW, 1000);
}));
record(historyCases, "runtime-state-guard-repair-history", "src/runtime-guard-repair-history.test.ts", "clears on request, so a settled project starts from zero", "clear", { projectRoot: "/p", windowMs: WINDOW, now: 1000 }, withHome(() => {
  recordRuntimeGuardRepairAttempt("/p", WINDOW, 1000);
  clearRuntimeGuardRepairAttempts("/p");
  return loadRuntimeGuardRepairAttempts("/p", WINDOW, 1000);
}));
record(historyCases, "runtime-state-guard-repair-history", "src/runtime-guard-repair-history.test.ts", "treats unreadable history as empty rather than blocking repair", "corruptHistory", { projectRoot: "/p", windowMs: WINDOW, now: 1000, fileText: "{ not json" }, withHome(() => {
  const path = runtimeGuardRepairHistoryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{ not json");
  const before = loadRuntimeGuardRepairAttempts("/p", WINDOW, 1000);
  let recordOk = true;
  try {
    recordRuntimeGuardRepairAttempt("/p", WINDOW, 1000);
  } catch {
    recordOk = false;
  }
  return { before, recordOk, after: loadRuntimeGuardRepairAttempts("/p", WINDOW, 1000) };
}));
record(historyCases, "runtime-state-guard-repair-history", "src/runtime-guard-repair-history.test.ts", "reaches the limit across processes, which the in-memory counter never could", "limitProgression", { projectRoot: "/p", windowMs: WINDOW, limit: 5, attempts: [1000, 2000, 3000, 4000, 5000] }, withHome(() => {
  const beforeCounts = [];
  for (const at of [1000, 2000, 3000, 4000, 5000]) {
    beforeCounts.push(loadRuntimeGuardRepairAttempts("/p", WINDOW, at).length);
    recordRuntimeGuardRepairAttempt("/p", WINDOW, at);
  }
  return { beforeCounts, finalCount: loadRuntimeGuardRepairAttempts("/p", WINDOW, 5000).length };
}));
record(historyCases, "runtime-state-guard-repair-history", "src/runtime-guard-repair-history.test.ts", "does not grow without bound as projects come and go", "pruneOtherProjects", { windowMs: WINDOW, records: [["/gone", 5_000_000 - WINDOW - 1], ["/live", 5_000_000]], loadNow: 5_000_000 }, withHome(() => {
  recordRuntimeGuardRepairAttempt("/gone", WINDOW, 5_000_000 - WINDOW - 1);
  recordRuntimeGuardRepairAttempt("/live", WINDOW, 5_000_000);
  const stored = JSON.parse(readFileSync(runtimeGuardRepairHistoryPath(), "utf-8"));
  return {
    gone: loadRuntimeGuardRepairAttempts("/gone", WINDOW, 5_000_000),
    storedKeys: Object.keys(stored).sort(),
  };
}));

const driftCases = [];
for (const [name, input] of [
  ["matches daemon local build drift errors", { errorMessage: "aimux daemon on default port is from a different local build" }],
  ["matches project service local build drift errors", { errorMessage: "the running project service is from a different local build" }],
  ["ignores unrelated daemon readiness failures", { errorMessage: "aimux daemon is not running" }],
  ["ignores non-error drift text", { value: "different local build" }],
]) {
  const value = input.errorMessage ? new Error(input.errorMessage) : input.value;
  record(driftCases, "runtime-state-drift", "src/runtime-drift.test.ts", name, "isAimuxBuildDriftError", input, isAimuxBuildDriftError(value));
}

await writeContractJson(HISTORY_FIXTURE_PATH, {
  version: 1,
  source: "src/runtime-guard-repair-history.test.ts",
  generatedBy: "scripts/capture-runtime-guard-repair-contract.mjs",
  description: "Runtime guard repair attempt persistence, pruning, project-key normalization, and corrupt-history behavior captured by running TypeScript.",
  cases: historyCases,
});
await writeContractJson(DRIFT_FIXTURE_PATH, {
  version: 1,
  source: "src/runtime-drift.test.ts",
  generatedBy: "scripts/capture-runtime-guard-repair-contract.mjs",
  description: "Aimux local-build drift error classification captured by running TypeScript.",
  cases: driftCases,
});
console.log(`${HISTORY_FIXTURE_PATH.pathname}: ${historyCases.length} cases`);
console.log(`${DRIFT_FIXTURE_PATH.pathname}: ${driftCases.length} cases`);
