#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-interaction-command-keys.json", ROOT);

const { dashboardInteractionMethods } = await import(new URL("dist/multiplexer/dashboard-interaction.js", ROOT));

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
  const dashboardState = {
    screen: input.screen ?? "dashboard",
    level: input.level ?? "sessions",
    focusedWorktreePath: input.focusedWorktreePath,
    quickJumpDigits: "",
    hideOfflineAgents: input.hideOfflineAgents ?? false,
    previewSource: input.previewSource ?? "output",
    hasWorktrees: () => input.hasWorktrees === true,
  };
  const host = {
    mode: input.mode ?? "dashboard",
    sessions: clone(input.sessions ?? [{ id: "codex-1" }]),
    dashboardState,
    dashboardSessionsCache: clone(input.dashboardSessionsCache ?? []),
    dashboardServicesCache: clone(input.dashboardServicesCache ?? []),
    dashboardWorktreeGroupsCache: clone(input.dashboardWorktreeGroupsCache ?? []),
    dashboardTeammatesCache: clone(input.dashboardTeammatesCache ?? []),
    dashboardOperationFailuresCache: clone(input.dashboardOperationFailuresCache ?? []),
    footerFlash: null,
    footerFlashTicks: 0,
    isDashboardScreen: rec.fn("isDashboardScreen", (screen) => dashboardState.screen === screen),
    handleDashboardQuickJumpDigit: rec.fn("handleDashboardQuickJumpDigit", () => false),
    clearDashboardQuickJump: rec.fn("clearDashboardQuickJump", () => {
      dashboardState.quickJumpDigits = "";
    }),
    reconcileDashboardRenderState: rec.fn("reconcileDashboardRenderState"),
    renderDashboard: rec.fn("renderDashboard"),
    showOrchestrationRoutePicker: rec.fn("showOrchestrationRoutePicker"),
    showLibrary: rec.fn("showLibrary"),
    showWorktreeList: rec.fn("showWorktreeList"),
    showWorktreeCacheCleanupPreview: rec.fn("showWorktreeCacheCleanupPreview"),
    showOverseerOverlay: rec.fn("showOverseerOverlay"),
    showWorkOutlineOverlay: rec.fn("showWorkOutlineOverlay"),
    getSelectedDashboardSessionForActions: rec.fn("getSelectedDashboardSessionForActions", () =>
      clone(input.selectedSession ?? null),
    ),
    openRelevantThreadForSession: rec.fn("openRelevantThreadForSession", async () => ({ ok: true })),
    showDashboardError: rec.fn("showDashboardError"),
    showToolPicker: rec.fn("showToolPicker"),
    showHelp: rec.fn("showHelp"),
    showCoordination: rec.fn("showCoordination"),
    showServiceCreatePrompt: rec.fn("showServiceCreatePrompt"),
    showTeammatePicker: rec.fn("showTeammatePicker"),
    exitDashboardClientOrProcess: rec.fn("exitDashboardClientOrProcess"),
    showWorktreeCreatePrompt: rec.fn("showWorktreeCreatePrompt"),
    showGraveyard: rec.fn("showGraveyard"),
    showProject: rec.fn("showProject"),
    showTopology: rec.fn("showTopology"),
    activateNextAttentionEntry: rec.fn("activateNextAttentionEntry", async () => ({ ok: true })),
    showMigratePicker: rec.fn("showMigratePicker"),
    persistDashboardUiState: rec.fn("persistDashboardUiState"),
    refreshDashboardScribePreviewEntries: rec.fn("refreshDashboardScribePreviewEntries"),
  };
  return { host, calls: rec.calls };
}

async function runCase(input) {
  const { host, calls } = makeHost(input);
  for (const key of input.keys ?? [input.key]) {
    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from(key));
  }
  await sleep(10);
  return {
    footerFlash: host.footerFlash,
    footerFlashTicks: host.footerFlashTicks,
    hideOfflineAgents: host.dashboardState.hideOfflineAgents,
    previewSource: host.dashboardState.previewSource,
    calls,
  };
}

const casesInput = [
  { name: "question mark opens help", input: { key: "?" } },
  { name: "basic dashboard command keys dispatch host methods", input: { keys: ["n", "c", "v", "q", "w", "g", "p", "t", "u"] } },
  { name: "lowercase s opens message route picker", input: { key: "s" } },
  { name: "shifted handoff task library worktree delete overseer outline shortcuts", input: { keys: ["H", "T", "L", "W", "D", "O", "P"] } },
  {
    name: "toggle hidden offline agents",
    input: { key: "a", hideOfflineAgents: false },
  },
  {
    name: "shift v toggles scribe preview when live scribe exists",
    input: {
      key: "V",
      previewSource: "output",
      dashboardSessionsCache: [{ id: "scribe-1", status: "running", team: { role: "scribe" } }],
    },
  },
  {
    name: "shift r opens relevant thread when work waits on user",
    input: {
      key: "R",
      selectedSession: { id: "codex-1", label: "Codex", threadWaitingOnMeCount: 2 },
    },
  },
  {
    name: "shift r flashes when nothing waits on user",
    input: {
      key: "R",
      selectedSession: { id: "codex-1", label: "Codex", threadWaitingOnMeCount: 0 },
    },
  },
  {
    name: "shift s blocks when no session is selected",
    input: {
      key: "S",
      selectedSession: null,
      hasWorktrees: true,
      level: "worktrees",
    },
  },
  {
    name: "shift s blocks offline selected session",
    input: {
      key: "S",
      selectedSession: { id: "codex-1", label: "Codex", status: "offline" },
    },
  },
  {
    name: "shift s opens switch tool picker for live session",
    input: {
      key: "S",
      selectedSession: { id: "codex-1", label: "Codex", status: "running" },
    },
  },
  {
    name: "f blocks for offline selected session",
    input: {
      key: "f",
      selectedSession: { id: "codex-1", label: "Codex", status: "offline" },
    },
  },
];

const cases = [];
for (const [index, entry] of casesInput.entries()) {
  const input = clone(entry.input);
  cases.push({
    id: `dashboard-interaction-command-keys-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-interaction.ts",
    api: "dashboardInteractionMethods.handleDashboardKey",
    input,
    output: await runCase(clone(input)),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-interaction.ts",
  generatedBy: "scripts/capture-dashboard-interaction-command-keys-contract.mjs",
  description:
    "Dashboard interaction command-key host dispatch, flashes, and preview/offline toggles captured by running TypeScript handleDashboardKey.",
  cases,
});
