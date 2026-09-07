#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-control-overlays.json", ROOT);

const { handleActiveDashboardOverlayKey } = await import(new URL("dist/multiplexer/dashboard-control.js", ROOT));

const realNow = Date.now;
Date.now = () => 1_700_000_000_000;

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
  const host = {
    mode: input.mode ?? "dashboard",
    activeIndex: input.activeIndex ?? 0,
    dashboardBusyState: clone(input.dashboardBusyState ?? null),
    dashboardErrorState: clone(input.dashboardErrorState ?? null),
    dashboardOverlayState: clone(input.dashboardOverlayState ?? { kind: "none" }),
    dashboardState: {
      screen: input.screen ?? "dashboard",
      level: input.level ?? "sessions",
      sessionIndex: input.sessionIndex ?? 0,
      worktreeEntries: clone(input.worktreeEntries ?? []),
      worktreeSessions: clone(input.worktreeSessions ?? []),
      worktreeNavOrder: clone(input.worktreeNavOrder ?? ["main"]),
    },
    agentRestoreConfirmSelection: input.agentRestoreConfirmSelection ?? "restore",
    dashboardAgentRestoreOfferCache: clone(input.dashboardAgentRestoreOfferCache ?? null),
    footerFlash: null,
    footerFlashTicks: 0,
    dashboardInputEpoch: 0,
    dashboardModelServiceRefreshedAt: 0,
    dashboardModelServiceRefreshError: null,
    handleDashboardKey: rec.fn("handleDashboardKey"),
    dismissDashboardError: rec.fn("dismissDashboardError", () => {
      host.dashboardErrorState = null;
    }),
    clearDashboardOverlay: rec.fn("clearDashboardOverlay", () => {
      host.dashboardOverlayState = { kind: "none" };
    }),
    redrawDashboardWithOverlay: rec.fn("redrawDashboardWithOverlay"),
    renderDashboard: rec.fn("renderDashboard"),
    showDashboardError: rec.fn("showDashboardError"),
    refreshDashboardModelFromService: rec.fn("refreshDashboardModelFromService", async () => true),
    postToProjectService: rec.fn("postToProjectService", async (path) => {
      if (input.restoreThrows) throw new Error("project service endpoint did not become ready");
      if (path === "/agents/restore-previous") {
        return clone(input.restoreResult ?? { ok: true, accepted: true, total: 2, restored: [], failed: [], transitions: [] });
      }
      return { ok: true };
    }),
    setPendingDashboardSessionAction: rec.fn("setPendingDashboardSessionAction"),
    getDashboardSessions: rec.fn("getDashboardSessions", () => clone(input.dashboardSessions ?? [])),
  };
  const handlers = [
    "handleToolPickerKey",
    "handleToolOptionsKey",
    "handleTeammatePickerKey",
    "handleOverseerOverlayKey",
    "handleOverseerWatchInstructionsKey",
    "handleWorkOutlineOverlayKey",
    "handleWorktreeRemoveConfirmKey",
    "handleWorktreeCacheCleanupConfirmKey",
    "handleWorktreeInputKey",
    "handleServiceInputKey",
    "handleWorktreeListKey",
    "handleMigratePickerKey",
    "handleSwitcherKey",
    "handleThreadReplyKey",
    "handleOrchestrationRoutePickerKey",
    "handleOrchestrationInputKey",
    "handleLabelInputKey",
  ];
  for (const name of handlers) host[name] = rec.fn(name);
  return { host, calls: rec.calls };
}

function summarizePending(pending) {
  if (!pending) return null;
  return {
    data: clone(pending.data),
    key: pending.key,
    queuedAt: pending.queuedAt,
  };
}

async function runCase(input) {
  const { host, calls } = makeHost(input);
  const handled = handleActiveDashboardOverlayKey(host, Buffer.from(input.key));
  if (input.advanceTimers) await sleep(input.advanceTimers);
  await sleep(10);
  return {
    handled,
    overlayKind: host.dashboardOverlayState?.kind ?? null,
    errorState: host.dashboardErrorState,
    busyState: host.dashboardBusyState,
    selection: host.agentRestoreConfirmSelection ?? null,
    footerFlash: host.footerFlash,
    footerFlashTicks: host.footerFlashTicks,
    pendingLocalNavigation: summarizePending(host.pendingDashboardLocalNavigation),
    coordinationLoaded: host.coordinationLoaded ?? null,
    calls,
  };
}

const cases = [
  {
    name: "busy overlay queues dashboard enter for later local focus",
    input: {
      dashboardBusyState: { title: "Repairing Aimux", lines: [], spinnerFrame: 0, startedAt: 1 },
      level: "worktrees",
      key: "\r",
    },
  },
  {
    name: "busy overlay swallows mutating create key without queueing navigation",
    input: {
      dashboardBusyState: { title: "Repairing Aimux", lines: [], spinnerFrame: 0, startedAt: 1 },
      level: "sessions",
      worktreeEntries: [{ kind: "session", id: "codex-1" }],
      worktreeSessions: [{ id: "codex-1", status: "ready" }],
      key: "n",
    },
  },
  {
    name: "error overlay dismisses on enter",
    input: {
      dashboardErrorState: { title: "Aimux repair failed", lines: ["previous failure"] },
      key: "\r",
    },
  },
  {
    name: "error overlay ignores ordinary key without dismiss",
    input: {
      dashboardErrorState: { title: "Aimux repair failed", lines: ["previous failure"] },
      key: "x",
    },
  },
  {
    name: "active overlay dispatches key to matching handler",
    input: {
      dashboardOverlayState: { kind: "thread-reply" },
      key: "j",
    },
  },
  {
    name: "unknown overlay kind falls through",
    input: {
      dashboardOverlayState: { kind: "none" },
      key: "j",
    },
  },
  {
    name: "restore overlay arrow toggles selection and redraws",
    input: {
      dashboardOverlayState: { kind: "agent-restore-confirm" },
      agentRestoreConfirmSelection: "restore",
      dashboardAgentRestoreOfferCache: { sessionIds: ["claude-1", "codex-1"] },
      key: "\u001b[C",
    },
  },
  {
    name: "restore overlay enter starts restore through project API",
    input: {
      dashboardOverlayState: { kind: "agent-restore-confirm" },
      agentRestoreConfirmSelection: "restore",
      dashboardAgentRestoreOfferCache: { sessionIds: ["claude-1", "codex-1"] },
      dashboardSessions: [
        { id: "claude-1", status: "offline" },
        { id: "codex-1", status: "offline" },
      ],
      key: "\r",
    },
  },
  {
    name: "restore overlay escape dismisses through project API",
    input: {
      dashboardOverlayState: { kind: "agent-restore-confirm" },
      agentRestoreConfirmSelection: "restore",
      dashboardAgentRestoreOfferCache: { sessionIds: ["claude-1", "codex-1"] },
      key: "\u001b",
    },
  },
  {
    name: "restore overlay enter on cancel dismisses",
    input: {
      dashboardOverlayState: { kind: "agent-restore-confirm" },
      agentRestoreConfirmSelection: "cancel",
      dashboardAgentRestoreOfferCache: { sessionIds: ["claude-1"] },
      key: "\r",
    },
  },
];

const outputCases = [];
for (const [index, entry] of cases.entries()) {
  const input = clone(entry.input);
  const output = await runCase(clone(input));
  outputCases.push({
    id: `dashboard-control-overlays-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-control.ts",
    api: "handleActiveDashboardOverlayKey",
    input,
    output,
    inputSha256: hash(input),
  });
}

Date.now = realNow;

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-control.ts",
  generatedBy: "scripts/capture-dashboard-control-overlays-contract.mjs",
  description:
    "Dashboard-control active overlay key dispatch, busy/error swallowing, and agent-restore confirm side effects captured by running TypeScript handleActiveDashboardOverlayKey.",
  cases: outputCases,
});
