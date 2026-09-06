#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/dashboard-model-service.json", ROOT);
const WORKTREE_ROOT = fileURLToPath(ROOT).replace(/\/$/, "");

const { DashboardPendingActions } = await import(new URL("dist/dashboard/pending-actions.js", ROOT));
const { refreshDashboardModelFromService } = await import(new URL("dist/multiplexer/dashboard-model.js", ROOT));

const FIXED_NOW = 1770000000000;
Date.now = () => FIXED_NOW;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function makeError(input) {
  const error = new Error(input.message);
  if (input.code) error.code = input.code;
  return error;
}

function mock(defaultStep = { value: undefined }) {
  const fn = async (...args) => {
    fn.items.push(args);
    const step = fn.steps.length ? fn.steps.shift() : fn.defaultStep;
    if (step?.throw) throw makeError(step.throw);
    return step?.value;
  };
  fn.items = [];
  fn.steps = [];
  fn.defaultStep = defaultStep;
  return fn;
}

function syncMock(defaultValue) {
  const fn = (...args) => {
    fn.items.push(args);
    return fn.values.length ? fn.values.shift() : defaultValue;
  };
  fn.items = [];
  fn.values = [];
  return fn;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function session(sessionId) {
  return {
    index: 0,
    id: sessionId,
    command: "claude",
    status: "running",
    active: false,
  };
}

function desktopPayload(sessionId) {
  const item = session(sessionId);
  return {
    ok: true,
    sessions: [item],
    teammates: [],
    services: [],
    worktrees: [],
    worktreeGroups: [
      {
        name: "Main Checkout",
        branch: "main",
        status: "active",
        sessions: [item],
        services: [],
      },
    ],
    operationFailures: [],
    mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
  };
}

function invalidDesktopPayload(groups = undefined) {
  const value = {
    ok: true,
    sessions: [],
    teammates: [],
    services: [],
    worktrees: [],
    operationFailures: [],
    mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
  };
  if (groups !== undefined) value.worktreeGroups = groups;
  return value;
}

function hostDouble() {
  const getFromProjectService = mock();
  const refreshRuntimeGuard = mock();
  const orderWorktreeGroups = syncMock(undefined);
  orderWorktreeGroups.values = [];
  const markSelectionDirty = syncMock(undefined);
  const listProjectManagedWindows = syncMock([]);
  const isWindowAlive = syncMock(true);
  const host = {
    mode: "dashboard",
    dashboardModelRefreshedAt: 0,
    getFromProjectService,
    refreshRuntimeGuard,
    dashboardPendingActions: new DashboardPendingActions(() => {}),
    dashboardUiStateStore: {
      orderWorktreeGroups: (groups) => {
        orderWorktreeGroups.items.push([groups]);
        return groups;
      },
      markSelectionDirty,
    },
    tmuxRuntimeManager: {
      listProjectManagedWindows,
      isWindowAlive,
    },
  };
  host.calls = {
    getFromProjectService,
    refreshRuntimeGuard,
    orderWorktreeGroups,
    markSelectionDirty,
    listProjectManagedWindows,
    isWindowAlive,
  };
  return host;
}

async function settleImmediateRecovery() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
}

function normalize(value) {
  if (value instanceof Error) {
    const out = { name: value.name, message: value.message };
    if (value.code) out.code = value.code;
    return out;
  }
  if (typeof value === "string") {
    return value
      .replaceAll(WORKTREE_ROOT, "<repo>")
      .replaceAll(encodeURIComponent(`dashboard:${process.pid}`), "dashboard%3A<pid>")
      .replaceAll(String(process.pid), "<pid>");
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function hostState(host) {
  const state = {};
  for (const key of [
    "dashboardRawSessionsCache",
    "dashboardRawTeammatesCache",
    "dashboardRawServicesCache",
    "dashboardRawWorktreeGroupsCache",
    "dashboardSessionsCache",
    "dashboardTeammatesCache",
    "dashboardServicesCache",
    "dashboardWorktreeGroupsCache",
    "dashboardOperationFailuresCache",
    "dashboardMainCheckoutInfoCache",
    "dashboardModelServiceRefreshedAt",
    "dashboardModelServiceRefreshError",
    "dashboardModelVersion",
    "dashboardRepairNotices",
    "footerFlash",
    "footerFlashTicks",
    "tuiApiRecoveryPending",
    "tuiApiRecoveryFailureStreak",
  ]) {
    if (host[key] !== undefined) state[key] = host[key];
  }
  return normalize(state);
}

function callState(host) {
  return normalize(Object.fromEntries(Object.entries(host.calls).map(([name, fn]) => [name, fn.items])));
}

const cases = [];
async function record(name, input, run) {
  const output = normalize(await run());
  cases.push({
    id: `runtime-state-dashboard-model-service-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/dashboard-model-service.test.ts",
    sourceName: name,
    api: "refreshDashboardModelFromService",
    input,
    output,
    inputSha256: hash(input),
  });
}

await record(
  "applies dashboard worktree groups provided by /desktop-state",
  { force: true, payload: "service-worktree-groups" },
  async () => {
    const host = hostDouble();
    const fresh = session("claude-1");
    const serviceGroup = {
      name: "Main Checkout",
      branch: "main",
      status: "active",
      sessions: [fresh],
      services: [],
    };
    host.getFromProjectService.defaultStep = {
      value: {
        ok: true,
        sessions: [fresh],
        teammates: [],
        services: [],
        worktrees: [{ name: "stale-local-shape", path: "/wrong", branch: "wrong", isBare: false }],
        worktreeGroups: [serviceGroup],
        operationFailures: [],
        mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
      },
    };
    const result = await refreshDashboardModelFromService(host, true);
    return { result, calls: callState(host), host: hostState(host) };
  },
);

await record(
  "can refresh service state for background settlement while inactive",
  { force: true, options: { allowInactive: true }, host: { mode: "session" } },
  async () => {
    const host = hostDouble();
    host.mode = "session";
    host.getFromProjectService.defaultStep = { value: desktopPayload("fresh") };
    const result = await refreshDashboardModelFromService(host, true, { allowInactive: true });
    return { result, calls: callState(host), host: hostState(host) };
  },
);

await record(
  "does not run ordinary service refreshes while inactive",
  { force: true, host: { mode: "session" } },
  async () => {
    const host = hostDouble();
    host.mode = "session";
    const result = await refreshDashboardModelFromService(host, true);
    return { result, calls: callState(host), host: hostState(host) };
  },
);

await record(
  "probes the runtime guard after a successful refresh only when currently guarded",
  { force: true, runtimeGuardState: { kind: "stale", reason: "service-mismatch" } },
  async () => {
    const host = hostDouble();
    host.runtimeGuardState = { kind: "stale", reason: "service-mismatch" };
    host.getFromProjectService.defaultStep = { value: desktopPayload("fresh") };
    const result = await refreshDashboardModelFromService(host, true);
    await settleImmediateRecovery();
    return { result, calls: callState(host), host: hostState(host) };
  },
);

await record(
  "lets forced refreshes supersede an older pending background refresh",
  { background: "stale", forced: "fresh" },
  async () => {
    const host = hostDouble();
    const background = deferred();
    const forced = deferred();
    host.getFromProjectService.steps = [{ value: background.promise }, { value: forced.promise }];
    host.getFromProjectService = (...args) => {
      host.calls.getFromProjectService.items.push(args);
      const step = host.calls.getFromProjectService.steps.shift();
      return step.value;
    };
    const backgroundRefresh = refreshDashboardModelFromService(host, false);
    const forcedRefresh = refreshDashboardModelFromService(host, true);
    forced.resolve(desktopPayload("fresh"));
    const forcedResult = await forcedRefresh;
    background.resolve(desktopPayload("stale"));
    const backgroundResult = await backgroundRefresh;
    return {
      result: { forced: forcedResult, background: backgroundResult },
      calls: callState(host),
      host: hostState(host),
    };
  },
);

await record(
  "does not apply desktop-state when the refresh lifecycle is stale",
  {
    force: true,
    host: { dashboardInputEpoch: 1 },
    options: { lifecycle: { mode: "dashboard", inputEpoch: 0, requiresInputEpoch: true } },
  },
  async () => {
    const host = hostDouble();
    host.dashboardInputEpoch = 1;
    host.getFromProjectService.defaultStep = { value: desktopPayload("stale") };
    const result = await refreshDashboardModelFromService(host, true, {
      lifecycle: { mode: "dashboard", inputEpoch: 0, requiresInputEpoch: true },
    });
    return { result, calls: callState(host), host: hostState(host) };
  },
);

await record(
  "does not report stale invalid desktop-state refreshes",
  {
    force: true,
    host: { dashboardInputEpoch: 1 },
    invalidPayload: "missing-worktree-groups",
    options: { lifecycle: { mode: "dashboard", inputEpoch: 0, requiresInputEpoch: true } },
  },
  async () => {
    const host = hostDouble();
    host.dashboardInputEpoch = 1;
    host.getFromProjectService.defaultStep = { value: invalidDesktopPayload() };
    const result = await refreshDashboardModelFromService(host, true, {
      lifecycle: { mode: "dashboard", inputEpoch: 0, requiresInputEpoch: true },
    });
    return { result, calls: callState(host), host: hostState(host) };
  },
);

await record(
  "rejects desktop-state payloads without service-composed worktree groups",
  { force: false, invalidPayload: "missing-worktree-groups" },
  async () => {
    const host = hostDouble();
    host.getFromProjectService.defaultStep = { value: invalidDesktopPayload() };
    const result = await refreshDashboardModelFromService(host, false);
    return { result, calls: callState(host), host: hostState(host) };
  },
);

await record(
  "probes the runtime guard when a forced refresh receives an invalid payload",
  { force: true, invalidPayload: "missing-worktree-groups" },
  async () => {
    const host = hostDouble();
    host.getFromProjectService.defaultStep = { value: invalidDesktopPayload() };
    const result = await refreshDashboardModelFromService(host, true);
    await settleImmediateRecovery();
    return { result, calls: callState(host), host: hostState(host) };
  },
);

await record(
  "does not apply an empty desktop-state snapshot while tmux still has live agents",
  { force: true, tmuxWindow: "live-agent", payload: "empty-offline-group" },
  async () => {
    const host = hostDouble();
    host.calls.listProjectManagedWindows.values = [
      [
        {
          target: { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "codex" },
          metadata: { kind: "agent", sessionId: "codex-1" },
        },
      ],
    ];
    host.getFromProjectService.defaultStep = {
      value: {
        ...invalidDesktopPayload([
          {
            name: "Main Checkout",
            branch: "main",
            status: "offline",
            sessions: [],
            services: [],
          },
        ]),
      },
    };
    const result = await refreshDashboardModelFromService(host, true);
    await settleImmediateRecovery();
    return { result, calls: callState(host), host: hostState(host) };
  },
);

await record(
  "does not reject an empty desktop-state snapshot for dead tmux agent panes",
  { force: true, tmuxWindow: "dead-agent", payload: "empty-offline-group" },
  async () => {
    const host = hostDouble();
    host.calls.isWindowAlive.values = [false];
    host.calls.listProjectManagedWindows.values = [
      [
        {
          target: { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "codex" },
          metadata: { kind: "agent", sessionId: "codex-1" },
        },
      ],
    ];
    host.getFromProjectService.defaultStep = {
      value: {
        ...invalidDesktopPayload([
          {
            name: "Main Checkout",
            branch: "main",
            status: "offline",
            sessions: [],
            services: [],
          },
        ]),
      },
    };
    const result = await refreshDashboardModelFromService(host, true);
    return { result, calls: callState(host), host: hostState(host) };
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-model-service.test.ts",
  generatedBy: "scripts/capture-dashboard-model-service-contract.mjs",
  description:
    "Dashboard desktop-state model refresh, cache application, lifecycle staleness, invalid payload, and tmux contradiction contracts captured by running TypeScript refreshDashboardModelFromService.",
  normalization: {
    timestamps: `Date.now() is fixed at ${FIXED_NOW} while executing the TypeScript capture.`,
    processIds:
      "The dashboard client id path segment is normalized from the live process id to <pid> after TypeScript execution.",
    errors: "Error objects are serialized as name/message plus stable code fields.",
  },
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
