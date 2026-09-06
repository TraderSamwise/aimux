#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("src/multiplexer/dashboard-interaction.contract.v1.json", ROOT);
const GOLDEN_PATH = new URL("src/multiplexer/desktop-state-golden.fixture.json", ROOT);
const { dashboardInteractionMethods } = await import(new URL("dist/multiplexer/dashboard-interaction.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function dashboardStateFor(snapshot) {
  const groups = snapshot.worktreeGroups ?? [];
  const firstPath = groups[0]?.path;
  return {
    level: groups.length > 0 ? "worktrees" : "sessions",
    focusedWorktreePath: firstPath,
    sessionIndex: 0,
    quickJumpDigits: "",
    hideOfflineAgents: false,
    worktreeEntries: [],
    worktreeSessions: [],
    worktreeServices: [],
    worktreeNavOrder: groups.map((group) => group.path),
    previewSource: "output",
    hasWorktrees() {
      return groups.length > 0;
    },
    toggleDetailsSidebar() {},
  };
}

function createHost(snapshot) {
  const host = {
    mode: "dashboard",
    activeIndex: 0,
    dashboardSessionsCache: clone(snapshot.sessions ?? []),
    dashboardServicesCache: clone(snapshot.services ?? []),
    dashboardTeammatesCache: clone(snapshot.teammates ?? []),
    dashboardWorktreeGroupsCache: clone(snapshot.worktreeGroups ?? []),
    dashboardMainCheckoutInfoCache: clone(snapshot.mainCheckoutInfo ?? { name: "Main Checkout", branch: "" }),
    dashboardOperationFailuresCache: clone(snapshot.operationFailures ?? []),
    dashboardState: dashboardStateFor(snapshot),
    dashboardUiStateStore: {
      markSelectionDirty() {
        host.calls.push(["markSelectionDirty"]);
      },
      rememberCurrentEntrySelection() {
        host.calls.push(["rememberCurrentEntrySelection"]);
      },
    },
    dashboard: {
      toggleDetailsPane() {
        host.calls.push(["toggleDetailsPane"]);
      },
    },
    calls: [],
    requests: [],
    renders: 0,
    getDashboardSessions() {
      return this.dashboardSessionsCache;
    },
    getDashboardServices() {
      return this.dashboardServicesCache;
    },
    isDashboardScreen(screen) {
      return this.mode === screen;
    },
    renderDashboard() {
      this.renders += 1;
      this.calls.push(["renderDashboard"]);
    },
    renderCurrentDashboardView() {
      this.renders += 1;
      this.calls.push(["renderCurrentDashboardView"]);
    },
    refreshDashboardScribePreviewEntries() {
      this.calls.push(["refreshDashboardScribePreviewEntries"]);
    },
    updateWorktreeSessions() {
      const group = this.dashboardWorktreeGroupsCache.find(
        (entry) => entry.path === this.dashboardState.focusedWorktreePath,
      );
      const sessions = (group?.sessions ?? []).map((entry) => ({ kind: "session", id: entry.id }));
      const services = (group?.services ?? []).map((entry) => ({ kind: "service", id: entry.id }));
      this.dashboardState.worktreeEntries = [...sessions, ...services];
      this.dashboardState.worktreeSessions = group?.sessions ?? [];
      this.dashboardState.worktreeServices = group?.services ?? [];
    },
    preferDashboardEntrySelection(kind, id, worktreePath) {
      this.calls.push(["preferDashboardEntrySelection", kind, id, worktreePath ?? null]);
    },
    persistDashboardUiState() {
      this.calls.push(["persistDashboardUiState"]);
    },
    focusSession(index) {
      this.calls.push(["focusSession", index]);
    },
    exitDashboardClientOrProcess() {
      this.calls.push(["quit"]);
    },
    showDashboardError(title, details) {
      this.calls.push(["showDashboardError", title, details]);
    },
  };
  Object.assign(host, dashboardInteractionMethods);
  host.activateDashboardEntry = function activateDashboardEntry(entry) {
    this.requests.push({ kind: "agent", id: entry.id });
  };
  host.activateDashboardService = function activateDashboardService(service) {
    this.requests.push({ kind: "service", id: service.id });
  };
  host.activateDashboardEntryByNumber = function activateDashboardEntryByNumber(index) {
    const entry = this.getDashboardSessions()[index];
    if (entry) this.activateDashboardEntry(entry);
  };
  host.updateWorktreeSessions();
  return host;
}

function setFocusedWorktree(host, path, sessionIndex = 0) {
  host.dashboardState.focusedWorktreePath = path ?? undefined;
  host.dashboardState.sessionIndex = sessionIndex;
  host.updateWorktreeSessions();
}

function summarize(host) {
  if (host.dashboardQuickJumpTimeout) {
    clearTimeout(host.dashboardQuickJumpTimeout);
    host.dashboardQuickJumpTimeout = null;
  }
  return {
    level: host.dashboardState.level,
    focusedWorktreePath: host.dashboardState.focusedWorktreePath ?? null,
    sessionIndex: host.dashboardState.sessionIndex,
    quickJumpDigits: host.dashboardState.quickJumpDigits,
    footerFlash: host.footerFlash ?? null,
    renders: host.renders,
    requests: host.requests,
  };
}

const golden = JSON.parse(await readFile(GOLDEN_PATH, "utf8")).runtimeFull;
const featurePath = golden.worktreeGroups.find((group) => group.path)?.path;
const cases = [];

function record(name, setup, keys) {
  const snapshot = clone(golden);
  setup?.(snapshot);
  const host = createHost(snapshot);
  setup?.(snapshot, host);
  const initialState = {
    level: host.dashboardState.level,
    focusedWorktreePath: host.dashboardState.focusedWorktreePath ?? null,
    sessionIndex: host.dashboardState.sessionIndex,
    quickJumpDigits: host.dashboardState.quickJumpDigits,
  };
  for (const key of keys) {
    host.handleDashboardKey(Buffer.from(key));
  }
  const input = { snapshot, initialState, keys };
  cases.push({
    id: `dashboard-interaction-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/dashboard-interaction.ts",
    api: "dashboardInteractionMethods.handleDashboardKey",
    input,
    output: summarize(host),
    inputSha256: hash(input),
  });
}

record(
  "worktree down wraps from last to first",
  (_snapshot, host) => {
    if (!host) return;
    host.dashboardState.level = "worktrees";
    setFocusedWorktree(host, featurePath);
  },
  ["j"],
);

record(
  "worktree up wraps from first to last",
  (_snapshot, host) => {
    if (!host) return;
    host.dashboardState.level = "worktrees";
    setFocusedWorktree(host, null);
  },
  ["k"],
);

record(
  "session down wraps from last to first",
  (_snapshot, host) => {
    if (!host) return;
    host.dashboardState.level = "sessions";
    setFocusedWorktree(host, featurePath, 2);
  },
  ["j"],
);

record(
  "session up wraps from first to last",
  (_snapshot, host) => {
    if (!host) return;
    host.dashboardState.level = "sessions";
    setFocusedWorktree(host, featurePath, 0);
  },
  ["k"],
);

record(
  "enter blocks failed worktree",
  (snapshot, host) => {
    const group = snapshot.worktreeGroups.find((entry) => entry.path === featurePath);
    group.operationFailure = { operation: "remove", message: "git refused" };
    if (host) {
      host.dashboardWorktreeGroupsCache = clone(snapshot.worktreeGroups);
      host.dashboardState.level = "worktrees";
      setFocusedWorktree(host, featurePath);
    }
  },
  ["\r"],
);

record(
  "enter blocks graveyarding worktree",
  (snapshot, host) => {
    const group = snapshot.worktreeGroups.find((entry) => entry.path === featurePath);
    group.pendingAction = "graveyarding";
    if (host) {
      host.dashboardWorktreeGroupsCache = clone(snapshot.worktreeGroups);
      host.dashboardState.level = "worktrees";
      setFocusedWorktree(host, featurePath);
    }
  },
  ["\r"],
);

record(
  "two digit quick jump activates entry inside worktree",
  (snapshot, host) => {
    const session = snapshot.sessions.find((entry) => entry.id === "claude-1");
    if (session) session.tmuxWindowId = "@2";
    for (const group of snapshot.worktreeGroups ?? []) {
      const grouped = group.sessions?.find((entry) => entry.id === "claude-1");
      if (grouped) grouped.tmuxWindowId = "@2";
    }
    if (!host) return;
    host.dashboardSessionsCache = clone(snapshot.sessions);
    host.dashboardWorktreeGroupsCache = clone(snapshot.worktreeGroups);
    host.dashboardState.level = "worktrees";
    setFocusedWorktree(host, null);
  },
  ["2", "1"],
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-dashboard-interaction-contract.mjs",
  source: "src/multiplexer/dashboard-interaction.ts",
  subject: "src/multiplexer/dashboard-interaction.ts",
  description: "Dashboard interaction/navigation behavior captured from TypeScript dashboardInteractionMethods.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
