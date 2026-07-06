import { realpathSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { getWorktreeCreatePath } from "../worktree.js";
import { debug } from "../debug.js";
import { commandKey, parseKeys, printableInputText } from "../key-parser.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import {
  buildWorktreeListOverlayOutput,
  buildWorktreeRemoveConfirmOverlayOutput,
  hints,
} from "../tui/screens/overlay-renderers.js";
import { renderOverlayBox } from "../tui/render/box.js";
import { style } from "../tui/render/theme.js";
import { postToProjectService as postToProjectServiceTransport } from "./dashboard-control.js";
import type { PendingWorktreeActionKind } from "../pending-actions.js";
import { dashboardCreatedSortKey } from "../dashboard/sort.js";
import { postJsonWithTuiApiRuntime } from "./tui-api-runtime.js";
import type { WorktreeGroup } from "../dashboard/index.js";
import {
  captureDashboardLifecycle,
  isDashboardLifecycleCurrent,
  renderDashboardIfCurrent,
  type DashboardLifecycleToken,
} from "./dashboard-lifecycle.js";
import { refreshDashboardModelThroughApi } from "./dashboard-api-client.js";

type WorktreeHost = any;
type DashboardWorktreeCreateSettleResult =
  | { status: "settled" }
  | { status: "pending" }
  | { status: "failed"; error: Error };

function postWorktreeMutation(
  host: WorktreeHost,
  path: string,
  body: unknown,
  opts?: { timeoutMs?: number },
): Promise<any> {
  return postJsonWithTuiApiRuntime(host, path, body, opts, postToProjectServiceTransport);
}

interface DashboardWorktreeMutationOptions {
  pendingPath: string | undefined;
  pendingAction: PendingWorktreeActionKind;
  worktreeSeed?: WorktreeGroup;
  lifecycle?: DashboardLifecycleToken;
  request: () => Promise<void>;
  settle: (modelLifecycle: DashboardLifecycleToken) => Promise<boolean>;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshDashboardModelForWorktreeSettlement(
  host: WorktreeHost,
  lifecycle?: DashboardLifecycleToken,
): Promise<boolean> {
  return refreshDashboardModelThroughApi(host, { force: true, lifecycle });
}

function findRenderedWorktreeForSettlement(host: WorktreeHost, path: string): any | undefined {
  const raw = Array.isArray(host.dashboardRawWorktreeGroupsCache)
    ? host.dashboardRawWorktreeGroupsCache.find((entry: any) => sameWorktreePath(entry.path, path))
    : undefined;
  if (raw) return raw;
  return host.dashboardWorktreeGroupsCache?.find((entry: any) => sameWorktreePath(entry.path, path));
}

function findRawWorktreeForSettlement(host: WorktreeHost, path: string): any | undefined {
  const groups = Array.isArray(host.dashboardRawWorktreeGroupsCache)
    ? host.dashboardRawWorktreeGroupsCache
    : host.dashboardWorktreeGroupsCache;
  return groups?.find((entry: any) => sameWorktreePath(entry.path, path));
}

function canonicalWorktreePath(path: string | undefined): string | undefined {
  if (!path) return path;
  try {
    return realpathSync.native(path);
  } catch {
    return pathResolve(path);
  }
}

function sameWorktreePath(left: string | undefined, right: string | undefined): boolean {
  return canonicalWorktreePath(left) === canonicalWorktreePath(right);
}

function hasPendingDashboardWorktreeAction(
  host: WorktreeHost,
  path: string | undefined,
  kind: PendingWorktreeActionKind,
): boolean {
  return host.dashboardPendingActions?.getWorktreeAction?.(path) === kind;
}

function clearPendingDashboardWorktreeAction(
  host: WorktreeHost,
  path: string | undefined,
  token: number | undefined,
): boolean {
  if (typeof token === "number") {
    const clearIfToken = host.dashboardPendingActions?.clearWorktreeActionIfToken;
    if (typeof clearIfToken === "function") {
      if (clearIfToken.call(host.dashboardPendingActions, path, token)) {
        host.reapplyDashboardPendingActions?.();
        return true;
      }
      return false;
    }
  }
  host.dashboardPendingActions.clearWorktreeAction(path);
  host.reapplyDashboardPendingActions?.();
  return true;
}

function refreshOptimisticDashboardWorktreeCreate(host: WorktreeHost): void {
  host.reapplyDashboardPendingActions?.();
  if (Array.isArray(host.dashboardWorktreeGroupsCache)) {
    sortDashboardWorktrees(host.dashboardWorktreeGroupsCache);
    host.dashboardState.worktreeNavOrder = host.dashboardWorktreeGroupsCache.map((wt: any) => wt.path);
  }
}

function isRecoverableWorktreeRequestError(error: unknown): boolean {
  const recoverable = (error as { tuiApiRecoverable?: unknown })?.tuiApiRecoverable;
  if (recoverable === true) return true;
  if (recoverable === false) return false;
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  return code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE";
}

async function waitForStableDashboardWorktreeAbsence(
  host: WorktreeHost,
  path: string,
  timeoutMs = 10_000,
  stableMs = 350,
  lifecycle?: DashboardLifecycleToken,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let missingSince: number | null = null;
  while (Date.now() < deadline) {
    const refreshed = await refreshDashboardModelForWorktreeSettlement(host, lifecycle);
    const group = findRawWorktreeForSettlement(host, path);
    if (group) {
      missingSince = null;
    } else if (refreshed || missingSince !== null) {
      missingSince ??= Date.now();
      if (Date.now() - missingSince >= stableMs) return true;
    }
    await sleep(100);
  }
  return false;
}

async function runDashboardWorktreeMutation(host: WorktreeHost, opts: DashboardWorktreeMutationOptions): Promise<void> {
  const lifecycle = opts.lifecycle ?? captureDashboardLifecycle(host);
  const modelLifecycle = captureDashboardLifecycle(host);
  const token = host.dashboardPendingActions.setWorktreeAction(opts.pendingPath, opts.pendingAction, {
    worktreeSeed: opts.worktreeSeed,
  });
  host.reapplyDashboardPendingActions?.();
  renderDashboardIfCurrent(host, lifecycle, () => host.renderDashboard());
  const clearPending = () => clearPendingDashboardWorktreeAction(host, opts.pendingPath, token);
  try {
    await opts.request();
    if (!isDashboardLifecycleCurrent(host, lifecycle)) {
      clearPending();
      return;
    }
    if (!(await opts.settle(modelLifecycle))) {
      scheduleDashboardWorktreeMutationReconcile(host, {
        ...opts,
        modelLifecycle,
        renderLifecycle: lifecycle,
        clearPending,
      });
      return;
    }
    clearPending();
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
    opts.onSuccess?.();
  } catch (error) {
    if (isRecoverableWorktreeRequestError(error)) {
      scheduleDashboardWorktreeMutationReconcile(host, {
        ...opts,
        modelLifecycle,
        renderLifecycle: lifecycle,
        clearPending,
      });
      return;
    }
    clearPending();
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
    opts.onError?.(error);
  }
}

function scheduleDashboardWorktreeMutationReconcile(
  host: WorktreeHost,
  opts: DashboardWorktreeMutationOptions & {
    modelLifecycle: DashboardLifecycleToken;
    renderLifecycle: DashboardLifecycleToken;
    clearPending: () => void;
  },
): void {
  const startedAt = Date.now();
  const maxReconcileMs = host.dashboardWorktreeMutationReconcileMaxMs ?? 60_000;
  if (isDashboardLifecycleCurrent(host, opts.renderLifecycle)) {
    host.footerFlash = `worktree ${opts.pendingAction} is still settling`;
    host.footerFlashTicks = 4;
    host.renderDashboard?.();
  }
  void (async () => {
    while (
      Date.now() - startedAt < maxReconcileMs &&
      hasPendingDashboardWorktreeAction(host, opts.pendingPath, opts.pendingAction)
    ) {
      await sleep(500);
      if (!(await opts.settle(opts.modelLifecycle))) continue;
      opts.clearPending();
      if (!isDashboardLifecycleCurrent(host, opts.renderLifecycle)) return;
      opts.onSuccess?.();
      return;
    }
    if (!hasPendingDashboardWorktreeAction(host, opts.pendingPath, opts.pendingAction)) return;
    opts.clearPending();
    if (!isDashboardLifecycleCurrent(host, opts.renderLifecycle)) return;
    opts.onError?.(
      new Error(
        `worktree ${opts.pendingAction} is still not reflected by the project service after extended reconciliation`,
      ),
    );
  })().catch((error: unknown) => {
    opts.clearPending();
    if (!isDashboardLifecycleCurrent(host, opts.renderLifecycle)) return;
    opts.onError?.(error);
  });
}

function sortDashboardWorktrees(worktrees: Array<any>): void {
  worktrees.sort((a, b) => {
    if (a.path === undefined) return -1;
    if (b.path === undefined) return 1;
    return dashboardCreatedSortKey(b) - dashboardCreatedSortKey(a);
  });
}

function getOptimisticWorktreeCreatedAt(host: WorktreeHost, path: string): string {
  const existing = (host.dashboardWorktreeGroupsCache as Array<any>).find((group: any) => group.path === path);
  if (typeof existing?.createdAt === "string") return existing.createdAt;
  host.dashboardOptimisticWorktreeCreatedAt ??= new Map<string, string>();
  const cached = host.dashboardOptimisticWorktreeCreatedAt.get(path);
  if (cached) return cached;
  const createdAt = new Date().toISOString();
  host.dashboardOptimisticWorktreeCreatedAt.set(path, createdAt);
  return createdAt;
}

function showOptimisticDashboardWorktreeCreate(
  host: WorktreeHost,
  name: string,
): { targetPath: string; token?: number } {
  const targetPath = getWorktreeCreatePath(name);
  const token = host.dashboardPendingActions.setWorktreeAction(targetPath, "creating", {
    worktreeSeed: {
      name,
      branch: name,
      path: targetPath,
      createdAt: getOptimisticWorktreeCreatedAt(host, targetPath),
      status: "offline",
      isBare: false,
      sessions: [],
      services: [],
    },
  });
  host.reapplyDashboardPendingActions?.();
  sortDashboardWorktrees(host.dashboardWorktreeGroupsCache);
  host.dashboardState.focusedWorktreePath = targetPath;
  host.dashboardUiStateStore.markSelectionDirty();
  host.dashboardState.worktreeNavOrder = host.dashboardWorktreeGroupsCache.map((wt: any) => wt.path);
  return { targetPath, token: typeof token === "number" ? token : undefined };
}

function removeOptimisticDashboardWorktree(host: WorktreeHost, path: string): void {
  host.dashboardWorktreeGroupsCache = host.dashboardWorktreeGroupsCache.filter(
    (group: any) =>
      group.path !== path ||
      (group.optimistic !== true && group.pending !== true && group.pendingAction !== "creating"),
  );
  host.dashboardState.worktreeNavOrder = host.dashboardWorktreeGroupsCache.map((wt: any) => wt.path);
  const stillRendered = host.dashboardWorktreeGroupsCache.some((group: any) => group.path === path);
  if (host.dashboardState.focusedWorktreePath === path && !stillRendered) {
    host.dashboardState.focusedWorktreePath = undefined;
  }
  host.dashboardUiStateStore.markSelectionDirty();
}

function showDashboardWorktreeCreateFailure(host: WorktreeHost, name: string, path: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  host.dashboardPendingActions.clearWorktreeAction(path);
  host.dashboardOptimisticWorktreeCreatedAt?.delete?.(path);
  const failure = findDashboardWorktreeCreateFailure(host, path);
  if (!failure) {
    removeOptimisticDashboardWorktree(host, path);
  }
  sortDashboardWorktrees(host.dashboardWorktreeGroupsCache);
  if (failure) {
    host.dashboardState.focusedWorktreePath = path;
  }
  host.dashboardState.worktreeNavOrder = host.dashboardWorktreeGroupsCache.map((wt: any) => wt.path);
  host.dashboardUiStateStore.markSelectionDirty();
  host.showDashboardError(`Failed to create "${name}"`, [`Path: ${path}`, `Error: ${message}`]);
}

function findDashboardWorktreeCreateFailure(host: WorktreeHost, path: string): any | undefined {
  const groupFailure = host.dashboardWorktreeGroupsCache?.find((group: any) =>
    sameWorktreePath(group.path, path),
  )?.operationFailure;
  if (groupFailure) return groupFailure;
  return (host.dashboardOperationFailuresCache ?? []).find(
    (failure: any) =>
      failure.targetKind === "worktree" &&
      failure.operation === "create" &&
      sameWorktreePath(failure.worktreePath, path),
  );
}

function isDashboardWorktreeCreateSettled(group: any | undefined): boolean {
  if (!group) return false;
  if (group.operationFailure) return false;
  return group.pending !== true && group.pendingAction !== "creating";
}

async function waitForRenderedDashboardWorktreeCreate(
  host: WorktreeHost,
  name: string,
  path: string,
  timeoutMs = 180_000,
  modelLifecycle?: DashboardLifecycleToken,
  renderLifecycle?: DashboardLifecycleToken,
): Promise<DashboardWorktreeCreateSettleResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isDashboardLifecycleCurrent(host, modelLifecycle)) {
      return { status: "settled" };
    }
    const existingFailure = findDashboardWorktreeCreateFailure(host, path);
    if (existingFailure) {
      const message = typeof existingFailure.message === "string" ? existingFailure.message : "worktree create failed";
      return { status: "failed", error: new Error(message) };
    }
    if (isDashboardWorktreeCreateSettled(findRenderedWorktreeForSettlement(host, path))) {
      return { status: "settled" };
    }
    if (!(await refreshDashboardModelForWorktreeSettlement(host, modelLifecycle))) {
      const failure = findDashboardWorktreeCreateFailure(host, path);
      if (failure) {
        const message = typeof failure.message === "string" ? failure.message : "worktree create failed";
        return { status: "failed", error: new Error(message) };
      }
      if (isDashboardWorktreeCreateSettled(findRenderedWorktreeForSettlement(host, path))) {
        return { status: "settled" };
      }
      await sleep(250);
      continue;
    }
    const failure = findDashboardWorktreeCreateFailure(host, path);
    if (failure) {
      const message = typeof failure.message === "string" ? failure.message : "worktree create failed";
      return { status: "failed", error: new Error(message) };
    }
    const group = findRenderedWorktreeForSettlement(host, path);
    if (isDashboardWorktreeCreateSettled(group)) {
      return { status: "settled" };
    }
    if (isDashboardLifecycleCurrent(host, renderLifecycle)) {
      refreshOptimisticDashboardWorktreeCreate(host);
      host.renderDashboard?.();
    }
    await sleep(250);
  }
  return { status: "pending" };
}

async function refreshDashboardWorktreeCreateFailure(
  host: WorktreeHost,
  path: string,
  lifecycle?: DashboardLifecycleToken,
): Promise<void> {
  const deadline = Date.now() + 1000;
  for (;;) {
    if (findDashboardWorktreeCreateFailure(host, path)) return;
    if (!(await refreshDashboardModelForWorktreeSettlement(host, lifecycle))) return;
    if (findDashboardWorktreeCreateFailure(host, path) || Date.now() >= deadline) return;
    await sleep(100);
  }
}

async function finishDashboardWorktreeCreateSuccess(
  host: WorktreeHost,
  targetPath: string,
  token: number | undefined,
  settleLifecycle: DashboardLifecycleToken,
  uiLifecycle: DashboardLifecycleToken,
): Promise<void> {
  if (!clearPendingDashboardWorktreeAction(host, targetPath, token)) return;
  host.dashboardOptimisticWorktreeCreatedAt?.delete?.(targetPath);
  await refreshDashboardModelThroughApi(host, { force: true, lifecycle: settleLifecycle });
  if (!isDashboardLifecycleCurrent(host, uiLifecycle) || !isDashboardLifecycleCurrent(host, settleLifecycle)) return;
  host.dashboardState.focusedWorktreePath = targetPath;
  host.dashboardUiStateStore.markSelectionDirty();
  host.renderDashboard();
}

function scheduleDashboardWorktreeCreateReconcile(
  host: WorktreeHost,
  opts: {
    name: string;
    targetPath: string;
    token: number | undefined;
    settleLifecycle: DashboardLifecycleToken;
    uiLifecycle: DashboardLifecycleToken;
  },
): void {
  const startedAt = Date.now();
  const maxReconcileMs = host.dashboardWorktreeMutationReconcileMaxMs ?? 60_000;
  if (isDashboardLifecycleCurrent(host, opts.uiLifecycle)) {
    host.footerFlash = "worktree creating is still settling";
    host.footerFlashTicks = 4;
    host.renderDashboard?.();
  }
  void (async () => {
    while (
      Date.now() - startedAt < maxReconcileMs &&
      hasPendingDashboardWorktreeAction(host, opts.targetPath, "creating")
    ) {
      await sleep(500);
      const result = await waitForRenderedDashboardWorktreeCreate(
        host,
        opts.name,
        opts.targetPath,
        1_000,
        opts.settleLifecycle,
        opts.uiLifecycle,
      );
      if (result.status === "pending") continue;
      if (result.status === "failed") {
        if (!clearPendingDashboardWorktreeAction(host, opts.targetPath, opts.token)) return;
        await refreshDashboardWorktreeCreateFailure(host, opts.targetPath, opts.settleLifecycle);
        if (!isDashboardLifecycleCurrent(host, opts.uiLifecycle)) return;
        showDashboardWorktreeCreateFailure(host, opts.name, opts.targetPath, result.error);
        return;
      }
      debug(`worktree created from UI: ${opts.name}`, "worktree");
      await finishDashboardWorktreeCreateSuccess(
        host,
        opts.targetPath,
        opts.token,
        opts.settleLifecycle,
        opts.uiLifecycle,
      );
      return;
    }
    if (!hasPendingDashboardWorktreeAction(host, opts.targetPath, "creating")) return;
    if (!clearPendingDashboardWorktreeAction(host, opts.targetPath, opts.token)) return;
    await refreshDashboardWorktreeCreateFailure(host, opts.targetPath, opts.settleLifecycle);
    if (!isDashboardLifecycleCurrent(host, opts.uiLifecycle)) return;
    showDashboardWorktreeCreateFailure(
      host,
      opts.name,
      opts.targetPath,
      new Error("worktree creating is still not reflected by the project service after extended reconciliation"),
    );
  })().catch(async (error: unknown) => {
    if (!clearPendingDashboardWorktreeAction(host, opts.targetPath, opts.token)) return;
    await refreshDashboardWorktreeCreateFailure(host, opts.targetPath, opts.settleLifecycle);
    if (!isDashboardLifecycleCurrent(host, opts.uiLifecycle)) return;
    showDashboardWorktreeCreateFailure(host, opts.name, opts.targetPath, error);
  });
}

export function showWorktreeCreatePrompt(host: WorktreeHost): void {
  host.openDashboardOverlay("worktree-input");
  host.worktreeInputBuffer = "";
  renderWorktreeInput(host);
}

export function buildWorktreeInputOverlayOutput(host: WorktreeHost, cols: number, rows: number): string {
  const body = [
    `  ${style("Name:", "muted")} ${host.worktreeInputBuffer}_`,
    "",
    hints([
      ["Enter", "create"],
      ["Esc", "cancel"],
    ]),
  ];
  return renderOverlayBox({ title: "Create worktree", body, cols, rows });
}

export function renderWorktreeInput(host: WorktreeHost): void {
  if (host.mode === "dashboard" && typeof host.redrawDashboardWithOverlay === "function") {
    host.redrawDashboardWithOverlay();
    return;
  }
  const { cols, rows } = host.getViewportSize();
  process.stdout.write(buildWorktreeInputOverlayOutput(host, cols, rows));
}

export function handleWorktreeInputKey(host: WorktreeHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  for (const event of events) {
    const key = commandKey(event);

    if (key === "escape") {
      host.clearDashboardOverlay();
      host.restoreDashboardAfterOverlayDismiss();
      return;
    }

    if (key === "enter" || key === "return") {
      host.clearDashboardOverlay();
      const name = host.worktreeInputBuffer.trim();
      if (name) {
        if (host.mode !== "dashboard") {
          host.showDashboardError("Failed to create worktree", ["Worktree creation requires the project service."]);
          return;
        }
        const { targetPath, token } = showOptimisticDashboardWorktreeCreate(host, name);
        const settleLifecycle = captureDashboardLifecycle(host);
        const uiLifecycle = captureDashboardLifecycle(host, { inputEpoch: true });
        host.renderDashboard();
        void (async () => {
          try {
            await postWorktreeMutation(
              host,
              PROJECT_API_ROUTES.worktreeActions.create,
              {
                name,
              },
              { timeoutMs: 180_000 },
            );
            const result = await waitForRenderedDashboardWorktreeCreate(
              host,
              name,
              targetPath,
              host.dashboardWorktreeInitialSettleMs ?? 10_000,
              settleLifecycle,
              uiLifecycle,
            );
            if (result.status === "pending") {
              scheduleDashboardWorktreeCreateReconcile(host, { name, targetPath, token, settleLifecycle, uiLifecycle });
              return;
            }
            if (result.status === "failed") {
              throw result.error;
            }
            debug(`worktree created from UI: ${name}`, "worktree");
            await finishDashboardWorktreeCreateSuccess(host, targetPath, token, settleLifecycle, uiLifecycle);
          } catch (err) {
            if (isRecoverableWorktreeRequestError(err)) {
              scheduleDashboardWorktreeCreateReconcile(host, { name, targetPath, token, settleLifecycle, uiLifecycle });
              return;
            }
            if (!clearPendingDashboardWorktreeAction(host, targetPath, token)) return;
            host.dashboardOptimisticWorktreeCreatedAt?.delete?.(targetPath);
            debug(`worktree create failed: ${err instanceof Error ? err.message : String(err)}`, "worktree");
            await refreshDashboardWorktreeCreateFailure(host, targetPath, settleLifecycle);
            if (!isDashboardLifecycleCurrent(host, uiLifecycle) || !isDashboardLifecycleCurrent(host, settleLifecycle))
              return;
            showDashboardWorktreeCreateFailure(host, name, targetPath, err);
          }
        })();
        return;
      }
      host.restoreDashboardAfterOverlayDismiss();
      return;
    }

    if (key === "backspace" || key === "delete") {
      host.worktreeInputBuffer = host.worktreeInputBuffer.slice(0, -1);
      renderWorktreeInput(host);
      continue;
    }

    const text = printableInputText(event);
    if (text) {
      host.worktreeInputBuffer += text;
      renderWorktreeInput(host);
    }
  }
}

export function showWorktreeList(host: WorktreeHost): void {
  host.openDashboardOverlay("worktree-list");
  renderWorktreeList(host);
}

export function renderWorktreeList(host: WorktreeHost): void {
  if (host.mode === "dashboard" && typeof host.redrawDashboardWithOverlay === "function") {
    host.redrawDashboardWithOverlay();
    return;
  }
  const { cols, rows } = host.getViewportSize();
  process.stdout.write(buildWorktreeListOverlayOutput(host, cols, rows));
}

export function renderWorktreeRemoveConfirm(host: WorktreeHost): void {
  if (host.mode === "dashboard" && typeof host.redrawDashboardWithOverlay === "function") {
    host.redrawDashboardWithOverlay();
    return;
  }
  const { cols, rows } = host.getViewportSize();
  const output = buildWorktreeRemoveConfirmOverlayOutput(host, cols, rows);
  if (output) process.stdout.write(output);
}

export function beginWorktreeRemoval(host: WorktreeHost, path: string, name: string, oldIdx: number): void {
  if (host.worktreeRemovalJob?.path === path) return;
  if (host.worktreeRemovalJob && host.worktreeRemovalJob.path !== path) {
    const inFlightName = host.worktreeRemovalJob.name;
    host.footerFlash = `Already graveyarding ${inFlightName}`;
    host.footerFlashTicks = 4;
    host.showDashboardError("Worktree graveyard already in progress", [
      `Finish graveyarding "${inFlightName}" before graveyarding "${name}".`,
    ]);
    host.renderDashboard();
    return;
  }
  debug(`begin worktree graveyard: name=${name} path=${path}`, "worktree");
  host.worktreeRemovalJob = {
    path,
    name,
    startedAt: Date.now(),
    oldIdx,
    stderr: "",
  };
  if (host.mode !== "dashboard") {
    host.worktreeRemovalJob.stderr = "Worktree graveyard requires the project service.";
    finishWorktreeRemoval(host, 1);
    return;
  }
  const uiLifecycle = captureDashboardLifecycle(host);
  void runDashboardWorktreeMutation(host, {
    pendingPath: path,
    pendingAction: "graveyarding",
    worktreeSeed: host.dashboardWorktreeGroupsCache?.find((group: any) => sameWorktreePath(group.path, path)),
    lifecycle: uiLifecycle,
    request: async () => {
      await postWorktreeMutation(host, PROJECT_API_ROUTES.worktreeActions.graveyard, { path }, { timeoutMs: 180_000 });
    },
    settle: (lifecycle) => waitForStableDashboardWorktreeAbsence(host, path, 10_000, 350, lifecycle),
    onSuccess: () => {
      debug(`graveyardDesktopWorktree succeeded: name=${name} path=${path}`, "worktree");
      finishWorktreeRemoval(host, 0);
    },
    onError: (err) => {
      if (host.worktreeRemovalJob) {
        host.worktreeRemovalJob.stderr += `\n${err instanceof Error ? err.message : String(err)}`;
      }
      debug(
        `graveyardDesktopWorktree failed: name=${name} path=${path} error=${err instanceof Error ? err.message : String(err)}`,
        "worktree",
      );
      finishWorktreeRemoval(host, 1);
    },
  }).finally(() => {
    if (!isDashboardLifecycleCurrent(host, uiLifecycle) && host.worktreeRemovalJob?.path === path) {
      host.worktreeRemovalJob = null;
    }
  });
}

export function finishWorktreeRemoval(host: WorktreeHost, code: number): void {
  const job = host.worktreeRemovalJob;
  if (!job) return;

  host.worktreeRemovalJob = null;
  const details = job.stderr
    .split("\n")
    .map((line: string) => line.trim())
    .filter(Boolean);

  if (code === 0) {
    host.footerFlash = `Graveyarded: ${job.name}`;
    host.footerFlashTicks = 3;
    debug(`graveyarded worktree: ${job.name}`, "worktree");

    host.dashboardState.worktreeNavOrder = host.dashboardWorktreeGroupsCache.map((wt: any) => wt.path);
    if (job.oldIdx >= 0 && job.oldIdx < host.dashboardState.worktreeNavOrder.length) {
      host.dashboardState.focusedWorktreePath = host.dashboardState.worktreeNavOrder[job.oldIdx];
    } else if (host.dashboardState.worktreeNavOrder.length > 0) {
      host.dashboardState.focusedWorktreePath =
        host.dashboardState.worktreeNavOrder[host.dashboardState.worktreeNavOrder.length - 1];
    } else {
      host.dashboardState.focusedWorktreePath = undefined;
    }
  } else {
    const message = details[0] ?? `worktree graveyard failed with code ${code}`;
    host.footerFlash = `Failed: ${message}`;
    host.footerFlashTicks = 5;
    host.showDashboardError(`Failed to graveyard "${job.name}"`, [
      `Path: ${job.path}`,
      `Error: ${message}`,
      ...details,
    ]);
    host.renderDashboard();
    return;
  }

  host.renderDashboard();
}

export function handleWorktreeRemoveConfirmKey(host: WorktreeHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const key = commandKey(events[0]);

  if (key === "y" || key === "enter" || key === "return") {
    const confirm = host.worktreeRemoveConfirm;
    if (confirm) {
      host.worktreeRemoveConfirm = null;
      host.clearDashboardOverlay();
      const oldIdx = host.dashboardState.worktreeNavOrder.indexOf(confirm.path);
      beginWorktreeRemoval(host, confirm.path, confirm.name, oldIdx);
      return;
    }
  }

  if (key === "n" || key === "escape") {
    host.worktreeRemoveConfirm = null;
    host.clearDashboardOverlay();
    host.restoreDashboardAfterOverlayDismiss();
  }
}

export function handleWorktreeListKey(host: WorktreeHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  const event = events[0];
  const key = commandKey(event);

  if (key === "escape") {
    host.clearDashboardOverlay();
    host.restoreDashboardAfterOverlayDismiss();
  }
}
