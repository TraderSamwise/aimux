#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const BUDGET_PATH = new URL("testdata/contracts/v1/event-loop/budget.json", ROOT);
const METRICS_PATH = new URL("testdata/contracts/v1/event-loop/metrics.json", ROOT);
const budget = await import(new URL("dist/event-loop-budget.js", ROOT));
const metrics = await import(new URL("dist/event-loop-metrics.js", ROOT));

const {
  MAX_LOOP_DELAY_P99_MS,
  MAX_SYNC_SHARE_PCT,
  MIN_SYNC_CALLS,
  MIN_WINDOW_MS,
  assessLoopBudget,
} = budget;
const { getEventLoopDelay, startEventLoopMonitor, stopEventLoopMonitor } = metrics;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const healthy = (over = {}) => ({
  windowMs: 60_000,
  eventLoop: { p50: 5, p90: 20, p99: 40, max: 120, mean: 8, monitoring: true },
  tmuxExec: {
    sync: { count: 200, totalMs: 300, maxMs: 12 },
    async: { count: 500, totalMs: 4_000, maxMs: 60 },
    syncByVerb: { "list-windows": { count: 200, totalMs: 300, maxMs: 12 } },
    syncByCaller: {},
  },
  ...over,
});

const budgetCases = [];
function recordBudget(name, input) {
  budgetCases.push({
    id: `event-loop-budget-${String(budgetCases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/event-loop-budget.test.ts",
    api: "assessLoopBudget",
    input,
    output: assessLoopBudget(input),
    inputSha256: hash(input),
  });
}

recordBudget("passes a daemon that stays answerable", healthy());
recordBudget("fails the real 66.8s sample this gate was written against", {
  windowMs: 66_800,
  eventLoop: { p50: 41.22, p90: 81.92, p99: 856.16, max: 3527.41, mean: 0, monitoring: true },
  tmuxExec: {
    sync: { count: 759, totalMs: 6582, maxMs: 21 },
    async: { count: 0, totalMs: 0, maxMs: 0 },
    syncByVerb: { "list-windows": { count: 315, totalMs: 2837, maxMs: 12 } },
    syncByCaller: {},
  },
});
recordBudget(
  "reports a too-small sample as its own outcome, never as a pass",
  healthy({
    windowMs: 200,
    tmuxExec: {
      sync: { count: 1, totalMs: 1, maxMs: 1 },
      async: { count: 0, totalMs: 0, maxMs: 0 },
      syncByVerb: {},
      syncByCaller: {},
    },
  }),
);
recordBudget(
  "treats an unstarted monitor as unknown rather than healthy",
  healthy({ eventLoop: { p50: 0, p90: 0, p99: 0, max: 0, mean: 0, monitoring: false } }),
);
recordBudget(
  "puts the sync-share boundary on the stated side of the threshold",
  healthy({
    windowMs: 100_000,
    tmuxExec: {
      sync: { count: 100, totalMs: MAX_SYNC_SHARE_PCT * 1_000, maxMs: 5 },
      async: { count: 0, totalMs: 0, maxMs: 0 },
      syncByVerb: {},
      syncByCaller: {},
    },
  }),
);
recordBudget(
  "puts the loop-delay boundary on the stated side of the threshold",
  healthy({ eventLoop: { p50: 5, p90: 20, p99: MAX_LOOP_DELAY_P99_MS, max: 300, mean: 8, monitoring: true } }),
);
recordBudget("compares the raw share, not the rounded one", {
  windowMs: 100_000,
  eventLoop: { p50: 1, p90: 2, p99: 3, max: 4, mean: 1, monitoring: true },
  tmuxExec: {
    sync: { count: 100, totalMs: 2_004, maxMs: 5 },
    async: { count: 0, totalMs: 0, maxMs: 0 },
    syncByVerb: {},
    syncByCaller: {},
  },
});
recordBudget("names every reason it failed, not just the first", {
  windowMs: MIN_WINDOW_MS - 1,
  eventLoop: { p50: 0, p90: 0, p99: 9_999, max: 9_999, mean: 0, monitoring: false },
  tmuxExec: {
    sync: { count: MIN_SYNC_CALLS - 1, totalMs: 9_000, maxMs: 900 },
    async: { count: 0, totalMs: 0, maxMs: 0 },
    syncByVerb: {},
    syncByCaller: {},
  },
});

function delayShape(delay) {
  return {
    monitoring: delay.monitoring,
    p50LeP99: delay.p50 <= delay.p99,
    p99LeMax: delay.p99 <= delay.max,
    maxPlausibleMilliseconds: delay.max >= 0 && delay.max < 60_000,
    values: delay,
  };
}

const metricCases = [];
function recordMetric(name, action, output) {
  const input = { action };
  metricCases.push({
    id: `event-loop-metrics-${String(metricCases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/event-loop-metrics.test.ts",
    api: action,
    input,
    output,
    inputSha256: hash(input),
  });
}

stopEventLoopMonitor();
recordMetric("reports not-monitoring rather than a healthy-looking zero", "getEventLoopDelayBeforeStart", getEventLoopDelay());
startEventLoopMonitor();
startEventLoopMonitor();
recordMetric("is idempotent, so repeated starts do not stack samplers", "startEventLoopMonitorTwice", delayShape(getEventLoopDelay()));
stopEventLoopMonitor();
recordMetric("stops cleanly and reports not-monitoring again", "stopEventLoopMonitor", getEventLoopDelay());

await writeContractJson(BUDGET_PATH, {
  version: 1,
  source: "src/event-loop-budget.test.ts",
  generatedBy: "scripts/capture-event-loop-contract.mjs",
  description: "Event-loop budget assessment thresholds, rounding, insufficient-sample, unstarted-monitor, and multi-reason contracts captured by running TypeScript.",
  constants: { MAX_SYNC_SHARE_PCT, MAX_LOOP_DELAY_P99_MS, MIN_WINDOW_MS, MIN_SYNC_CALLS },
  cases: budgetCases,
});
await writeContractJson(METRICS_PATH, {
  version: 1,
  source: "src/event-loop-metrics.test.ts",
  generatedBy: "scripts/capture-event-loop-contract.mjs",
  description: "Event-loop monitor start/stop/not-monitoring observations captured by running TypeScript.",
  cases: metricCases,
});
console.log(`${BUDGET_PATH.pathname}: ${budgetCases.length} cases`);
console.log(`${METRICS_PATH.pathname}: ${metricCases.length} cases`);
