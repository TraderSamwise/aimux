import { getWorktreeCreatePath } from "../worktree.js";
import { debug } from "../debug.js";
import { commandKey, parseKeys } from "../key-parser.js";
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
import {
  captureDashboardLifecycle,
  isDashboardLifecycleCurrent,
  renderDashboardIfCurrent,
  type DashboardLifecycleToken,
} from "./dashboard-lifecycle.js";

type WorktreeHost = any;

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
  lifecycle?: DashboardLifecycleToken;
  request: () => Promise<void>;
  settle: () => Promise<boolean>;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

function assertDashboardWorktreeMutationSettled(settled: boolean, action: PendingWorktreeActionKind): void {
  if (!settled) {
    throw new Error(`worktree ${action} did not settle before timing out`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshDashboardModelForWorktreeSettlement(host: WorktreeHost): Promise<boolean> {
  if (typeof host.refreshDashboardModelFromService !== "function") return false;
  const beforeRefresh = host.dashboardModelServiceRefreshedAt ?? 0;
  const result = await host.refreshDashboardModelFromService(true);
  if (host.dashboardModelServiceRefreshError) return false;
  return result !== false || (host.dashboardModelServiceRefreshedAt ?? 0) > beforeRefresh;
}

function findRenderedWorktreeForSettlement(host: WorktreeHost, path: string): any | undefined {
  const raw = Array.isArray(host.dashboardRawWorktreeGroupsCache)
    ? host.dashboardRawWorktreeGroupsCache.find((entry: any) => entry.path === path)
    : undefined;
  if (raw) return raw;
  return host.dashboardWorktreeGroupsCache.find((entry: any) => entry.path === path);
}

async function waitForRenderedDashboardWorktreeState(
  host: WorktreeHost,
  path: string,
  predicate: (group: any | undefined) => boolean,
  timeoutMs = 10_000,
  lifecycle?: DashboardLifecycleToken,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lifecycle && !isDashboardLifecycleCurrent(host, lifecycle)) return false;
    if (!(await refreshDashboardModelForWorktreeSettlement(host))) return false;
    const group = findRenderedWorktreeForSettlement(host, path);
    if (predicate(group)) return true;
    await sleep(100);
  }
  return false;
}

async function runDashboardWorktreeMutation(host: WorktreeHost, opts: DashboardWorktreeMutationOptions): Promise<void> {
  const lifecycle = opts.lifecycle ?? captureDashboardLifecycle(host, { inputEpoch: true });
  host.dashboardPendingActions.setWorktreeAction(opts.pendingPath, opts.pendingAction);
  host.reapplyDashboardPendingActions?.();
  renderDashboardIfCurrent(host, lifecycle, () => host.renderDashboard());
  try {
    await opts.request();
    assertDashboardWorktreeMutationSettled(await opts.settle(), opts.pendingAction);
    host.dashboardPendingActions.clearWorktreeAction(opts.pendingPath);
    host.reapplyDashboardPendingActions?.();
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
    opts.onSuccess?.();
  } catch (error) {
    host.dashboardPendingActions.clearWorktreeAction(opts.pendingPath);
    host.reapplyDashboardPendingActions?.();
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
    opts.onError?.(error);
  }
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

function showOptimisticDashboardWorktreeCreate(host: WorktreeHost, name: string): string {
  const targetPath = getWorktreeCreatePath(name);
  host.dashboardPendingActions.setWorktreeAction(targetPath, "creating", {
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
  return targetPath;
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
  const groupFailure = host.dashboardWorktreeGroupsCache?.find((group: any) => group.path === path)?.operationFailure;
  if (groupFailure) return groupFailure;
  return (host.dashboardOperationFailuresCache ?? []).find(
    (failure: any) =>
      failure.targetKind === "worktree" && failure.operation === "create" && failure.worktreePath === path,
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
  lifecycle?: DashboardLifecycleToken,
): Promise<{ ok: true } | { ok: false; error: Error }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lifecycle && !isDashboardLifecycleCurrent(host, lifecycle)) {
      return { ok: false, error: new Error("dashboard no longer active") };
    }
    if (typeof host.refreshDashboardModelFromService === "function") {
      if (!(await refreshDashboardModelForWorktreeSettlement(host))) {
        return { ok: false, error: new Error("project service snapshot unavailable") };
      }
    }
    const failure = findDashboardWorktreeCreateFailure(host, path);
    if (failure) {
      const message = typeof failure.message === "string" ? failure.message : "worktree create failed";
      return { ok: false, error: new Error(message) };
    }
    const group = findRenderedWorktreeForSettlement(host, path);
    if (isDashboardWorktreeCreateSettled(group)) {
      return { ok: true };
    }
    showOptimisticDashboardWorktreeCreate(host, name);
    renderDashboardIfCurrent(host, lifecycle, () => host.renderDashboard?.());
    await sleep(250);
  }
  return { ok: false, error: new Error("worktree creating did not settle before timing out") };
}

async function refreshDashboardWorktreeCreateFailure(host: WorktreeHost, path: string): Promise<void> {
  if (typeof host.refreshDashboardModelFromService !== "function") return;
  const deadline = Date.now() + 1000;
  for (;;) {
    if (findDashboardWorktreeCreateFailure(host, path)) return;
    if (!(await refreshDashboardModelForWorktreeSettlement(host))) return;
    if (findDashboardWorktreeCreateFailure(host, path) || Date.now() >= deadline) return;
    await sleep(100);
  }
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

  const event = events[0];
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
      const targetPath = showOptimisticDashboardWorktreeCreate(host, name);
      const lifecycle = captureDashboardLifecycle(host, { inputEpoch: true });
      host.renderDashboard();
      void (async () => {
        try {
          await postWorktreeMutation(host, PROJECT_API_ROUTES.worktreeActions.create, { name }, { timeoutMs: 180_000 });
          const result = await waitForRenderedDashboardWorktreeCreate(host, name, targetPath, 180_000, lifecycle);
          if (!result.ok) {
            throw result.error;
          }
          debug(`worktree created from UI: ${name}`, "worktree");
          host.dashboardPendingActions.clearWorktreeAction(targetPath);
          host.reapplyDashboardPendingActions?.();
          host.dashboardOptimisticWorktreeCreatedAt?.delete?.(targetPath);
          await host.refreshDashboardModelFromService?.(true);
          if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
          host.dashboardState.focusedWorktreePath = targetPath;
          host.dashboardUiStateStore.markSelectionDirty();
          host.renderDashboard();
        } catch (err) {
          host.dashboardPendingActions.clearWorktreeAction(targetPath);
          host.reapplyDashboardPendingActions?.();
          host.dashboardOptimisticWorktreeCreatedAt?.delete?.(targetPath);
          debug(`worktree create failed: ${err instanceof Error ? err.message : String(err)}`, "worktree");
          await refreshDashboardWorktreeCreateFailure(host, targetPath);
          if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
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
    return;
  }

  if (event.char && event.char.length === 1 && !event.ctrl && !event.alt) {
    host.worktreeInputBuffer += event.char;
    renderWorktreeInput(host);
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
  const lifecycle = captureDashboardLifecycle(host, { inputEpoch: true });
  void runDashboardWorktreeMutation(host, {
    pendingPath: path,
    pendingAction: "graveyarding",
    lifecycle,
    request: async () => {
      await postWorktreeMutation(host, PROJECT_API_ROUTES.worktreeActions.graveyard, { path }, { timeoutMs: 180_000 });
    },
    settle: () => waitForRenderedDashboardWorktreeState(host, path, (group) => !group, 10_000, lifecycle),
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
    if (!isDashboardLifecycleCurrent(host, lifecycle) && host.worktreeRemovalJob?.path === path) {
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
