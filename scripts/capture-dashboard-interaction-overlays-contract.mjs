#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-interaction-overlays.json", ROOT);

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
    case "escape":
      return Buffer.from("\x1b");
    case "enter":
      return Buffer.from("\r");
    case "backspace":
      return Buffer.from("\x7f");
    default:
      return Buffer.from(key);
  }
}

function makeHost(input) {
  const rec = recorder();
  const dashboardState = {
    level: input.level ?? "sessions",
    sessionIndex: input.sessionIndex ?? 0,
    worktreeEntries: clone(input.worktreeEntries ?? []),
    focusedWorktreePath: input.focusedWorktreePath,
    hasWorktrees: () => input.hasWorktrees === true,
  };
  const host = {
    projectRoot: "/tmp/aimux-fixture-project",
    mode: input.mode ?? "dashboard",
    activeIndex: input.activeIndex ?? 0,
    sessions: clone(input.sessions ?? []),
    dashboard: clone(input.dashboard ?? {}),
    dashboardState,
    dashboardSessionsCache: clone(input.dashboardSessionsCache ?? []),
    dashboardTeammatesCache: clone(input.dashboardTeammatesCache ?? []),
    dashboardOverseerSessionsCache: clone(input.dashboardOverseerSessionsCache ?? []),
    dashboardScribeSessionsCache: clone(input.dashboardScribeSessionsCache ?? []),
    teammatePickerState: clone(input.teammatePickerState ?? null),
    overseerWatchInstructionsTarget: clone(input.overseerWatchInstructionsTarget ?? null),
    overseerWatchInstructionsBuffer: input.overseerWatchInstructionsBuffer ?? "",
    serviceInputBuffer: input.serviceInputBuffer ?? "",
    labelInputBuffer: input.labelInputBuffer ?? "",
    labelInputTarget: input.labelInputTarget ?? null,
    workOutlineOverlayEntries: clone(input.workOutlineOverlayEntries ?? []),
    workOutlineOverlayOffset: input.workOutlineOverlayOffset ?? 0,
    workOutlineOverlaySessionId: input.workOutlineOverlaySessionId,
    footerFlash: null,
    footerFlashTicks: 0,
    dashboardOverlayState: input.overlayKind ? { kind: input.overlayKind } : null,
    getDashboardSessions: rec.fn("getDashboardSessions", () => clone(input.dashboardSessionsCache ?? [])),
    getSelectedDashboardSessionForActions: rec.fn("getSelectedDashboardSessionForActions", () =>
      clone(input.selectedSession ?? null),
    ),
    openDashboardOverlay: rec.fn("openDashboardOverlay", (kind) => {
      host.dashboardOverlayState = { kind };
    }),
    clearDashboardOverlay: rec.fn("clearDashboardOverlay", () => {
      host.dashboardOverlayState = null;
    }),
    restoreDashboardAfterOverlayDismiss: rec.fn("restoreDashboardAfterOverlayDismiss"),
    renderDashboard: rec.fn("renderDashboard"),
    redrawDashboardWithOverlay: rec.fn("redrawDashboardWithOverlay"),
    renderTeammatePicker: rec.fn("renderTeammatePicker"),
    renderOverseerOverlay: rec.fn("renderOverseerOverlay"),
    renderOverseerWatchInstructions: rec.fn("renderOverseerWatchInstructions"),
    renderWorkOutlineOverlay: rec.fn("renderWorkOutlineOverlay"),
    renderServiceInput: rec.fn("renderServiceInput"),
    renderLabelInput: rec.fn("renderLabelInput"),
    handleAction: rec.fn("handleAction"),
    showOverseerWatchInstructions: rec.fn("showOverseerWatchInstructions", (selected) => {
      host.overseerWatchInstructionsTarget = clone(selected);
      host.overseerWatchInstructionsBuffer = "";
      host.openDashboardOverlay("overseer-watch-instructions");
      host.renderOverseerWatchInstructions();
    }),
    activateDashboardEntry: rec.fn("activateDashboardEntry", async () => "opened"),
    openLiveTmuxWindowForEntry: rec.fn("openLiveTmuxWindowForEntry", () => input.openLiveResult ?? "missing"),
    showToolPicker: rec.fn("showToolPicker"),
    stopSessionToOfflineWithFeedback: rec.fn("stopSessionToOfflineWithFeedback"),
    createDashboardServiceWithFeedback: rec.fn("createDashboardServiceWithFeedback", async () => undefined),
    showDashboardError: rec.fn("showDashboardError"),
    updateSessionLabel: rec.fn("updateSessionLabel", async () => undefined),
    loadWorkOutlineOverlayEntries: rec.fn("loadWorkOutlineOverlayEntries", () => {
      host.workOutlineOverlayEntries = clone(input.reloadedWorkOutlineOverlayEntries ?? host.workOutlineOverlayEntries);
      return input.loadWorkOutlineResult !== false;
    }),
    dashboardCoreCommandRequest: rec.fn("dashboardCoreCommandRequest", async () => clone(input.coreCommandResponse ?? {})),
    refreshDashboardModelFromService: rec.fn("refreshDashboardModelFromService", async () => undefined),
  };
  return { host, calls: rec.calls };
}

async function runCase(input) {
  const { host, calls } = makeHost(input);
  const method = dashboardInteractionMethods[input.method];
  if (typeof method !== "function") {
    throw new Error(`unknown method ${input.method}`);
  }
  method.call(host, bufferForKey(input.key));
  await sleep(10);
  return {
    overlayKind: host.dashboardOverlayState?.kind ?? null,
    teammatePickerState: clone(host.teammatePickerState),
    overseerWatchInstructionsTarget: clone(host.overseerWatchInstructionsTarget),
    overseerWatchInstructionsBuffer: host.overseerWatchInstructionsBuffer,
    serviceInputBuffer: host.serviceInputBuffer,
    labelInputBuffer: host.labelInputBuffer,
    labelInputTarget: host.labelInputTarget,
    workOutlineOverlayOffset: host.workOutlineOverlayOffset,
    footerFlash: host.footerFlash,
    footerFlashTicks: host.footerFlashTicks,
    calls,
  };
}

const parent = { id: "codex-parent", command: "codex", label: "Parent", status: "running" };
const teammates = [
  {
    id: "codex-reviewer",
    command: "codex",
    label: "Reviewer",
    status: "running",
    team: { teamId: "team-codex-parent", parentSessionId: "codex-parent", role: "reviewer", order: 2 },
  },
  {
    id: "codex-tester",
    command: "codex",
    label: "Tester",
    status: "running",
    team: { teamId: "team-codex-parent", parentSessionId: "codex-parent", role: "tester", order: 1 },
  },
];

const casesInput = [
  {
    name: "showTeammatePicker flashes when no parent session is selected",
    input: { method: "showTeammatePicker", key: "", dashboardSessionsCache: [] },
  },
  {
    name: "showTeammatePicker flashes when parent has no teammates",
    input: { method: "showTeammatePicker", key: "", dashboardSessionsCache: [parent] },
  },
  {
    name: "showTeammatePicker opens picker when selected parent has teammates",
    input: { method: "showTeammatePicker", key: "", dashboardSessionsCache: [parent], dashboardTeammatesCache: teammates },
  },
  {
    name: "teammate picker moves down through visible teammates",
    input: {
      method: "handleTeammatePickerKey",
      key: "j",
      teammatePickerState: { parentSessionId: "codex-parent", index: 0 },
      dashboardSessionsCache: [parent],
      dashboardTeammatesCache: teammates,
    },
  },
  {
    name: "teammate picker digit activates teammate and clears overlay",
    input: {
      method: "handleTeammatePickerKey",
      key: "2",
      overlayKind: "teammate-picker",
      teammatePickerState: { parentSessionId: "codex-parent", index: 0 },
      dashboardSessionsCache: [parent],
      dashboardTeammatesCache: teammates,
    },
  },
  {
    name: "teammate picker escape clears overlay and restores dashboard",
    input: { method: "handleTeammatePickerKey", key: "escape", overlayKind: "teammate-picker" },
  },
  {
    name: "overseer overlay enter creates overseer action",
    input: { method: "handleOverseerOverlayKey", key: "enter", overlayKind: "overseer" },
  },
  {
    name: "overseer overlay watch without selected session flashes",
    input: { method: "handleOverseerOverlayKey", key: "w", overlayKind: "overseer" },
  },
  {
    name: "overseer overlay watch selected session opens instruction input",
    input: {
      method: "handleOverseerOverlayKey",
      key: "w",
      overlayKind: "overseer",
      selectedSession: { id: "codex-1", command: "codex", label: "Codex", status: "running" },
    },
  },
  {
    name: "overseer overlay stop without running overseer flashes",
    input: { method: "handleOverseerOverlayKey", key: "x", overlayKind: "overseer" },
  },
  {
    name: "overseer overlay stop uses running overseer runtime when present",
    input: {
      method: "handleOverseerOverlayKey",
      key: "x",
      overlayKind: "overseer",
      sessions: [{ id: "overseer-1", command: "claude", status: "running" }],
      dashboardOverseerSessionsCache: [
        { id: "overseer-1", command: "claude", status: "running", team: { role: "overseer" } },
      ],
    },
  },
  {
    name: "overseer watch instructions appends printable text",
    input: { method: "handleOverseerWatchInstructionsKey", key: "abc", overseerWatchInstructionsBuffer: "go " },
  },
  {
    name: "overseer watch instructions backspace trims buffer",
    input: { method: "handleOverseerWatchInstructionsKey", key: "backspace", overseerWatchInstructionsBuffer: "abcd" },
  },
  {
    name: "overseer watch instructions escape clears target and restores dashboard",
    input: {
      method: "handleOverseerWatchInstructionsKey",
      key: "escape",
      overlayKind: "overseer-watch-instructions",
      overseerWatchInstructionsBuffer: "watch",
      overseerWatchInstructionsTarget: { id: "codex-1", command: "codex" },
    },
  },
  {
    name: "service input appends printable text",
    input: { method: "handleServiceInputKey", key: "worker", serviceInputBuffer: "run " },
  },
  {
    name: "service input enter creates dashboard service",
    input: {
      method: "handleServiceInputKey",
      key: "enter",
      overlayKind: "service-input",
      serviceInputBuffer: "npm run dev",
      focusedWorktreePath: "/repo/wt",
    },
  },
  {
    name: "service input enter blocks outside dashboard mode",
    input: { method: "handleServiceInputKey", key: "enter", overlayKind: "service-input", serviceInputBuffer: "svc", mode: "session" },
  },
  {
    name: "label input enter updates target label",
    input: { method: "handleLabelInputKey", key: "enter", overlayKind: "label-input", labelInputBuffer: "  New Label  ", labelInputTarget: "codex-1" },
  },
  {
    name: "label input escape clears target and restores dashboard",
    input: { method: "handleLabelInputKey", key: "escape", overlayKind: "label-input", labelInputBuffer: "draft", labelInputTarget: "codex-1" },
  },
  {
    name: "work outline down and up clamp offset",
    input: { method: "handleWorkOutlineOverlayKey", key: "j", workOutlineOverlayEntries: [{ id: "a" }, { id: "b" }], workOutlineOverlayOffset: 0 },
  },
  {
    name: "work outline enter opens scribe when live scribe exists",
    input: {
      method: "handleWorkOutlineOverlayKey",
      key: "enter",
      overlayKind: "work-outline",
      dashboardScribeSessionsCache: [{ id: "scribe-1", command: "codex", status: "running", scribe: true }],
      openLiveResult: "opened",
    },
  },
  {
    name: "work outline enter opens scribe picker when no live scribe exists",
    input: { method: "handleWorkOutlineOverlayKey", key: "enter", overlayKind: "work-outline" },
  },
  {
    name: "work outline stop without running scribe flashes",
    input: { method: "handleWorkOutlineOverlayKey", key: "x", overlayKind: "work-outline" },
  },
  {
    name: "work outline stop uses running scribe runtime when present",
    input: {
      method: "handleWorkOutlineOverlayKey",
      key: "x",
      overlayKind: "work-outline",
      sessions: [{ id: "scribe-1", command: "codex", status: "running" }],
      dashboardScribeSessionsCache: [{ id: "scribe-1", command: "codex", status: "running", scribe: true }],
    },
  },
];

const cases = [];
for (const [index, entry] of casesInput.entries()) {
  const input = clone(entry.input);
  cases.push({
    id: `dashboard-interaction-overlays-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-interaction.ts",
    api: input.method,
    input,
    output: await runCase(clone(input)),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-interaction.ts",
  generatedBy: "scripts/capture-dashboard-interaction-overlays-contract.mjs",
  description:
    "Dashboard interaction overlay key handlers captured by running TypeScript against a fake dashboard host.",
  cases,
});
