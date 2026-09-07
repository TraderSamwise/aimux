#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/worktrees.json", ROOT);
const {
  beginWorktreeRemoval,
  finishWorktreeRemoval,
  handleWorktreeInputKey,
  handleWorktreeListKey,
  handleWorktreeRemoveConfirmKey,
  showWorktreeCreatePrompt,
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
    name: "remove confirm escape dismisses and restores dashboard",
    api: "handleWorktreeRemoveConfirmKey",
    data: "\u001b",
    host: { mode: "dashboard", worktreeRemoveConfirm: { path: "/repo/.aimux/worktrees/demo", name: "demo" } },
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
    name: "list escape clears overlay and restores dashboard",
    api: "handleWorktreeListKey",
    data: "\u001b",
    host: { mode: "dashboard" },
  },
];

function run(input) {
  if (input.api === "worktreeSettlePollDelay") {
    return input.calls.map((call) => ({
      ...call,
      delayMs: worktreeSettlePollDelay(call.attempt, call.baseMs, call.maxMs),
    }));
  }
  const { host, calls } = hostFor(structuredClone(input.host ?? {}));
  switch (input.api) {
    case "showWorktreeCreatePrompt":
      showWorktreeCreatePrompt(host);
      break;
    case "handleWorktreeInputKey":
      handleWorktreeInputKey(host, Buffer.from(input.data));
      break;
    case "handleWorktreeRemoveConfirmKey":
      handleWorktreeRemoveConfirmKey(host, Buffer.from(input.data));
      break;
    case "finishWorktreeRemoval":
      finishWorktreeRemoval(host, input.path, input.code);
      break;
    case "handleWorktreeListKey":
      handleWorktreeListKey(host, Buffer.from(input.data));
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
    dashboardState: initial.dashboardState ?? { worktreeNavOrder: [], focusedWorktreePath: undefined },
    dashboardWorktreeGroupsCache: initial.dashboardWorktreeGroupsCache ?? [],
    openDashboardOverlay: fn("openDashboardOverlay"),
    redrawDashboardWithOverlay: fn("redrawDashboardWithOverlay"),
    clearDashboardOverlay: fn("clearDashboardOverlay"),
    restoreDashboardAfterOverlayDismiss: fn("restoreDashboardAfterOverlayDismiss"),
    showDashboardError: fn("showDashboardError"),
    renderDashboard: fn("renderDashboard"),
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
    dashboardState: host.dashboardState,
    dashboardWorktreeGroupsCache: host.dashboardWorktreeGroupsCache,
    footerFlash: host.footerFlash,
    footerFlashTicks: host.footerFlashTicks,
    calls,
  };
}

const cases = inputs.map((input, index) => ({
  id: `multiplexer-worktrees-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/multiplexer/worktrees.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/worktrees.test.ts",
  generatedBy: "scripts/capture-multiplexer-worktrees-contract.mjs",
  description:
    "Multiplexer worktree settle-poll delay and synchronous dashboard worktree input/removal contracts captured by running TypeScript worktrees helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
