#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/exec-metrics.json", ROOT);
const { getTmuxExecMetrics, recordTmuxExec, resetTmuxExecMetrics, tmuxExecVerb } = await import(
  new URL("dist/tmux/exec-metrics.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const cases = [];
function record(name, input, run) {
  resetTmuxExecMetrics();
  const output = run();
  resetTmuxExecMetrics();
  const fullInput = { name, ...input };
  cases.push({
    id: `tmux-exec-metrics-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/exec-metrics.test.ts",
    api: "exec-metrics",
    input: fullInput,
    output,
    inputSha256: hash(fullInput),
  });
}

record("takes the subcommand for attribution", {}, () => ({
  verbs: [tmuxExecVerb(["capture-pane", "-p", "-t", "@1"]), tmuxExecVerb([]), tmuxExecVerb(["   "])],
}));

record("splits sync from async", {}, () => {
  recordTmuxExec(["capture-pane"], 10, "sync");
  recordTmuxExec(["capture-pane"], 90, "async");
  const metrics = getTmuxExecMetrics();
  return {
    sync: metrics.sync,
    async: metrics.async,
    capturePane: metrics.syncByVerb["capture-pane"],
    callerKeys: Object.keys(metrics.syncByCaller).length > 0 ? ["(unknown)"] : [],
  };
});

record("accumulates count total and max per verb", {}, () => {
  recordTmuxExec(["capture-pane"], 5, "sync");
  recordTmuxExec(["capture-pane"], 25, "sync");
  recordTmuxExec(["list-windows"], 3, "sync");
  const metrics = getTmuxExecMetrics();
  return {
    sync: metrics.sync,
    capturePane: metrics.syncByVerb["capture-pane"],
    listWindows: metrics.syncByVerb["list-windows"],
  };
});

record("orders verbs by total time", {}, () => {
  recordTmuxExec(["list-windows"], 1, "sync");
  recordTmuxExec(["capture-pane"], 40, "sync");
  recordTmuxExec(["display-message"], 12, "sync");
  return { keys: Object.keys(getTmuxExecMetrics().syncByVerb) };
});

record("hands out copies", {}, () => {
  recordTmuxExec(["capture-pane"], 10, "sync");
  const first = getTmuxExecMetrics();
  first.sync.totalMs = 9999;
  first.syncByVerb["capture-pane"].count = 9999;
  const second = getTmuxExecMetrics();
  return {
    firstMutated: first.sync,
    secondSync: second.sync,
    secondCapturePane: second.syncByVerb["capture-pane"],
  };
});

record("resets to empty", {}, () => {
  recordTmuxExec(["capture-pane"], 10, "sync");
  resetTmuxExecMetrics();
  const metrics = getTmuxExecMetrics();
  return {
    sync: metrics.sync,
    async: metrics.async,
    syncByVerb: metrics.syncByVerb,
    syncByCaller: {},
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-06T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-exec-metrics-contract.mjs",
  source: "src/tmux/exec-metrics.test.ts",
  subject: "src/tmux/exec-metrics.ts",
  description: "Stable tmux exec metrics behavior captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
