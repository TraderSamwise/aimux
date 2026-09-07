#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/worktrees-settlement.json", ROOT);
const FIXED_NOW = "2026-06-01T00:00:00.000Z";
const RealDate = Date;
const tmpRoot = mkdtempSync(join(tmpdir(), "aimux-worktrees-settlement-"));
const projectRootPath = join(tmpRoot, "repo");
mkdirSync(projectRootPath, { recursive: true });
const projectRoot = realpathSync.native(projectRootPath);
execFileSync("git", ["init", "-q"], { cwd: projectRoot });
process.chdir(projectRoot);
process.env.AIMUX_HOME = join(tmpRoot, "home");
const projectRealRoot = projectRoot;
const canonicalWorktreeRoot = join(tmpRoot, "canonical-worktrees");
const canonicalLinkRoot = join(projectRoot, ".aimux", "worktrees");
mkdirSync(join(canonicalWorktreeRoot, "demo"), { recursive: true });
mkdirSync(join(projectRoot, ".aimux"), { recursive: true });
symlinkSync(canonicalWorktreeRoot, canonicalLinkRoot, "dir");

globalThis.Date = class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(FIXED_NOW);
    return new RealDate(...args);
  }

  static now() {
    return new RealDate(FIXED_NOW).getTime();
  }

  static parse(value) {
    return RealDate.parse(value);
  }

  static UTC(...args) {
    return RealDate.UTC(...args);
  }
};

const paths = await import(new URL("dist/paths.js", ROOT));
await paths.initPaths(projectRoot);
const { beginWorktreeRemoval, handleWorktreeInputKey, handleWorktreeRemoveConfirmKey } = await import(
  new URL("dist/multiplexer/worktrees.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function normalizeRepo(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return nested
        .replaceAll(canonicalWorktreeRoot, "/canonical-worktrees")
        .replaceAll(projectRealRoot, "/repo")
        .replaceAll(projectRoot, "/repo");
    }),
  );
}

function denormalizeRepo(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return nested.replaceAll("/canonical-worktrees", canonicalWorktreeRoot).replaceAll("/repo", projectRoot);
    }),
  );
}

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function createPendingActionsStore(calls) {
  const state = new Map();
  const seeds = new Map();
  const tokens = new Map();
  let nextToken = 0;
  return {
    state,
    setWorktreeAction(path, value, opts = {}) {
      const key = `worktree:${path ?? "__main__"}`;
      const token = ++nextToken;
      calls.dashboardPendingActionsSetWorktreeAction.push([path, value, clone(opts)]);
      state.set(key, value);
      tokens.set(key, token);
      if (opts.worktreeSeed) seeds.set(key, clone(opts.worktreeSeed));
      return token;
    },
    clearWorktreeAction(path) {
      const key = `worktree:${path ?? "__main__"}`;
      calls.dashboardPendingActionsClearWorktreeAction.push([path]);
      state.set(key, null);
      seeds.delete(key);
      tokens.delete(key);
    },
    clearWorktreeActionIfToken(path, token) {
      const key = `worktree:${path ?? "__main__"}`;
      calls.dashboardPendingActionsClearWorktreeActionIfToken.push([path, token]);
      if (tokens.get(key) !== token) return false;
      state.set(key, null);
      seeds.delete(key);
      tokens.delete(key);
      return true;
    },
    getWorktreeAction(path) {
      calls.dashboardPendingActionsGetWorktreeAction.push([path]);
      return state.get(`worktree:${path ?? "__main__"}`) || undefined;
    },
    applyToWorktrees(worktrees) {
      const seen = new Set(worktrees.map((worktree) => `worktree:${worktree.path ?? "__main__"}`));
      const applied = worktrees.map((worktree) => {
        const value = state.get(`worktree:${worktree.path ?? "__main__"}`);
        if (!value) return worktree;
        return { ...worktree, pending: true, pendingAction: value, optimistic: true };
      });
      for (const [key, seed] of seeds) {
        const value = state.get(key);
        if (!value || seen.has(key)) continue;
        applied.push({ ...clone(seed), pending: true, pendingAction: value, optimistic: true });
      }
      applied.sort((a, b) => {
        if (a.path === undefined) return -1;
        if (b.path === undefined) return 1;
        return Date.parse(b.createdAt ?? "0") - Date.parse(a.createdAt ?? "0");
      });
      return applied;
    },
    snapshot() {
      return [...state.entries()].map(([key, value]) => ({ key, value }));
    },
  };
}

function applyRawWorktrees(host, pending, worktrees) {
  host.dashboardRawWorktreeGroupsCache = clone(worktrees);
  host.dashboardWorktreeGroupsCache = pending.applyToWorktrees(clone(worktrees));
  host.dashboardState.worktreeNavOrder = host.dashboardWorktreeGroupsCache.map((group) => group.path);
}

function scriptedError(step) {
  const error = new Error(step.message);
  Object.assign(error, step.props ?? {});
  return error;
}

function hostFor(input) {
  const calls = {
    clearDashboardOverlay: [],
    restoreDashboardAfterOverlayDismiss: [],
    renderDashboard: [],
    redrawDashboardWithOverlay: [],
    showDashboardError: [],
    refreshDashboardModelFromService: [],
    postToProjectService: [],
    reapplyDashboardPendingActions: [],
    dashboardUiStateStoreMarkSelectionDirty: [],
    dashboardPendingActionsSetWorktreeAction: [],
    dashboardPendingActionsClearWorktreeAction: [],
    dashboardPendingActionsClearWorktreeActionIfToken: [],
    dashboardPendingActionsGetWorktreeAction: [],
  };
  const pending = createPendingActionsStore(calls);
  const postSteps = [...(input.postSteps ?? [{ type: "resolve" }])];
  const refreshSteps = [...(input.refreshSteps ?? [])];
  const host = {
    mode: input.mode ?? "dashboard",
    dashboardInputEpoch: input.dashboardInputEpoch ?? 0,
    dashboardModelServiceRefreshedAt: input.dashboardModelServiceRefreshedAt ?? 0,
    dashboardModelServiceRefreshError: input.dashboardModelServiceRefreshError
      ? scriptedError(input.dashboardModelServiceRefreshError)
      : undefined,
    dashboardWorktreeInitialSettleMs: input.dashboardWorktreeInitialSettleMs,
    dashboardWorktreeStableSettleMs: input.dashboardWorktreeStableSettleMs,
    dashboardWorktreeMutationReconcileMaxMs: input.dashboardWorktreeMutationReconcileMaxMs,
    worktreeInputBuffer: input.worktreeInputBuffer ?? "",
    worktreeRemoveConfirm: input.worktreeRemoveConfirm ?? null,
    worktreeRemovalJob: null,
    worktreeRemovalJobs: new Map(),
    dashboardPendingActions: pending,
    dashboardRawWorktreeGroupsCache: clone(input.dashboardRawWorktreeGroupsCache ?? input.dashboardWorktreeGroupsCache ?? []),
    dashboardWorktreeGroupsCache: clone(input.dashboardWorktreeGroupsCache ?? []),
    dashboardOperationFailuresCache: clone(input.dashboardOperationFailuresCache ?? []),
    dashboardState: clone(input.dashboardState ?? { worktreeNavOrder: [], focusedWorktreePath: undefined }),
    dashboardUiStateStore: {
      markSelectionDirty() {
        calls.dashboardUiStateStoreMarkSelectionDirty.push([]);
      },
    },
    clearDashboardOverlay() {
      calls.clearDashboardOverlay.push([]);
    },
    restoreDashboardAfterOverlayDismiss() {
      calls.restoreDashboardAfterOverlayDismiss.push([]);
    },
    renderDashboard() {
      calls.renderDashboard.push([]);
    },
    redrawDashboardWithOverlay() {
      calls.redrawDashboardWithOverlay.push([]);
    },
    showDashboardError(title, lines) {
      calls.showDashboardError.push([title, clone(lines)]);
    },
    reapplyDashboardPendingActions() {
      calls.reapplyDashboardPendingActions.push([]);
      applyRawWorktrees(host, pending, host.dashboardRawWorktreeGroupsCache ?? []);
    },
    async refreshDashboardModelFromService(force, opts) {
      calls.refreshDashboardModelFromService.push([force, clone(opts ?? null)]);
      const step = refreshSteps.length > 0 ? refreshSteps.shift() : { result: true };
      if (step.error) throw scriptedError(step.error);
      if (step.modelError) host.dashboardModelServiceRefreshError = scriptedError(step.modelError);
      else host.dashboardModelServiceRefreshError = undefined;
      if (step.worktrees) applyRawWorktrees(host, pending, step.worktrees);
      if (typeof step.refreshedAt === "number") host.dashboardModelServiceRefreshedAt = step.refreshedAt;
      return step.result;
    },
    async postToProjectService(path, body, opts) {
      calls.postToProjectService.push([path, clone(body), clone(opts ?? null)]);
      const step = postSteps.length > 0 ? postSteps.shift() : { type: "resolve" };
      if (step.type === "reject") throw scriptedError(step);
      return clone(step.value);
    },
  };
  applyRawWorktrees(host, pending, host.dashboardRawWorktreeGroupsCache);
  return { host, pending, calls };
}

async function flushAsyncWork(turns = 30) {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function snapshot(host, pending, calls) {
  return {
    mode: host.mode,
    dashboardInputEpoch: host.dashboardInputEpoch,
    worktreeInputBuffer: host.worktreeInputBuffer,
    worktreeRemoveConfirm: host.worktreeRemoveConfirm,
    worktreeRemovalJob: host.worktreeRemovalJob,
    worktreeRemovalJobs: [...host.worktreeRemovalJobs.values()],
    dashboardState: host.dashboardState,
    dashboardRawWorktreeGroupsCache: host.dashboardRawWorktreeGroupsCache,
    dashboardWorktreeGroupsCache: host.dashboardWorktreeGroupsCache,
    dashboardOperationFailuresCache: host.dashboardOperationFailuresCache,
    footerFlash: host.footerFlash ?? null,
    footerFlashTicks: host.footerFlashTicks ?? null,
    pendingActions: pending.snapshot(),
    calls,
  };
}

async function run(input) {
  const actualInput = denormalizeRepo(input);
  const { host, pending, calls } = hostFor(actualInput.host ?? {});
  switch (actualInput.api) {
    case "handleWorktreeInputKey":
      handleWorktreeInputKey(host, Buffer.from(actualInput.data));
      break;
    case "beginWorktreeRemoval":
      beginWorktreeRemoval(host, actualInput.path, actualInput.worktreeName ?? actualInput.name, actualInput.oldIdx);
      break;
    case "beginWorktreeRemovals":
      for (const removal of actualInput.removals ?? []) {
        beginWorktreeRemoval(host, removal.path, removal.worktreeName ?? removal.name, removal.oldIdx);
      }
      break;
    case "handleWorktreeRemoveConfirmKey":
      handleWorktreeRemoveConfirmKey(host, Buffer.from(actualInput.data));
      break;
    default:
      throw new Error(`unknown api ${actualInput.api}`);
  }
  if (actualInput.afterInvoke) Object.assign(host, clone(actualInput.afterInvoke));
  for (const action of actualInput.afterInvokeActions ?? []) {
    if (action.type === "setHostField") host[action.field] = clone(action.value);
    if (action.type === "setFocusedWorktreePath") host.dashboardState.focusedWorktreePath = action.path;
    if (action.type === "setPendingWorktreeAction") pending.setWorktreeAction(action.path, action.value);
  }
  if (actualInput.waitMs) await new Promise((resolve) => setTimeout(resolve, actualInput.waitMs));
  await flushAsyncWork(actualInput.flushTurns ?? 100);
  return normalizeRepo(snapshot(host, pending, calls));
}

const realWorktree = {
  name: "demo",
  branch: "demo",
  path: "/repo/.aimux/worktrees/demo",
  sessions: [],
  services: [],
};

const failedWorktree = {
  name: "demo",
  branch: "(failed)",
  path: "/repo/.aimux/worktrees/demo",
  sessions: [],
  services: [],
  operationFailure: {
    targetKind: "worktree",
    operation: "create",
    message: "branch already exists",
    worktreePath: "/repo/.aimux/worktrees/demo",
  },
};

const casesInput = [
  {
    name: "creates a worktree through the project service after the rendered model settles",
    api: "handleWorktreeInputKey",
    data: "\r",
    host: {
      worktreeInputBuffer: "demo",
      refreshSteps: [{ result: true, worktrees: [realWorktree] }, { result: true, worktrees: [realWorktree] }],
    },
  },
  {
    name: "accepts pasted worktree names before submit in the same input chunk",
    api: "handleWorktreeInputKey",
    data: "demo\r",
    host: {
      worktreeInputBuffer: "",
      refreshSteps: [{ result: true, worktrees: [realWorktree] }, { result: true, worktrees: [realWorktree] }],
    },
  },
  {
    name: "clears pending create state without stale UI after leaving the dashboard",
    api: "handleWorktreeInputKey",
    data: "\r",
    afterInvokeActions: [
      { type: "setHostField", field: "mode", value: "session" },
      { type: "setHostField", field: "dashboardInputEpoch", value: 1 },
    ],
    host: {
      worktreeInputBuffer: "demo",
      refreshSteps: [{ result: true, worktrees: [realWorktree] }],
    },
  },
  {
    name: "continues worktree create settlement without stale UI after later dashboard input",
    api: "handleWorktreeInputKey",
    data: "\r",
    afterInvokeActions: [
      { type: "setFocusedWorktreePath", path: "/repo/.aimux/worktrees/other" },
      { type: "setHostField", field: "dashboardInputEpoch", value: 1 },
    ],
    host: {
      worktreeInputBuffer: "demo",
      refreshSteps: [{ result: true, worktrees: [] }, { result: true, worktrees: [realWorktree] }],
    },
  },
  {
    name: "keeps service-projected failed worktree creates visible",
    api: "handleWorktreeInputKey",
    data: "\r",
    host: {
      worktreeInputBuffer: "demo",
      postSteps: [{ type: "reject", message: "branch already exists", props: { status: 422, tuiApiRecoverable: false } }],
      refreshSteps: [{ result: true, worktrees: [failedWorktree] }],
    },
  },
  {
    name: "does not let stale worktree create failures clear a newer same-path pending action",
    api: "handleWorktreeInputKey",
    data: "\r",
    afterInvokeActions: [
      { type: "setPendingWorktreeAction", path: "/repo/.aimux/worktrees/demo", value: "creating" },
    ],
    host: {
      worktreeInputBuffer: "demo",
      postSteps: [{ type: "reject", message: "branch already exists", props: { status: 422, tuiApiRecoverable: false } }],
      refreshSteps: [{ result: true, worktrees: [] }],
    },
  },
  {
    name: "waits for service-projected create failures after overlapping refreshes",
    api: "handleWorktreeInputKey",
    data: "\r",
    waitMs: 700,
    host: {
      worktreeInputBuffer: "demo",
      dashboardModelServiceRefreshedAt: 0,
      refreshSteps: [
        { result: false, refreshedAt: 1 },
        { result: true, worktrees: [failedWorktree] },
      ],
    },
  },
  {
    name: "keeps immediate unprojected worktree create errors transient",
    api: "handleWorktreeInputKey",
    data: "\r",
    host: {
      dashboardModelServiceRefreshError: { message: "offline" },
      worktreeInputBuffer: "demo",
      postSteps: [{ type: "reject", message: "branch already exists", props: { status: 422, tuiApiRecoverable: false } }],
      refreshSteps: [{ result: true, worktrees: [] }],
    },
  },
  {
    name: "settles worktree create when optimistic and rendered paths canonicalize to the same directory",
    api: "handleWorktreeInputKey",
    data: "\r",
    host: {
      worktreeInputBuffer: "demo",
      dashboardModelServiceRefreshedAt: 0,
      refreshSteps: [
        {
          result: true,
          worktrees: [{ ...realWorktree, path: "/canonical-worktrees/demo" }],
        },
      ],
    },
  },
  {
    name: "keeps project-service worktree creates pending while snapshots are temporarily unreachable",
    api: "handleWorktreeInputKey",
    data: "\r",
    waitMs: 700,
    host: {
      worktreeInputBuffer: "demo",
      refreshSteps: [
        { result: false, worktrees: [] },
        { result: false, worktrees: [] },
        { result: true, worktrees: [realWorktree] },
      ],
    },
  },
  {
    name: "moves slow worktree creates into background reconciliation instead of failing",
    api: "handleWorktreeInputKey",
    data: "\r",
    waitMs: 700,
    host: {
      worktreeInputBuffer: "demo",
      dashboardWorktreeInitialSettleMs: 5,
      dashboardWorktreeStableSettleMs: 0,
      dashboardWorktreeMutationReconcileMaxMs: 5000,
      refreshSteps: [
        { result: false, worktrees: [] },
        { result: false, worktrees: [] },
        { result: true, worktrees: [realWorktree] },
      ],
    },
  },
  {
    name: "surfaces unsupported worktree creates without extended reconciliation",
    api: "handleWorktreeInputKey",
    data: "\r",
    host: {
      worktreeInputBuffer: "demo",
      postSteps: [
        {
          type: "reject",
          message: "worktree create not supported by this service",
          props: { status: 501, tuiApiRecoverable: true },
        },
      ],
      refreshSteps: [{ result: true, worktrees: [] }],
    },
  },
  {
    name: "does not show stale worktree create failure after later dashboard input",
    api: "handleWorktreeInputKey",
    data: "\r",
    afterInvoke: { dashboardInputEpoch: 1 },
    host: {
      worktreeInputBuffer: "demo",
      postSteps: [{ type: "reject", message: "branch already exists", props: { status: 422, tuiApiRecoverable: false } }],
      refreshSteps: [{ result: true, worktrees: [failedWorktree] }],
    },
  },
  {
    name: "preserves an existing worktree row after duplicate create errors",
    api: "handleWorktreeInputKey",
    data: "\r",
    host: {
      worktreeInputBuffer: "demo",
      dashboardRawWorktreeGroupsCache: [realWorktree],
      dashboardWorktreeGroupsCache: [realWorktree],
      dashboardState: { worktreeNavOrder: ["/repo/.aimux/worktrees/demo"], focusedWorktreePath: "/repo/.aimux/worktrees/demo" },
      postSteps: [
        {
          type: "reject",
          message: "Worktree \"demo\" already exists",
          props: { status: 422, tuiApiRecoverable: false },
        },
      ],
      refreshSteps: [{ result: true, worktrees: [realWorktree] }],
    },
  },
  {
    name: "surfaces async project-service worktree create failures instead of dropping the pending row",
    api: "handleWorktreeInputKey",
    data: "\r",
    waitMs: 700,
    host: {
      worktreeInputBuffer: "demo",
      dashboardOperationFailuresCache: [],
      refreshSteps: [{ result: true, worktrees: [failedWorktree] }],
    },
  },
  {
    name: "keeps project-service worktree creates pending until the worktree is rendered as real",
    api: "handleWorktreeInputKey",
    data: "\r",
    host: {
      worktreeInputBuffer: "demo",
      refreshSteps: [
        {
          result: true,
          worktrees: [{ ...realWorktree, branch: "(creating)", pending: true, pendingAction: "creating" }],
        },
        { result: true, worktrees: [realWorktree] },
      ],
    },
  },
  {
    name: "accepts a rendered worktree create when the next forced snapshot is unavailable",
    api: "handleWorktreeInputKey",
    data: "\r",
    host: {
      worktreeInputBuffer: "demo",
      refreshSteps: [
        {
          result: true,
          worktrees: [{ ...realWorktree, branch: "(creating)", pending: true, pendingAction: "creating" }],
        },
        { result: false, worktrees: [realWorktree] },
      ],
    },
  },
  {
    name: "places an optimistic worktree using dashboard created-at ordering",
    api: "handleWorktreeInputKey",
    data: "\r",
    flushTurns: 1,
    host: {
      worktreeInputBuffer: "newer",
      dashboardRawWorktreeGroupsCache: [
        { name: "Main Checkout", branch: "master", sessions: [], services: [] },
        {
          name: "older",
          branch: "older",
          path: "/repo/.aimux/worktrees/older",
          createdAt: "2026-05-01T00:00:00.000Z",
          sessions: [],
          services: [],
        },
      ],
      dashboardWorktreeGroupsCache: [
        { name: "Main Checkout", branch: "master", sessions: [], services: [] },
        {
          name: "older",
          branch: "older",
          path: "/repo/.aimux/worktrees/older",
          createdAt: "2026-05-01T00:00:00.000Z",
          sessions: [],
          services: [],
        },
      ],
    },
  },
  {
    name: "clears worktree graveyard pending state when the project service rejects the request",
    api: "beginWorktreeRemoval",
    path: "/repo/.aimux/worktrees/demo",
    worktreeName: "demo",
    oldIdx: 0,
    host: {
      dashboardRawWorktreeGroupsCache: [realWorktree],
      dashboardWorktreeGroupsCache: [realWorktree],
      dashboardState: { worktreeNavOrder: ["/repo/.aimux/worktrees/demo"], focusedWorktreePath: "/repo/.aimux/worktrees/demo" },
      postSteps: [
        {
          type: "reject",
          message: "Cannot graveyard \"demo\" while agent \"codex-1\" is attached",
          props: { status: 500, tuiApiRecoverable: false },
        },
      ],
    },
  },
  {
    name: "treats Enter as confirmation for worktree removal",
    api: "handleWorktreeRemoveConfirmKey",
    data: "\r",
    flushTurns: 1,
    host: {
      worktreeRemoveConfirm: { path: "/repo/.aimux/worktrees/demo", name: "demo" },
      dashboardRawWorktreeGroupsCache: [realWorktree],
      dashboardWorktreeGroupsCache: [realWorktree],
      dashboardState: { worktreeNavOrder: ["/repo/.aimux/worktrees/demo"], focusedWorktreePath: "/repo/.aimux/worktrees/demo" },
    },
  },
  {
    name: "removes a worktree through the project service after the raw group disappears",
    api: "beginWorktreeRemoval",
    path: "/repo/.aimux/worktrees/demo",
    worktreeName: "demo",
    oldIdx: 0,
    host: {
      dashboardWorktreeStableSettleMs: 0,
      dashboardRawWorktreeGroupsCache: [realWorktree],
      dashboardWorktreeGroupsCache: [realWorktree],
      dashboardState: { worktreeNavOrder: ["/repo/.aimux/worktrees/demo"], focusedWorktreePath: "/repo/.aimux/worktrees/demo" },
      refreshSteps: [{ result: true, worktrees: [] }],
    },
  },
  {
    name: "keeps waiting for worktree removal when an API refresh reports an unchanged snapshot",
    api: "beginWorktreeRemoval",
    path: "/repo/.aimux/worktrees/demo",
    worktreeName: "demo",
    oldIdx: 0,
    host: {
      dashboardWorktreeInitialSettleMs: 5,
      dashboardWorktreeStableSettleMs: 0,
      dashboardRawWorktreeGroupsCache: [realWorktree],
      dashboardWorktreeGroupsCache: [realWorktree],
      dashboardState: { worktreeNavOrder: ["/repo/.aimux/worktrees/demo"], focusedWorktreePath: "/repo/.aimux/worktrees/demo" },
      refreshSteps: [
        { result: false, worktrees: [realWorktree] },
        { result: true, worktrees: [] },
      ],
    },
  },
  {
    name: "continues worktree removal settlement after later dashboard input",
    api: "beginWorktreeRemoval",
    path: "/repo/.aimux/worktrees/demo",
    worktreeName: "demo",
    oldIdx: 0,
    afterInvoke: { dashboardInputEpoch: 1 },
    host: {
      dashboardWorktreeStableSettleMs: 0,
      dashboardRawWorktreeGroupsCache: [realWorktree],
      dashboardWorktreeGroupsCache: [realWorktree],
      dashboardState: { worktreeNavOrder: ["/repo/.aimux/worktrees/demo"], focusedWorktreePath: "/repo/.aimux/worktrees/demo" },
      refreshSteps: [{ result: true, worktrees: [] }],
    },
  },
  {
    name: "starts independent worktree removals without serializing through one dashboard job",
    api: "beginWorktreeRemovals",
    removals: [
      { path: "/repo/.aimux/worktrees/first", worktreeName: "first", oldIdx: 0 },
      { path: "/repo/.aimux/worktrees/second", worktreeName: "second", oldIdx: 1 },
    ],
    host: {
      dashboardWorktreeStableSettleMs: 0,
      dashboardRawWorktreeGroupsCache: [
        { name: "first", branch: "first", path: "/repo/.aimux/worktrees/first", sessions: [], services: [] },
        { name: "second", branch: "second", path: "/repo/.aimux/worktrees/second", sessions: [], services: [] },
      ],
      dashboardWorktreeGroupsCache: [
        { name: "first", branch: "first", path: "/repo/.aimux/worktrees/first", sessions: [], services: [] },
        { name: "second", branch: "second", path: "/repo/.aimux/worktrees/second", sessions: [], services: [] },
      ],
      dashboardState: {
        worktreeNavOrder: ["/repo/.aimux/worktrees/first", "/repo/.aimux/worktrees/second"],
        focusedWorktreePath: "/repo/.aimux/worktrees/first",
      },
      refreshSteps: [
        { result: true, worktrees: [] },
        { result: true, worktrees: [] },
      ],
    },
  },
  {
    name: "ignores stale background worktree removal settlement after a newer same-path pending action",
    api: "beginWorktreeRemoval",
    path: "/repo/.aimux/worktrees/demo",
    worktreeName: "demo",
    oldIdx: 0,
    waitMs: 700,
    afterInvokeActions: [{ type: "setPendingWorktreeAction", path: "/repo/.aimux/worktrees/demo", value: "graveyarding" }],
    host: {
      dashboardWorktreeInitialSettleMs: 5,
      dashboardWorktreeStableSettleMs: 0,
      dashboardWorktreeMutationReconcileMaxMs: 5000,
      dashboardRawWorktreeGroupsCache: [realWorktree],
      dashboardWorktreeGroupsCache: [realWorktree],
      dashboardState: { worktreeNavOrder: ["/repo/.aimux/worktrees/demo"], focusedWorktreePath: "/repo/.aimux/worktrees/demo" },
      refreshSteps: [
        { result: true, worktrees: [realWorktree] },
        { result: true, worktrees: [realWorktree] },
        { result: true, worktrees: [] },
      ],
    },
  },
  {
    name: "clears stale background worktree removal jobs without rendering stale success",
    api: "beginWorktreeRemoval",
    path: "/repo/.aimux/worktrees/demo",
    worktreeName: "demo",
    oldIdx: 0,
    waitMs: 700,
    afterInvoke: { mode: "session" },
    host: {
      dashboardWorktreeInitialSettleMs: 5,
      dashboardWorktreeStableSettleMs: 0,
      dashboardWorktreeMutationReconcileMaxMs: 5000,
      dashboardRawWorktreeGroupsCache: [realWorktree],
      dashboardWorktreeGroupsCache: [realWorktree],
      dashboardState: { worktreeNavOrder: ["/repo/.aimux/worktrees/demo"], focusedWorktreePath: "/repo/.aimux/worktrees/demo" },
      refreshSteps: [
        { result: true, worktrees: [realWorktree] },
        { result: true, worktrees: [realWorktree] },
        { result: true, worktrees: [] },
      ],
    },
  },
];

const cases = [];
try {
  for (let index = 0; index < casesInput.length; index += 1) {
    const input = normalizeRepo(casesInput[index]);
    cases.push({
      id: `multiplexer-worktrees-settlement-${String(index + 1).padStart(3, "0")}`,
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
    generatedBy: "scripts/capture-multiplexer-worktrees-settlement-contract.mjs",
    description:
      "Async worktree create and graveyard settlement/action paths captured by running TypeScript worktrees helpers with scripted project-service responses.",
    cases,
  });

  console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
  process.exit(0);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
