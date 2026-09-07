#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const OVERLAY_FIXTURE_PATH = new URL("testdata/contracts/v1/tui/screen-overlays.json", ROOT);
const SUBSCREEN_FIXTURE_PATH = new URL("testdata/contracts/v1/tui/subscreen-renderers.json", ROOT);

const overlay = await import(new URL("dist/tui/screens/overlay-renderers.js", ROOT));
const subscreen = await import(new URL("dist/tui/screens/subscreen-renderers.js", ROOT));
const { buildGraveyardViewModel } = await import(new URL("dist/multiplexer/graveyard-view-model.js", ROOT));
const { stripAnsi } = await import(new URL("dist/tui/render/text.js", ROOT));

const FIXED_NOW = Date.parse("2026-09-07T00:00:00.000Z");
Date.now = () => FIXED_NOW;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const plain = (value) =>
  stripAnsi(value ?? "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[78]/g, "");
const ago = (days) => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function recordOverlay(cases, name, api, ctx, cols, rows) {
  const output = overlay[api](ctx, cols, rows);
  const input = { api, ctx: clone(ctx), cols, rows };
  cases.push({
    id: `tui-screen-overlay-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tui/screens/overlay-renderers.test.ts",
    api,
    input,
    output: {
      rendered: output,
      visibleText: plain(output),
      isNull: output == null,
    },
    inputSha256: hash(input),
  });
}

const overlayCases = [];
let listAllWorktreesCalled = false;
recordOverlay(
  overlayCases,
  "worktree list uses service-backed cache",
  "buildWorktreeListOverlayOutput",
  {
    mode: "dashboard",
    dashboardWorktreeGroupsCache: [
      { name: "Main Checkout", branch: "main" },
      { name: "feature", branch: "feature", path: "/repo/.aimux/worktrees/feature" },
    ],
    listAllWorktrees: () => {
      listAllWorktreesCalled = true;
      throw new Error("local worktree read should not run");
    },
  },
  100,
  30,
);
overlayCases.at(-1).output.sideEffects = { listAllWorktreesCalled };

recordOverlay(
  overlayCases,
  "empty worktree cache cleanup is dismiss-only",
  "buildWorktreeCacheCleanupConfirmOverlayOutput",
  {
    worktreeCacheCleanupConfirm: {
      dryRun: true,
      reclaimedBytes: 0,
      plan: { reclaimableBytes: 0, targets: [], skipped: [] },
      results: [],
    },
  },
  100,
  30,
);

recordOverlay(
  overlayCases,
  "worktree cache cleanup removal confirmation",
  "buildWorktreeCacheCleanupConfirmOverlayOutput",
  {
    worktreeCacheCleanupConfirm: {
      dryRun: true,
      reclaimedBytes: 0,
      plan: {
        reclaimableBytes: 2048,
        targets: [
          {
            worktreePath: "/repo/.aimux/worktrees/old",
            relativePath: "node_modules",
            path: "/repo/.aimux/worktrees/old/node_modules",
            sizeBytes: 2048,
          },
        ],
        skipped: [{ worktreePath: "/repo/.aimux/worktrees/live", reason: "active-runtime" }],
      },
      results: [{ path: "/repo/.aimux/worktrees/old/node_modules", status: "dry-run", sizeBytes: 2048 }],
    },
  },
  120,
  40,
);

recordOverlay(
  overlayCases,
  "empty scribe work outline",
  "buildWorkOutlineOverlayOutput",
  { workOutlineOverlayEntries: [] },
  100,
  30,
);

recordOverlay(
  overlayCases,
  "live scribe work outline controls",
  "buildWorkOutlineOverlayOutput",
  {
    dashboard: {
      viewModel: {
        scribeSessions: [{ id: "claude-scribe", command: "claude", status: "ready", scribe: true }],
      },
    },
    workOutlineOverlayEntries: [],
  },
  100,
  30,
);

recordOverlay(
  overlayCases,
  "scoped work outline with omitted rows",
  "buildWorkOutlineOverlayOutput",
  {
    workOutlineOverlaySessionId: "codex-1",
    workOutlineOverlayOffset: 0,
    workOutlineOverlayEntries: [
      {
        entryId: "outline-1",
        topicKey: "runtime-stability",
        title: "Harden lifecycle retries",
        summary: "Added bounded repair retry telemetry and skipped duplicate restarts.",
        status: "active",
        source: "scribe",
        worktreePath: "/repo/.aimux/worktrees/lifecycle",
        sessionIds: ["codex-1", "claude-2", "codex-3"],
        updatedAt: "2026-08-30T04:12:30.000Z",
      },
      {
        entryId: "outline-2",
        topicKey: "scrollback",
        title: "Audit scrollback gaps",
        summary: "Checked transcript window bounds.",
        status: "done",
        source: "manual",
        worktreePath: "/repo",
        sessionIds: ["claude-4"],
        updatedAt: "2026-08-30T04:10:00.000Z",
      },
      {
        entryId: "outline-3",
        topicKey: "hidden",
        title: "Hidden due row budget",
        summary: "This should not fit in the small overlay.",
        status: "done",
        source: "scribe",
        worktreePath: "/repo",
        sessionIds: ["codex-5"],
        updatedAt: "2026-08-30T04:09:00.000Z",
      },
    ],
  },
  120,
  26,
);

recordOverlay(
  overlayCases,
  "agent restore modal choices",
  "buildAgentRestoreConfirmOverlayOutput",
  {
    agentRestoreConfirmSelection: "cancel",
    dashboardAgentRestoreOfferCache: {
      sessionIds: ["claude-1", "codex-2"],
      sessions: [
        { id: "claude-1", command: "claude", worktreePath: "/repo", overseer: true },
        {
          id: "codex-2",
          command: "codex",
          worktreePath: "/repo/.aimux/worktrees/feature-a",
          team: { teamId: "scribe", parentSessionId: "", role: "scribe" },
        },
      ],
      worktreeGroups: [
        { name: "Main Checkout", path: "/repo", count: 1 },
        { name: "feature-a", path: "/repo/.aimux/worktrees/feature-a", count: 1 },
      ],
    },
  },
  100,
  30,
);

recordOverlay(
  overlayCases,
  "demoted scribe restore offer is not project control",
  "buildAgentRestoreConfirmOverlayOutput",
  {
    dashboardAgentRestoreOfferCache: {
      sessionIds: ["claude-1"],
      sessions: [
        {
          id: "claude-1",
          command: "claude",
          worktreePath: "/repo",
          scribe: false,
          team: { teamId: "scribe", parentSessionId: "", role: "scribe" },
        },
      ],
    },
  },
  100,
  30,
);

recordOverlay(overlayCases, "help overlay dashboard-local shortcuts", "buildHelpOverlayOutput", {}, 120, 40);

recordOverlay(
  overlayCases,
  "overseer off state",
  "buildOverseerOverlayOutput",
  {
    dashboardOverseerSessionsCache: [],
    dashboardSessionsCache: [],
    getSelectedDashboardSessionForActions: () => undefined,
  },
  100,
  30,
);

recordOverlay(
  overlayCases,
  "live overseer and selected loop state",
  "buildOverseerOverlayOutput",
  {
    dashboardOverseerSessionsCache: [{ id: "overseer-1", command: "claude", status: "working" }],
    dashboardSessionsCache: [
      { id: "codex-1", command: "codex", status: "working", loop: { active: true, goal: "keep progressing" } },
    ],
    getSelectedDashboardSessionForActions: () => ({
      id: "codex-1",
      command: "codex",
      status: "working",
      loop: { active: true, goal: "keep progressing" },
    }),
  },
  100,
  30,
);

recordOverlay(
  overlayCases,
  "overseer from dashboard view model",
  "buildOverseerOverlayOutput",
  {
    dashboard: {
      viewModel: {
        overseerSessions: [{ id: "overseer-1", command: "claude", status: "ready" }],
      },
    },
    dashboardSessionsCache: [],
    getSelectedDashboardSessionForActions: () => undefined,
  },
  100,
  30,
);

recordOverlay(
  overlayCases,
  "overseer watch instructions",
  "buildOverseerWatchInstructionsOverlayOutput",
  {
    overseerWatchInstructionsTarget: {
      id: "codex-1",
      command: "codex",
      status: "working",
      headline: "ship it",
    },
    overseerWatchInstructionsBuffer: "watch CI",
  },
  100,
  30,
);

function recordSubscreen(cases, name, api, input, render) {
  const output = render();
  cases.push({
    id: `tui-subscreen-renderer-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tui/screens/subscreen-renderers.test.ts",
    api,
    input,
    output: {
      rendered: output,
      visibleText: plain(output),
    },
    inputSha256: hash(input),
  });
}

function renderGraveyardFrame(vm, graveyardIndex = 0) {
  let rendered = "";
  const ctx = {
    getViewportSize: () => ({ cols: 120, rows: 40 }),
    graveyardViewModel: vm,
    graveyardIndex,
    dashboardState: { detailsSidebarVisible: true },
    centerInWidth: (s) => s,
    wrapKeyValue: (k, v) => [`${k ? `${k}: ` : ""}${v ?? ""}`],
    truncatePlain: (s, n) => (s ?? "").slice(0, n),
    basename: (p) => p.split("/").pop(),
    writeFrame: (frame) => {
      rendered = frame;
    },
  };
  subscreen.renderGraveyardScreen(ctx);
  return rendered;
}

function baseGraveyardViewModel() {
  return buildGraveyardViewModel({
    worktrees: [
      {
        path: "/x/test6",
        name: "test6",
        branch: "test6",
        graveyardedAt: ago(8),
        agents: [{ id: "claude-ifc0xo", command: "claude", tool: "claude", backendSessionId: "c64917c2aa" }],
        services: [],
      },
    ],
    agents: [{ id: "codex-mrh12h", command: "codex", tool: "codex", worktreePath: "/x/chat-parser" }],
    lastUsedById: { "claude-ifc0xo": { lastUsedAt: ago(8) } },
  });
}

const subscreenCases = [];
recordSubscreen(
  subscreenCases,
  "graveyard screen cards and dead agent rows",
  "renderGraveyardScreen",
  { now: new Date(FIXED_NOW).toISOString(), graveyardIndex: 0, viewModel: baseGraveyardViewModel() },
  () => renderGraveyardFrame(baseGraveyardViewModel()),
);

const graveyardDetailsVm = buildGraveyardViewModel({
  worktrees: [{ path: "/x/test6", name: "test6", branch: "test6", graveyardedAt: ago(8), agents: [], services: [] }],
  agents: [],
  lastUsedById: {},
});
recordSubscreen(
  subscreenCases,
  "graveyard details include graveyard age",
  "renderGraveyardDetails",
  { now: new Date(FIXED_NOW).toISOString(), width: 60, height: 20, viewModel: graveyardDetailsVm },
  () =>
    subscreen
      .renderGraveyardDetails(
        {
          graveyardViewModel: graveyardDetailsVm,
          graveyardIndex: 0,
          wrapKeyValue: (k, v) => [`${k ? `${k}: ` : ""}${v ?? ""}`],
          basename: (p) => p.split("/").pop(),
        },
        60,
        20,
      )
      .join("\n"),
);

const orphanVm = buildGraveyardViewModel({
  worktrees: [],
  agents: [{ id: "claude-orphan", command: "claude", tool: "claude" }],
  lastUsedById: {},
});
recordSubscreen(
  subscreenCases,
  "orphan agents render as loose selectable rows",
  "renderGraveyardScreen",
  { now: new Date(FIXED_NOW).toISOString(), graveyardIndex: 0, viewModel: orphanVm },
  () => renderGraveyardFrame(orphanVm),
);

recordSubscreen(
  subscreenCases,
  "project screen loading state",
  "renderProjectScreen",
  {
    ctx: {
      projectObservabilityLoaded: false,
      projectObservability: null,
      dashboardState: { detailsSidebarVisible: true },
      viewport: { cols: 120, rows: 40 },
    },
  },
  () => {
    let rendered = "";
    subscreen.renderProjectScreen({
      getViewportSize: () => ({ cols: 120, rows: 40 }),
      projectObservabilityLoaded: false,
      projectObservability: null,
      dashboardState: { detailsSidebarVisible: true },
      centerInWidth: (s) => s,
      writeFrame: (frame) => {
        rendered = frame;
      },
    });
    return rendered;
  },
);

recordSubscreen(
  subscreenCases,
  "library details include selected entry path flash",
  "renderLibraryScreen",
  {
    path: "/repo/.aimux/plans/codex-1.md",
    libraryIndex: 0,
    libraryPathFlash: "/repo/.aimux/plans/codex-1.md",
    viewport: { cols: 120, rows: 40 },
  },
  () => {
    let rendered = "";
    const path = "/repo/.aimux/plans/codex-1.md";
    subscreen.renderLibraryScreen({
      getViewportSize: () => ({ cols: 120, rows: 40 }),
      dashboardState: { detailsSidebarVisible: true },
      libraryEntries: [
        {
          id: "plan:codex-1",
          kind: "plan",
          title: "Codex plan",
          path,
          updatedAt: "2026-06-20T00:00:00.000Z",
          sessionId: "codex-1",
          preview: "# Plan",
        },
      ],
      libraryIndex: 0,
      libraryPathFlash: path,
      centerInWidth: (s) => s,
      wrapKeyValue: (k, v) => [`${k ? `${k}: ` : ""}${v ?? ""}`],
      truncatePlain: (s, n) => (s ?? "").slice(0, n),
      writeFrame: (frame) => {
        rendered = frame;
      },
    });
    return rendered;
  },
);

await writeContractJson(OVERLAY_FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tui-screen-renderer-contracts.mjs",
  source: "src/tui/screens/overlay-renderers.test.ts",
  sources: ["src/tui/screens/overlay-renderers.test.ts", "src/tui/screens/overlay-renderers.ts"],
  subject: "tui screen overlay renderers",
  description: "Raw ANSI and visible text output captured by running TypeScript TUI overlay renderer helpers.",
  caseCount: overlayCases.length,
  cases: overlayCases,
});

await writeContractJson(SUBSCREEN_FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tui-screen-renderer-contracts.mjs",
  source: "src/tui/screens/subscreen-renderers.test.ts",
  sources: [
    "src/tui/screens/subscreen-renderers.test.ts",
    "src/tui/screens/subscreen-renderers.ts",
    "src/multiplexer/graveyard-view-model.ts",
  ],
  subject: "tui subscreen renderers",
  description: "Raw ANSI and visible text output captured by running TypeScript TUI subscreen renderer helpers.",
  caseCount: subscreenCases.length,
  cases: subscreenCases,
});

console.log(`${OVERLAY_FIXTURE_PATH.pathname}: ${overlayCases.length} cases`);
console.log(`${SUBSCREEN_FIXTURE_PATH.pathname}: ${subscreenCases.length} cases`);
