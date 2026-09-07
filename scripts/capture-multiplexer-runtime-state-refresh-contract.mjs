#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/runtime-state-refresh.json", ROOT);
const FIXED_NOW_MS = Date.parse("2026-06-01T00:00:00.000Z");
const RealDate = Date;
let nowMs = FIXED_NOW_MS;
let nextIntervalId = 1;
const intervals = new Map();

globalThis.Date = class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(nowMs);
    return new RealDate(...args);
  }

  static now() {
    return nowMs;
  }

  static parse(value) {
    return RealDate.parse(value);
  }

  static UTC(...args) {
    return RealDate.UTC(...args);
  }
};

globalThis.setInterval = (fn, intervalMs, ...args) => {
  const id = nextIntervalId++;
  intervals.set(id, { fn, intervalMs, args });
  return id;
};
globalThis.clearInterval = (id) => {
  intervals.delete(id);
};

const { DASHBOARD_HIDDEN_VISIBILITY_RECHECK_TICKS, startStatusRefresh, stopStatusRefresh } = await import(
  new URL("dist/multiplexer/runtime-state.js", ROOT)
);

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function callLog(calls, name, impl = () => undefined) {
  return (...args) => {
    calls[name].push(clone(args));
    return impl(...args);
  };
}

function hostFor(input) {
  const calls = {
    dashboardFeedbackTickFlashVisibilityChanged: [],
    publishAlert: [],
    refreshDashboardModelFromService: [],
    refreshCoordinationFromService: [],
    renderCurrentDashboardView: [],
    isDashboardScreen: [],
    isDashboardTuiVisible: [],
    invalidateDashboardFrame: [],
  };
  const visibilitySequence = [...(input.visibilitySequence ?? [])];
  const refreshSteps = [...(input.refreshSteps ?? [])];
  const deferredRefreshes = new Map();
  const host = {
    projectRoot: "/repo",
    statusInterval: null,
    sessions: clone(input.sessions ?? []),
    prevStatuses: new Map(input.prevStatuses ?? []),
    mode: input.mode ?? "agent",
    dashboardInputEpoch: input.dashboardInputEpoch ?? 0,
    dashboardFeedback: {
      tickFlashVisibilityChanged: callLog(
        calls,
        "dashboardFeedbackTickFlashVisibilityChanged",
        () => input.feedbackChanged === true,
      ),
    },
    publishAlert: callLog(calls, "publishAlert"),
    dashboardNextBackgroundRefreshAt: input.dashboardNextBackgroundRefreshAt ?? 0,
    dashboardStartupPriming: input.dashboardStartupPriming,
    dashboardTuiVisibility: clone(input.dashboardTuiVisibility),
    dashboardTuiVisibilityCheckedAt: input.dashboardTuiVisibilityCheckedAt,
    dashboardHiddenVisibilitySkipTicks: input.dashboardHiddenVisibilitySkipTicks,
    dashboardTuiVisibilityWakePending: input.dashboardTuiVisibilityWakePending,
    startedInDashboard: input.startedInDashboard,
    isDashboardTuiVisible: callLog(calls, "isDashboardTuiVisible", () =>
      visibilitySequence.length > 0 ? visibilitySequence.shift() : true,
    ),
    isDashboardScreen: callLog(calls, "isDashboardScreen", (screen) => screen === (input.screen ?? "coordination")),
    refreshDashboardModelFromService: callLog(calls, "refreshDashboardModelFromService", () => {
      const step = refreshSteps.length > 0 ? refreshSteps.shift() : { type: "resolve", value: true };
      if (step.type === "pending") return new Promise(() => undefined);
      if (step.type === "defer") {
        return new Promise((resolve) => {
          deferredRefreshes.set(step.key ?? "default", resolve);
        });
      }
      if (step.type === "reject") return Promise.reject(new Error(step.message));
      return Promise.resolve(step.value);
    }),
    refreshCoordinationFromService: callLog(calls, "refreshCoordinationFromService", () => Promise.resolve(true)),
    renderCurrentDashboardView: callLog(calls, "renderCurrentDashboardView"),
    invalidateDashboardFrame: callLog(calls, "invalidateDashboardFrame"),
  };
  return { host, calls, deferredRefreshes };
}

async function tick(ms) {
  nowMs += ms;
  for (const entry of [...intervals.values()]) {
    entry.fn(...entry.args);
  }
  await flushAsyncWork();
}

function snapshot(host, calls) {
  return {
    statusIntervalActive: host.statusInterval !== null,
    sessions: host.sessions,
    prevStatuses: [...host.prevStatuses.entries()],
    mode: host.mode,
    dashboardInputEpoch: host.dashboardInputEpoch,
    dashboardNextBackgroundRefreshAt: host.dashboardNextBackgroundRefreshAt,
    dashboardHiddenVisibilitySkipTicks: host.dashboardHiddenVisibilitySkipTicks ?? null,
    dashboardTuiVisibility: host.dashboardTuiVisibility ?? null,
    dashboardTuiVisibilityWakePending: host.dashboardTuiVisibilityWakePending ?? null,
    calls,
  };
}

async function run(input) {
  nowMs = FIXED_NOW_MS;
  intervals.clear();
  const { host, calls, deferredRefreshes } = hostFor(input.host ?? {});
  startStatusRefresh(host);
  for (const step of input.steps ?? []) {
    if (step.type === "tick") await tick(step.ms);
    if (step.type === "setSessionStatus") {
      const session = host.sessions.find((item) => item.id === step.sessionId);
      if (session) session.status = step.status;
    }
    if (step.type === "setMode") host.mode = step.mode;
    if (step.type === "setInputEpoch") host.dashboardInputEpoch = step.value;
    if (step.type === "resolveRefresh") {
      const resolve = deferredRefreshes.get(step.key ?? "default");
      if (!resolve) throw new Error(`missing deferred refresh ${step.key ?? "default"}`);
      deferredRefreshes.delete(step.key ?? "default");
      resolve(step.value);
      await flushAsyncWork();
    }
  }
  if (input.stop !== false) stopStatusRefresh(host);
  return snapshot(host, calls);
}

const casesInput = [
  {
    name: "does not notify immediately when an agent briefly becomes idle",
    host: {
      sessions: [{ id: "codex-1", status: "idle" }],
      prevStatuses: [["codex-1", "running"]],
    },
    steps: [{ type: "tick", ms: 1000 }],
  },
  {
    name: "notifies when an agent stays idle after finishing a turn",
    host: {
      sessions: [{ id: "codex-1", status: "idle" }],
      prevStatuses: [["codex-1", "running"]],
    },
    steps: [
      { type: "tick", ms: 1000 },
      { type: "tick", ms: 10000 },
    ],
  },
  {
    name: "cancels idle notification when the agent resumes work before settling",
    host: {
      sessions: [{ id: "codex-1", status: "idle" }],
      prevStatuses: [["codex-1", "running"]],
    },
    steps: [
      { type: "tick", ms: 5000 },
      { type: "setSessionStatus", sessionId: "codex-1", status: "running" },
      { type: "tick", ms: 1000 },
      { type: "setSessionStatus", sessionId: "codex-1", status: "idle" },
      { type: "tick", ms: 5000 },
    ],
  },
  {
    name: "does not render an in-flight background dashboard refresh after leaving dashboard mode",
    host: {
      mode: "dashboard",
      dashboardNextBackgroundRefreshAt: 0,
      refreshSteps: [{ type: "defer", key: "refresh" }],
    },
    steps: [
      { type: "tick", ms: 1000 },
      { type: "setMode", mode: "session" },
      { type: "resolveRefresh", key: "refresh", value: true },
    ],
  },
  {
    name: "does not render an in-flight background dashboard refresh after input changes",
    host: {
      mode: "dashboard",
      dashboardInputEpoch: 1,
      dashboardNextBackgroundRefreshAt: 0,
      refreshSteps: [{ type: "defer", key: "refresh" }],
    },
    steps: [
      { type: "tick", ms: 1000 },
      { type: "setInputEpoch", value: 2 },
      { type: "resolveRefresh", key: "refresh", value: true },
    ],
  },
  {
    name: "renders heartbeat-only dashboard feedback without waiting for background refresh",
    host: {
      mode: "dashboard",
      feedbackChanged: true,
      dashboardNextBackgroundRefreshAt: 0,
      refreshSteps: [{ type: "pending" }],
    },
    steps: [{ type: "tick", ms: 1000 }],
  },
  {
    name: "does not run dashboard background API refresh while startup is priming",
    host: {
      mode: "dashboard",
      feedbackChanged: true,
      dashboardStartupPriming: true,
      dashboardNextBackgroundRefreshAt: 0,
    },
    steps: [{ type: "tick", ms: 1000 }],
  },
  {
    name: "does not refresh or render hidden tmux dashboards",
    host: {
      mode: "dashboard",
      startedInDashboard: true,
      visibilitySequence: [false],
      dashboardNextBackgroundRefreshAt: 0,
    },
    steps: [{ type: "tick", ms: 1000 }],
  },
  {
    name: "backs off visibility checks for hidden tmux dashboards",
    host: {
      mode: "dashboard",
      startedInDashboard: true,
      dashboardTuiVisibility: {
        attached: true,
        activeWindow: false,
        visible: false,
        reason: "hidden",
      },
      dashboardHiddenVisibilitySkipTicks: 2,
      dashboardNextBackgroundRefreshAt: 0,
    },
    steps: [
      { type: "tick", ms: 1000 },
      { type: "tick", ms: 1000 },
    ],
  },
  {
    name: "forces one dashboard model refresh when a hidden dashboard becomes visible",
    host: {
      mode: "dashboard",
      startedInDashboard: true,
      dashboardTuiVisibility: {
        attached: true,
        activeWindow: false,
        visible: false,
        reason: "hidden",
      },
      dashboardTuiVisibilityWakePending: true,
      visibilitySequence: [true],
      dashboardNextBackgroundRefreshAt: 9999999999999,
      refreshSteps: [{ type: "resolve", value: true }],
    },
    steps: [{ type: "tick", ms: 1000 }],
  },
];

const cases = [];
for (let index = 0; index < casesInput.length; index += 1) {
  const input = { api: "startStatusRefresh", ...casesInput[index] };
  cases.push({
    id: `multiplexer-runtime-state-refresh-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/multiplexer/runtime-state.test.ts",
    api: input.api,
    input,
    output: await run(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/runtime-state.test.ts",
  generatedBy: "scripts/capture-multiplexer-runtime-state-refresh-contract.mjs",
  description:
    "Runtime status refresh idle-alert debounce and dashboard background-refresh lifecycle captured by running TypeScript with a deterministic interval clock.",
  constants: {
    DASHBOARD_HIDDEN_VISIBILITY_RECHECK_TICKS,
  },
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
