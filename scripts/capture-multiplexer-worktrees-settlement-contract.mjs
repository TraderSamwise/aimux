#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
      return nested.replaceAll(projectRealRoot, "/repo").replaceAll(projectRoot, "/repo");
    }),
  );
}

function denormalizeRepo(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return nested.replaceAll("/repo", projectRoot);
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
      beginWorktreeRemoval(host, actualInput.path, actualInput.name, actualInput.oldIdx);
      break;
    case "handleWorktreeRemoveConfirmKey":
      handleWorktreeRemoveConfirmKey(host, Buffer.from(actualInput.data));
      break;
    default:
      throw new Error(`unknown api ${actualInput.api}`);
  }
  if (actualInput.afterInvoke) Object.assign(host, clone(actualInput.afterInvoke));
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
    name: "demo",
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
