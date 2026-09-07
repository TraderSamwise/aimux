#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-control-helpers.json", ROOT);

const {
  getSelectedDashboardServiceForActions,
  getSelectedDashboardSessionForActions,
  getSelectedDashboardWorktreeEntry,
  isDashboardScreen,
  noteLastUsedItem,
  pruneRuntimeGuardRepairAttempts,
  setDashboardScreen,
  syncTuiNotificationContext,
} = await import(new URL("dist/multiplexer/dashboard-control.js", ROOT));

const realDate = Date;
const FIXED_NOW = "2026-06-21T00:00:00.000Z";
globalThis.Date = class extends realDate {
  constructor(...args) {
    super(...(args.length === 0 ? [FIXED_NOW] : args));
  }
  static now() {
    return new realDate(FIXED_NOW).getTime();
  }
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function recorder() {
  const calls = [];
  return {
    calls,
    fn(name, impl) {
      return (...args) => {
        calls.push({ method: name, args: clone(args) });
        return impl?.(...args);
      };
    },
  };
}

function makeHost(input) {
  const rec = recorder();
  const state = {
    screen: input.screen ?? "dashboard",
    level: input.level ?? "sessions",
    sessionIndex: input.sessionIndex ?? 0,
    worktreeEntries: clone(input.worktreeEntries ?? []),
    worktreeSessions: clone(input.worktreeSessions ?? []),
    worktreeNavOrder: clone(input.worktreeNavOrder ?? []),
    focusedWorktreePath: input.focusedWorktreePath,
    isScreen(screen) {
      return state.screen === screen;
    },
    setScreen(screen) {
      state.screen = screen;
    },
  };
  const host = {
    mode: input.mode ?? "dashboard",
    projectRoot: input.projectRoot,
    activeIndex: input.activeIndex ?? 0,
    dashboardState: state,
    getDashboardSessions: rec.fn("getDashboardSessions", () => clone(input.dashboardSessions ?? [])),
    getDashboardServices: rec.fn("getDashboardServices", () => clone(input.dashboardServices ?? [])),
    writeDashboardClientStatuslineFile: rec.fn("writeDashboardClientStatuslineFile"),
    persistDashboardUiState: rec.fn("persistDashboardUiState"),
    invalidateDesktopStateSnapshot: rec.fn("invalidateDesktopStateSnapshot"),
    postToProjectService:
      input.hasProjectService === false ? undefined : rec.fn("postToProjectService", async () => ({ ok: true })),
    tmuxRuntimeManager: {
      refreshStatus: rec.fn("tmuxRuntimeManager.refreshStatus"),
      currentClientSession: rec.fn("tmuxRuntimeManager.currentClientSession", () => input.currentClientSession),
    },
  };
  return { host, calls: rec.calls };
}

async function runCase(api, input) {
  if (api === "pruneRuntimeGuardRepairAttempts") {
    return pruneRuntimeGuardRepairAttempts(input.attempts ?? [], input.now);
  }
  const { host, calls } = makeHost(input);
  let result = null;
  if (api === "getSelectedDashboardWorktreeEntry") result = getSelectedDashboardWorktreeEntry(host) ?? null;
  else if (api === "getSelectedDashboardSessionForActions") result = getSelectedDashboardSessionForActions(host) ?? null;
  else if (api === "getSelectedDashboardServiceForActions") result = getSelectedDashboardServiceForActions(host) ?? null;
  else if (api === "isDashboardScreen") result = isDashboardScreen(host, input.queryScreen);
  else if (api === "setDashboardScreen") setDashboardScreen(host, input.targetScreen);
  else if (api === "syncTuiNotificationContext") syncTuiNotificationContext(host, input.panelOpen);
  else if (api === "noteLastUsedItem") noteLastUsedItem(host, input.itemId, input.clientSession);
  else throw new Error(`unknown api ${api}`);
  await sleep(10);
  return {
    result,
    screen: host.dashboardState.screen,
    calls,
  };
}

const casesInput = [
  {
    api: "getSelectedDashboardWorktreeEntry",
    name: "returns selected worktree entry in session level",
    input: {
      level: "sessions",
      sessionIndex: 1,
      worktreeEntries: [
        { kind: "session", id: "codex-1" },
        { kind: "service", id: "svc-1" },
      ],
    },
  },
  {
    api: "getSelectedDashboardSessionForActions",
    name: "resolves selected worktree session",
    input: {
      level: "sessions",
      sessionIndex: 0,
      worktreeEntries: [{ kind: "session", id: "codex-1" }],
      worktreeSessions: [{ id: "codex-1", status: "ready" }],
      worktreeNavOrder: ["main", "wt"],
      dashboardSessions: [{ id: "other" }],
    },
  },
  {
    api: "getSelectedDashboardSessionForActions",
    name: "falls back to global active session when only one worktree exists",
    input: {
      level: "sessions",
      worktreeEntries: [],
      worktreeNavOrder: ["main"],
      activeIndex: 1,
      dashboardSessions: [{ id: "codex-1" }, { id: "claude-2" }],
    },
  },
  {
    api: "getSelectedDashboardServiceForActions",
    name: "resolves selected service entry",
    input: {
      level: "sessions",
      sessionIndex: 0,
      worktreeEntries: [{ kind: "service", id: "svc-1" }],
      dashboardServices: [{ id: "svc-1", status: "running" }],
    },
  },
  {
    api: "setDashboardScreen",
    name: "sets screen and syncs dashboard chrome state",
    input: {
      targetScreen: "coordination",
      dashboardSessions: [{ id: "codex-1" }],
      activeIndex: 0,
      currentClientSession: "client-1",
    },
  },
  {
    api: "syncTuiNotificationContext",
    name: "syncs selected worktree session notification context",
    input: {
      panelOpen: true,
      level: "sessions",
      sessionIndex: 0,
      worktreeEntries: [{ kind: "session", id: "codex-1" }],
      dashboardSessions: [{ id: "fallback" }],
      currentClientSession: "client-2",
    },
  },
  {
    api: "noteLastUsedItem",
    name: "marks usage through project service and invalidates snapshot",
    input: {
      itemId: "codex-1",
      currentClientSession: "client-3",
    },
  },
  {
    api: "pruneRuntimeGuardRepairAttempts",
    name: "keeps attempts inside the flap window",
    input: {
      now: 1_000_000,
      attempts: [870_000, 879_000, 881_000, 995_000, 1_000_000],
    },
  },
];

const cases = [];
for (const [index, entry] of casesInput.entries()) {
  const input = clone(entry.input);
  cases.push({
    id: `dashboard-control-helpers-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-control.ts",
    api: entry.api,
    input,
    output: await runCase(entry.api, clone(input)),
    inputSha256: hash(input),
  });
}

globalThis.Date = realDate;

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-control.ts",
  generatedBy: "scripts/capture-dashboard-control-helpers-contract.mjs",
  description:
    "Dashboard-control selection helpers, screen state, notification context, usage marking, and repair-attempt pruning captured by running TypeScript.",
  cases,
});
