#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-interaction-navigation.json", ROOT);

const { dashboardInteractionMethods } = await import(new URL("dist/multiplexer/dashboard-interaction.js", ROOT));

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function recorder() {
  const calls = [];
  return {
    calls,
    fn(method, impl) {
      return (...args) => {
        calls.push({ method, args: clone(args) });
        return impl?.(...args);
      };
    },
  };
}

function bufferForKey(key) {
  switch (key) {
    case "enter":
      return Buffer.from("\r");
    case "escape":
      return Buffer.from("\x1b");
    default:
      return Buffer.from(key);
  }
}

function makeHost(input) {
  const rec = recorder();
  const dashboardState = {
    screen: input.screen ?? "dashboard",
    level: input.level ?? "sessions",
    focusedWorktreePath: input.focusedWorktreePath,
    quickJumpDigits: input.quickJumpDigits ?? "",
    hideOfflineAgents: input.hideOfflineAgents ?? false,
    sessionIndex: input.sessionIndex ?? 0,
    worktreeEntries: clone(input.worktreeEntries ?? []),
    worktreeSessions: clone(input.worktreeSessions ?? []),
    worktreeNavOrder: clone(input.worktreeNavOrder ?? []),
    hasWorktrees: () => input.hasWorktrees === true,
  };
  const host = {
    mode: input.mode ?? "dashboard",
    activeIndex: input.activeIndex ?? 0,
    sessions: clone(input.sessions ?? [{ id: "runtime-1" }]),
    dashboardState,
    dashboardSessionsCache: clone(input.dashboardSessionsCache ?? []),
    dashboardServicesCache: clone(input.dashboardServicesCache ?? []),
    dashboardWorktreeGroupsCache: clone(input.dashboardWorktreeGroupsCache ?? []),
    dashboardMainCheckoutInfoCache: clone(input.dashboardMainCheckoutInfoCache ?? { name: "Main Checkout", branch: "master" }),
    dashboardRenderOptions: clone(input.dashboardRenderOptions ?? null),
    dashboardQuickJumpTimeout: input.quickJumpDigits ? { ms: 900 } : null,
    footerFlash: null,
    footerFlashTicks: 0,
    dashboardUiStateStore: {
      markSelectionDirty: rec.fn("dashboardUiStateStore.markSelectionDirty"),
      rememberCurrentEntrySelection: rec.fn("dashboardUiStateStore.rememberCurrentEntrySelection"),
    },
    clearDashboardQuickJump: rec.fn("clearDashboardQuickJump", () =>
      dashboardInteractionMethods.clearDashboardQuickJump.call(host),
    ),
    focusDashboardQuickJumpWorktree: rec.fn("focusDashboardQuickJumpWorktree", (path) =>
      dashboardInteractionMethods.focusDashboardQuickJumpWorktree.call(host, path),
    ),
    focusDashboardQuickJumpEntry: rec.fn("focusDashboardQuickJumpEntry", (path, index, opts) =>
      dashboardInteractionMethods.focusDashboardQuickJumpEntry.call(host, path, index, opts),
    ),
    handleDashboardQuickJumpDigit:
      input.useActualQuickJump === false
        ? rec.fn("handleDashboardQuickJumpDigit", () => false)
        : rec.fn("handleDashboardQuickJumpDigit", (key) =>
            dashboardInteractionMethods.handleDashboardQuickJumpDigit.call(host, key),
          ),
    isDashboardScreen: rec.fn("isDashboardScreen", (screen) => dashboardState.screen === screen),
    updateWorktreeSessions: rec.fn("updateWorktreeSessions", () => {
      if (input.updatedWorktreeEntries) dashboardState.worktreeEntries = clone(input.updatedWorktreeEntries);
    }),
    preferDashboardEntrySelection: rec.fn("preferDashboardEntrySelection"),
    persistDashboardUiState: rec.fn("persistDashboardUiState"),
    refreshDashboardScribePreviewEntries: rec.fn("refreshDashboardScribePreviewEntries"),
    renderDashboard: rec.fn("renderDashboard"),
    renderCurrentDashboardView: rec.fn("renderCurrentDashboardView"),
    activateSelectedDashboardWorktreeEntry: rec.fn("activateSelectedDashboardWorktreeEntry", () =>
      dashboardInteractionMethods.activateSelectedDashboardWorktreeEntry.call(host),
    ),
    activateDashboardService: rec.fn("activateDashboardService", async () => "opened"),
    activateDashboardEntry: rec.fn("activateDashboardEntry", async () => "opened"),
    getDashboardServices: rec.fn("getDashboardServices", () => clone(input.dashboardServicesCache ?? [])),
    getDashboardSessions: rec.fn("getDashboardSessions", () => clone(input.dashboardSessionsCache ?? [])),
    getDashboardSessionsInVisualOrder: rec.fn("getDashboardSessionsInVisualOrder", () => clone(input.visualSessions ?? [])),
    focusSession: rec.fn("focusSession"),
  };
  return { host, calls: rec.calls };
}

function installTimerRecorder(timers) {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  global.setTimeout = (handler, ms, ...args) => {
    const timer = { ms, args, cleared: false };
    timers.push({ ms, args: clone(args) });
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
    timers.push({ cleared: true, ms: timer?.ms ?? null });
  };
  return () => {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  };
}

async function runCase(input) {
  const { host, calls } = makeHost(input);
  const timers = [];
  const restoreTimers = installTimerRecorder(timers);
  try {
    const method = dashboardInteractionMethods[input.method];
    if (typeof method !== "function") throw new Error(`unknown method ${input.method}`);
    if (input.method === "focusDashboardQuickJumpEntry") {
      method.call(host, input.worktreePath, input.entryIndex, input.options);
    } else if (input.method === "handleDashboardQuickJumpDigit") {
      method.call(host, input.key);
    } else if (input.method === "handleDashboardKey") {
      method.call(host, bufferForKey(input.key));
    } else {
      method.call(host);
    }
    return {
      level: host.dashboardState.level,
      focusedWorktreePath: host.dashboardState.focusedWorktreePath,
      quickJumpDigits: host.dashboardState.quickJumpDigits,
      sessionIndex: host.dashboardState.sessionIndex,
      activeIndex: host.activeIndex,
      dashboardRenderOptions: host.dashboardRenderOptions,
      hasQuickJumpTimer: Boolean(host.dashboardQuickJumpTimeout),
      footerFlash: host.footerFlash,
      footerFlashTicks: host.footerFlashTicks,
      calls,
      timers,
    };
  } finally {
    restoreTimers();
  }
}

const wtPath = "/repo/.aimux/worktrees/feature";
const mainSession = { id: "main-1", command: "codex", status: "running" };
const wtFirst = { id: "wt-first", command: "codex", status: "running", worktreePath: wtPath };
const wtSecond = { id: "wt-second", command: "claude", status: "offline", worktreePath: wtPath };

const casesInput = [
  {
    name: "first quick-jump digit focuses worktree and arms second digit",
    input: {
      method: "handleDashboardQuickJumpDigit",
      key: "2",
      hasWorktrees: true,
      dashboardSessionsCache: [mainSession, wtFirst],
      dashboardWorktreeGroupsCache: [{ name: "feature", branch: "feature", path: wtPath, sessions: [wtFirst], services: [] }],
    },
  },
  {
    name: "second quick-jump digit selects worktree entry and activates it",
    input: {
      method: "handleDashboardQuickJumpDigit",
      key: "2",
      hasWorktrees: true,
      quickJumpDigits: "1",
      focusedWorktreePath: wtPath,
      worktreeEntries: [
        { kind: "session", id: "wt-first" },
        { kind: "service", id: "svc-1" },
      ],
      dashboardServicesCache: [{ id: "svc-1", command: "yarn dev", status: "running", worktreePath: wtPath }],
    },
  },
  {
    name: "focus quick-jump entry clamps index and persists selection",
    input: {
      method: "focusDashboardQuickJumpEntry",
      worktreePath: wtPath,
      entryIndex: 9,
      worktreeEntries: [
        { kind: "session", id: "wt-first" },
        { kind: "session", id: "wt-second" },
      ],
    },
  },
  {
    name: "activate selected entry blocks removing worktree",
    input: {
      method: "activateSelectedDashboardWorktreeEntry",
      focusedWorktreePath: wtPath,
      worktreeEntries: [{ kind: "session", id: "wt-first" }],
      dashboardWorktreeGroupsCache: [{ name: "feature", branch: "feature", path: wtPath, pendingAction: "removing" }],
    },
  },
  {
    name: "activate selected service delegates to service activation",
    input: {
      method: "activateSelectedDashboardWorktreeEntry",
      focusedWorktreePath: wtPath,
      worktreeEntries: [{ kind: "service", id: "svc-1" }],
      dashboardServicesCache: [{ id: "svc-1", command: "yarn dev", status: "running", worktreePath: wtPath }],
    },
  },
  {
    name: "non-worktree down navigation moves active index and renders",
    input: {
      method: "handleDashboardKey",
      key: "j",
      useActualQuickJump: false,
      activeIndex: 0,
      dashboardSessionsCache: [mainSession, wtFirst],
    },
  },
  {
    name: "non-worktree enter activates selected visible session",
    input: {
      method: "handleDashboardKey",
      key: "enter",
      useActualQuickJump: false,
      activeIndex: 1,
      dashboardSessionsCache: [mainSession, wtFirst],
    },
  },
  {
    name: "worktree level down cycles focused worktree path",
    input: {
      method: "handleDashboardKey",
      key: "j",
      useActualQuickJump: false,
      hasWorktrees: true,
      level: "worktrees",
      focusedWorktreePath: undefined,
      worktreeNavOrder: [undefined, wtPath],
    },
  },
  {
    name: "worktree enter with entries steps into focused worktree",
    input: {
      method: "handleDashboardKey",
      key: "enter",
      useActualQuickJump: false,
      hasWorktrees: true,
      level: "worktrees",
      focusedWorktreePath: wtPath,
      worktreeEntries: [{ kind: "session", id: "wt-first" }],
    },
  },
  {
    name: "session level left returns to worktree list",
    input: {
      method: "handleDashboardKey",
      key: "h",
      useActualQuickJump: false,
      hasWorktrees: true,
      level: "sessions",
      focusedWorktreePath: wtPath,
      worktreeEntries: [{ kind: "session", id: "wt-first" }],
    },
  },
];

const cases = [];
for (const [index, entry] of casesInput.entries()) {
  const input = clone(entry.input);
  cases.push({
    id: `dashboard-interaction-navigation-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-interaction.ts",
    api: `dashboardInteractionMethods.${input.method}`,
    input,
    output: await runCase(clone(input)),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-interaction.ts",
  generatedBy: "scripts/capture-dashboard-interaction-navigation-contract.mjs",
  description:
    "Dashboard interaction quick-jump and worktree/session navigation side effects captured by running TypeScript dashboardInteractionMethods.",
  cases,
});
