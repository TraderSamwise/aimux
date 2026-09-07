#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/worktrees.json", ROOT);
const {
  beginWorktreeRemoval,
  buildWorktreeInputOverlayOutput,
  finishWorktreeRemoval,
  handleWorktreeCacheCleanupConfirmKey,
  handleWorktreeInputKey,
  handleWorktreeListKey,
  handleWorktreeRemoveConfirmKey,
  renderWorktreeCacheCleanupConfirm,
  renderWorktreeInput,
  renderWorktreeList,
  renderWorktreeRemoveConfirm,
  showWorktreeCreatePrompt,
  showWorktreeCacheCleanupPreview,
  showWorktreeList,
  worktreeSettlePollDelay,
} = await import(new URL("dist/multiplexer/worktrees.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const inputs = [
  {
    name: "holds tight cadence for the first attempts",
    api: "worktreeSettlePollDelay",
    calls: [
      { attempt: 1, baseMs: 250 },
      { attempt: 2, baseMs: 250 },
      { attempt: 1, baseMs: 100 },
      { attempt: 2, baseMs: 100 },
    ],
  },
  {
    name: "decays and caps once settlement drags on",
    api: "worktreeSettlePollDelay",
    calls: [
      { attempt: 3, baseMs: 250 },
      { attempt: 4, baseMs: 250 },
      { attempt: 50, baseMs: 250 },
      { attempt: 50, baseMs: 100 },
    ],
  },
  {
    name: "never returns a busy-spin delay",
    api: "worktreeSettlePollDelay",
    calls: Array.from({ length: 40 }, (_, i) => ({ attempt: i + 1, baseMs: 100 })),
  },
  {
    name: "honors caller cap below the shared maximum",
    api: "worktreeSettlePollDelay",
    calls: Array.from({ length: 40 }, (_, i) => ({ attempt: i + 1, baseMs: 100, maxMs: 350 })),
  },
  {
    name: "never caps below the base delay",
    api: "worktreeSettlePollDelay",
    calls: [{ attempt: 40, baseMs: 250, maxMs: 100 }],
  },
  {
    name: "show worktree create prompt opens overlay and clears input",
    api: "showWorktreeCreatePrompt",
    host: { mode: "dashboard", worktreeInputBuffer: "stale" },
  },
  {
    name: "builds worktree input overlay from the current buffer",
    api: "buildWorktreeInputOverlayOutput",
    cols: 80,
    rows: 24,
    host: { mode: "dashboard", worktreeInputBuffer: "feature/demo" },
  },
  {
    name: "render worktree input redraws dashboard overlays",
    api: "renderWorktreeInput",
    host: { mode: "dashboard", worktreeInputBuffer: "demo" },
  },
  {
    name: "worktree input accepts printable text and backspace",
    api: "handleWorktreeInputKey",
    data: "demo\b",
    host: { mode: "dashboard", worktreeInputBuffer: "" },
  },
  {
    name: "empty worktree submit restores the dashboard",
    api: "handleWorktreeInputKey",
    data: "\r",
    host: { mode: "dashboard", worktreeInputBuffer: "   " },
  },
  {
    name: "non-dashboard worktree submit reports project-service requirement",
    api: "handleWorktreeInputKey",
    data: "\r",
    host: { mode: "session", worktreeInputBuffer: "demo" },
  },
  {
    name: "remove confirm enter starts and fails immediately outside dashboard mode",
    api: "handleWorktreeRemoveConfirmKey",
    data: "\r",
    host: {
      mode: "session",
      worktreeRemoveConfirm: { path: "/repo/.aimux/worktrees/demo", name: "demo" },
      dashboardState: { worktreeNavOrder: ["/repo/.aimux/worktrees/demo"], focusedWorktreePath: "/repo/.aimux/worktrees/demo" },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", name: "demo" }],
    },
  },
  {
    name: "remove confirm n dismisses and restores dashboard",
    api: "handleWorktreeRemoveConfirmKey",
    data: "n",
    host: { mode: "dashboard", worktreeRemoveConfirm: { path: "/repo/.aimux/worktrees/demo", name: "demo" } },
  },
  {
    name: "remove confirm escape dismisses and restores dashboard",
    api: "handleWorktreeRemoveConfirmKey",
    data: "\u001b",
    host: { mode: "dashboard", worktreeRemoveConfirm: { path: "/repo/.aimux/worktrees/demo", name: "demo" } },
  },
  {
    name: "begin removal rejects duplicate active worktree graveyard",
    api: "beginWorktreeRemoval",
    path: "/repo/.aimux/worktrees/demo",
    name: "demo",
    oldIdx: 0,
    host: {
      mode: "dashboard",
      worktreeRemovalJobs: [{ path: "/repo/.aimux/worktrees/demo", name: "demo", oldIdx: 0, stderr: "" }],
      dashboardState: { worktreeNavOrder: ["/repo/.aimux/worktrees/demo"], focusedWorktreePath: "/repo/.aimux/worktrees/demo" },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", name: "demo" }],
    },
  },
  {
    name: "finish successful removal selects the next available worktree",
    api: "finishWorktreeRemoval",
    path: "/repo/.aimux/worktrees/deleted",
    code: 0,
    host: {
      worktreeRemovalJobs: [{ path: "/repo/.aimux/worktrees/deleted", name: "deleted", oldIdx: 1, stderr: "" }],
      dashboardState: {
        worktreeNavOrder: ["/repo", "/repo/.aimux/worktrees/demo"],
        focusedWorktreePath: "/repo/.aimux/worktrees/deleted",
      },
      dashboardWorktreeGroupsCache: [
        { path: "/repo", name: "main" },
        { path: "/repo/.aimux/worktrees/demo", name: "demo" },
      ],
    },
  },
  {
    name: "finish failed removal reports first stderr line with details",
    api: "finishWorktreeRemoval",
    path: "/repo/.aimux/worktrees/demo",
    code: 1,
    host: {
      worktreeRemovalJobs: [
        { path: "/repo/.aimux/worktrees/demo", name: "demo", oldIdx: 0, stderr: "\nfirst failure\nsecond detail\n" },
      ],
      dashboardState: {
        worktreeNavOrder: ["/repo/.aimux/worktrees/demo"],
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
      },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", name: "demo" }],
    },
  },
  {
    name: "finish removal ignores unknown stale completion",
    api: "finishWorktreeRemoval",
    path: "/repo/.aimux/worktrees/missing",
    code: 0,
    host: {
      worktreeRemovalJobs: [{ path: "/repo/.aimux/worktrees/demo", name: "demo", oldIdx: 0, stderr: "" }],
      dashboardState: {
        worktreeNavOrder: ["/repo/.aimux/worktrees/demo"],
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
      },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", name: "demo" }],
    },
  },
  {
    name: "list escape clears overlay and restores dashboard",
    api: "handleWorktreeListKey",
    data: "\u001b",
    host: { mode: "dashboard" },
  },
  {
    name: "show worktree list opens overlay and redraws",
    api: "showWorktreeList",
    host: { mode: "dashboard" },
  },
  {
    name: "render worktree list redraws dashboard overlays",
    api: "renderWorktreeList",
    host: { mode: "dashboard" },
  },
  {
    name: "render worktree remove confirm redraws dashboard overlays",
    api: "renderWorktreeRemoveConfirm",
    host: { mode: "dashboard", worktreeRemoveConfirm: { path: "/repo/.aimux/worktrees/demo", name: "demo" } },
  },
  {
    name: "remove confirm y starts the selected graveyard job",
    api: "handleWorktreeRemoveConfirmKey",
    data: "y",
    host: {
      mode: "session",
      worktreeRemoveConfirm: { path: "/repo/.aimux/worktrees/demo", name: "demo" },
      dashboardState: { worktreeNavOrder: ["/repo/.aimux/worktrees/demo"], focusedWorktreePath: "/repo/.aimux/worktrees/demo" },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", name: "demo" }],
    },
  },
  {
    name: "cache cleanup preview reports project-service requirement outside dashboard mode",
    api: "showWorktreeCacheCleanupPreview",
    host: { mode: "session", dashboardBusyState: null, worktreeCacheCleanupConfirm: null },
  },
  {
    name: "cache cleanup preview does nothing while dashboard is busy",
    api: "showWorktreeCacheCleanupPreview",
    host: {
      mode: "dashboard",
      dashboardBusyState: { title: "Busy", lines: ["  Still working"] },
      worktreeCacheCleanupConfirm: { existing: true },
    },
  },
  {
    name: "render worktree cache cleanup confirm redraws dashboard overlays",
    api: "renderWorktreeCacheCleanupConfirm",
    host: {
      mode: "dashboard",
      worktreeCacheCleanupConfirm: {
        dryRun: true,
        reclaimedBytes: 0,
        plan: { reclaimableBytes: 1024, targets: [{ path: "/repo/.aimux/worktrees/old/node_modules", sizeBytes: 1024 }], skipped: [] },
        results: [{ path: "/repo/.aimux/worktrees/old/node_modules", status: "dry-run", sizeBytes: 1024 }],
      },
    },
  },
  {
    name: "previews worktree cache cleanup through a safe dry-run",
    api: "showWorktreeCacheCleanupPreview",
    postResponse: {
      ok: true,
      result: {
        dryRun: true,
        reclaimedBytes: 0,
        plan: {
          reclaimableBytes: 1024,
          targets: [{ path: "/repo/.aimux/worktrees/old/node_modules", sizeBytes: 1024 }],
          skipped: [],
        },
        results: [{ path: "/repo/.aimux/worktrees/old/node_modules", status: "dry-run", sizeBytes: 1024 }],
      },
    },
    host: { mode: "dashboard", dashboardInputEpoch: 0, dashboardBusyState: null, worktreeCacheCleanupConfirm: null },
  },
  {
    name: "clears cache cleanup busy state when preview completion is stale",
    api: "showWorktreeCacheCleanupPreview",
    afterStartInputEpochDelta: 1,
    postResponse: {
      ok: true,
      result: {
        dryRun: true,
        reclaimedBytes: 0,
        plan: { reclaimableBytes: 0, targets: [], skipped: [] },
        results: [],
      },
    },
    host: { mode: "dashboard", dashboardInputEpoch: 0, dashboardBusyState: null, worktreeCacheCleanupConfirm: null },
  },
  {
    name: "applies confirmed worktree cache cleanup without active worktrees",
    api: "handleWorktreeCacheCleanupConfirmKey",
    data: "\r",
    postResponse: {
      ok: true,
      result: {
        dryRun: false,
        reclaimedBytes: 2048,
        plan: {
          reclaimableBytes: 2048,
          targets: [{ path: "/repo/.aimux/worktrees/old/node_modules", sizeBytes: 2048 }],
          skipped: [],
        },
        results: [{ path: "/repo/.aimux/worktrees/old/node_modules", status: "removed", sizeBytes: 2048 }],
      },
    },
    host: {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      worktreeCacheCleanupConfirm: {
        dryRun: true,
        reclaimedBytes: 0,
        plan: {
          reclaimableBytes: 2048,
          targets: [{ path: "/repo/.aimux/worktrees/old/node_modules", sizeBytes: 2048 }],
          skipped: [],
        },
        results: [{ path: "/repo/.aimux/worktrees/old/node_modules", status: "dry-run", sizeBytes: 2048 }],
      },
    },
  },
  {
    name: "cache cleanup confirm without preview dismisses overlay",
    api: "handleWorktreeCacheCleanupConfirmKey",
    data: "\r",
    host: { mode: "dashboard", worktreeCacheCleanupConfirm: null },
  },
  {
    name: "cache cleanup confirm with no targets dismisses on enter",
    api: "handleWorktreeCacheCleanupConfirmKey",
    data: "\r",
    host: {
      mode: "dashboard",
      worktreeCacheCleanupConfirm: {
        dryRun: true,
        reclaimedBytes: 0,
        plan: { reclaimableBytes: 0, targets: [], skipped: [] },
        results: [],
      },
    },
  },
  {
    name: "cache cleanup confirm cancels target removal on n",
    api: "handleWorktreeCacheCleanupConfirmKey",
    data: "n",
    host: {
      mode: "dashboard",
      worktreeCacheCleanupConfirm: {
        dryRun: true,
        reclaimedBytes: 0,
        plan: {
          reclaimableBytes: 2048,
          targets: [{ path: "/repo/.aimux/worktrees/old/node_modules", sizeBytes: 2048 }],
          skipped: [],
        },
        results: [{ path: "/repo/.aimux/worktrees/old/node_modules", status: "dry-run", sizeBytes: 2048 }],
      },
    },
  },
  {
    name: "cache cleanup apply reports failed removals",
    api: "handleWorktreeCacheCleanupConfirmKey",
    data: "\r",
    postResponse: {
      ok: true,
      result: {
        dryRun: false,
        reclaimedBytes: 1024,
        plan: {
          reclaimableBytes: 4096,
          targets: [
            { path: "/repo/.aimux/worktrees/old/node_modules", sizeBytes: 1024 },
            { path: "/repo/.aimux/worktrees/fail/node_modules", sizeBytes: 3072 },
          ],
          skipped: [],
        },
        results: [
          { path: "/repo/.aimux/worktrees/old/node_modules", status: "removed", sizeBytes: 1024 },
          {
            path: "/repo/.aimux/worktrees/fail/node_modules",
            status: "failed",
            sizeBytes: 3072,
            error: "permission denied",
          },
        ],
      },
    },
    host: {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      worktreeCacheCleanupConfirm: {
        dryRun: true,
        reclaimedBytes: 0,
        plan: {
          reclaimableBytes: 4096,
          targets: [
            { path: "/repo/.aimux/worktrees/old/node_modules", sizeBytes: 1024 },
            { path: "/repo/.aimux/worktrees/fail/node_modules", sizeBytes: 3072 },
          ],
          skipped: [],
        },
        results: [
          { path: "/repo/.aimux/worktrees/old/node_modules", status: "dry-run", sizeBytes: 1024 },
          { path: "/repo/.aimux/worktrees/fail/node_modules", status: "dry-run", sizeBytes: 3072 },
        ],
      },
    },
  },
];

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function run(input) {
  if (input.api === "worktreeSettlePollDelay") {
    return input.calls.map((call) => ({
      ...call,
      delayMs: worktreeSettlePollDelay(call.attempt, call.baseMs, call.maxMs),
    }));
  }
  const { host, calls } = hostFor(structuredClone({ ...(input.host ?? {}), postResponse: input.postResponse }));
  switch (input.api) {
    case "buildWorktreeInputOverlayOutput":
      return buildWorktreeInputOverlayOutput(host, input.cols ?? 80, input.rows ?? 24);
    case "showWorktreeCreatePrompt":
      showWorktreeCreatePrompt(host);
      break;
    case "renderWorktreeInput":
      renderWorktreeInput(host);
      break;
    case "showWorktreeList":
      showWorktreeList(host);
      break;
    case "renderWorktreeList":
      renderWorktreeList(host);
      break;
    case "renderWorktreeRemoveConfirm":
      renderWorktreeRemoveConfirm(host);
      break;
    case "renderWorktreeCacheCleanupConfirm":
      renderWorktreeCacheCleanupConfirm(host);
      break;
    case "handleWorktreeInputKey":
      handleWorktreeInputKey(host, Buffer.from(input.data));
      break;
    case "handleWorktreeRemoveConfirmKey":
      handleWorktreeRemoveConfirmKey(host, Buffer.from(input.data));
      break;
    case "beginWorktreeRemoval":
      beginWorktreeRemoval(host, input.path, input.name, input.oldIdx);
      break;
    case "finishWorktreeRemoval":
      finishWorktreeRemoval(host, input.path, input.code);
      break;
    case "handleWorktreeListKey":
      handleWorktreeListKey(host, Buffer.from(input.data));
      break;
    case "showWorktreeCacheCleanupPreview":
      showWorktreeCacheCleanupPreview(host);
      if (input.afterStartInputEpochDelta) {
        host.dashboardInputEpoch += input.afterStartInputEpochDelta;
      }
      await flushAsyncWork();
      break;
    case "handleWorktreeCacheCleanupConfirmKey":
      handleWorktreeCacheCleanupConfirmKey(host, Buffer.from(input.data));
      await flushAsyncWork();
      break;
    default:
      throw new Error(`unknown api ${input.api}`);
  }
  return snapshotHost(host, calls);
}

function hostFor(initial) {
  const calls = {};
  const fn = (name, impl = () => undefined) => {
    calls[name] = [];
    return (...args) => {
      calls[name].push(args);
      return impl(...args);
    };
  };
  const host = {
    mode: initial.mode ?? "dashboard",
    worktreeInputBuffer: initial.worktreeInputBuffer,
    worktreeRemoveConfirm: initial.worktreeRemoveConfirm ?? null,
    worktreeRemovalJob: null,
    worktreeRemovalJobs: new Map((initial.worktreeRemovalJobs ?? []).map((job) => [job.path, { startedAt: 0, ...job }])),
    worktreeCacheCleanupConfirm: initial.worktreeCacheCleanupConfirm ?? null,
    dashboardBusyState: initial.dashboardBusyState,
    dashboardInputEpoch: initial.dashboardInputEpoch ?? 0,
    dashboardState: initial.dashboardState ?? { worktreeNavOrder: [], focusedWorktreePath: undefined },
    dashboardWorktreeGroupsCache: initial.dashboardWorktreeGroupsCache ?? [],
    openDashboardOverlay: fn("openDashboardOverlay"),
    redrawDashboardWithOverlay: fn("redrawDashboardWithOverlay"),
    clearDashboardOverlay: fn("clearDashboardOverlay"),
    restoreDashboardAfterOverlayDismiss: fn("restoreDashboardAfterOverlayDismiss"),
    showDashboardError: fn("showDashboardError"),
    renderDashboard: fn("renderDashboard"),
    startDashboardBusy: fn("startDashboardBusy", (title, lines) => {
      host.dashboardBusyState = { title, lines };
    }),
    clearDashboardBusy: fn("clearDashboardBusy", () => {
      host.dashboardBusyState = null;
    }),
    postToProjectService: fn("postToProjectService", async () => initial.postResponse),
    dashboardUiStateStore: { markSelectionDirty: fn("dashboardUiStateStore.markSelectionDirty") },
  };
  host.worktreeRemovalJob = [...host.worktreeRemovalJobs.values()].at(-1) ?? null;
  return { host, calls };
}

function snapshotHost(host, calls) {
  return {
    mode: host.mode,
    worktreeInputBuffer: host.worktreeInputBuffer,
    worktreeRemoveConfirm: host.worktreeRemoveConfirm,
    worktreeRemovalJob: host.worktreeRemovalJob,
    worktreeRemovalJobs: [...(host.worktreeRemovalJobs?.values?.() ?? [])],
    worktreeCacheCleanupConfirm: host.worktreeCacheCleanupConfirm,
    dashboardBusyState: host.dashboardBusyState,
    dashboardInputEpoch: host.dashboardInputEpoch,
    dashboardState: host.dashboardState,
    dashboardWorktreeGroupsCache: host.dashboardWorktreeGroupsCache,
    footerFlash: host.footerFlash,
    footerFlashTicks: host.footerFlashTicks,
    calls,
  };
}

const cases = [];
for (let index = 0; index < inputs.length; index += 1) {
  const input = inputs[index];
  cases.push({
  id: `multiplexer-worktrees-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/multiplexer/worktrees.test.ts",
  api: input.api,
  input,
    output: await run(input),
  inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/worktrees.test.ts",
  generatedBy: "scripts/capture-multiplexer-worktrees-contract.mjs",
  description:
    "Multiplexer worktree settle-poll delay and synchronous dashboard worktree input/removal contracts captured by running TypeScript worktrees helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
