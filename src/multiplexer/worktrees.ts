import { getWorktreeCreatePath, listWorktrees as listAllWorktrees } from "../worktree.js";
import { debug } from "../debug.js";
import { parseKeys } from "../key-parser.js";
import {
  buildWorktreeListOverlayOutput,
  buildWorktreeRemoveConfirmOverlayOutput,
} from "../tui/screens/overlay-renderers.js";
import { postToProjectService } from "./dashboard-control.js";
import { DashboardPendingActions } from "../dashboard/pending-actions.js";

type WorktreeHost = any;

interface DashboardWorktreeMutationOptions {
  pendingKey: string;
  pendingAction: "creating" | "removing";
  request: () => Promise<void>;
  settle: () => Promise<boolean>;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

async function waitForRenderedDashboardWorktreeState(
  host: WorktreeHost,
  path: string,
  predicate: (group: any | undefined) => boolean,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await host.refreshDashboardModelFromService(true);
    const group = host.dashboardWorktreeGroupsCache.find((entry: any) => entry.path === path);
    if (predicate(group)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function runDashboardWorktreeMutation(host: WorktreeHost, opts: DashboardWorktreeMutationOptions): Promise<void> {
  host.dashboardPendingActions.set(opts.pendingKey, opts.pendingAction);
  host.renderDashboard();
  try {
    await opts.request();
    await opts.settle();
    host.dashboardPendingActions.set(opts.pendingKey, null);
    opts.onSuccess?.();
  } catch (error) {
    host.dashboardPendingActions.set(opts.pendingKey, null);
    opts.onError?.(error);
  }
}

function sortDashboardWorktrees(worktrees: Array<any>): void {
  worktrees.sort((a, b) => a.name.localeCompare(b.name));
}

function showOptimisticDashboardWorktreeCreate(host: WorktreeHost, name: string): string {
  const targetPath = getWorktreeCreatePath(name);
  const existing = (host.dashboardWorktreeGroupsCache as Array<any>).find((group: any) => group.path === targetPath);
  if (!existing) {
    host.dashboardWorktreeGroupsCache = [
      ...host.dashboardWorktreeGroupsCache,
      {
        name,
        branch: name,
        path: targetPath,
        status: "offline",
        pending: true,
        pendingAction: "creating",
        optimistic: true,
        sessions: [],
        services: [],
      },
    ];
    sortDashboardWorktrees(host.dashboardWorktreeGroupsCache);
  } else {
    existing.pending = true;
    existing.pendingAction = "creating";
    existing.optimistic = true;
  }
  host.dashboardState.focusedWorktreePath = targetPath;
  host.dashboardUiStateStore.markSelectionDirty();
  host.dashboardState.worktreeNavOrder = host.dashboardWorktreeGroupsCache.map((wt: any) => wt.path);
  return targetPath;
}

function removeOptimisticDashboardWorktree(host: WorktreeHost, path: string): void {
  host.dashboardWorktreeGroupsCache = host.dashboardWorktreeGroupsCache.filter((group: any) => group.path !== path);
  host.dashboardState.worktreeNavOrder = host.dashboardWorktreeGroupsCache.map((wt: any) => wt.path);
  if (host.dashboardState.focusedWorktreePath === path) {
    host.dashboardState.focusedWorktreePath = undefined;
  }
  host.dashboardUiStateStore.markSelectionDirty();
}

export function showWorktreeCreatePrompt(host: WorktreeHost): void {
  host.openDashboardOverlay("worktree-input");
  host.worktreeInputBuffer = "";
  renderWorktreeInput(host);
}

export function buildWorktreeInputOverlayOutput(host: WorktreeHost): string {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;

  const lines = ["Create worktree:", "", `  Name: ${host.worktreeInputBuffer}_`, "", "  [Enter] create  [Esc] cancel"];

  const boxWidth = Math.max(...lines.map((l: string) => l.length)) + 4;
  const startRow = Math.floor((rows - lines.length - 2) / 2);
  const startCol = Math.floor((cols - boxWidth) / 2);

  let output = "\x1b7";
  for (let i = 0; i < lines.length + 2; i++) {
    const row = startRow + i;
    output += `\x1b[${row};${startCol}H`;
    if (i === 0 || i === lines.length + 1) {
      output += `\x1b[44;97m${"─".repeat(boxWidth)}\x1b[0m`;
    } else {
      const line = lines[i - 1];
      output += `\x1b[44;97m  ${line.padEnd(boxWidth - 2)}\x1b[0m`;
    }
  }
  output += "\x1b8";
  return output;
}

export function renderWorktreeInput(host: WorktreeHost): void {
  if (host.mode === "dashboard" && typeof host.redrawDashboardWithOverlay === "function") {
    host.redrawDashboardWithOverlay();
    return;
  }
  process.stdout.write(buildWorktreeInputOverlayOutput(host));
}

export function handleWorktreeInputKey(host: WorktreeHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  const event = events[0];
  const key = event.name || event.char;

  if (key === "escape") {
    host.clearDashboardOverlay();
    host.restoreDashboardAfterOverlayDismiss();
    return;
  }

  if (key === "enter" || key === "return") {
    host.clearDashboardOverlay();
    const name = host.worktreeInputBuffer.trim();
    if (name) {
      if (host.mode === "dashboard") {
        const targetPath = showOptimisticDashboardWorktreeCreate(host, name);
        const pendingKey = DashboardPendingActions.worktreeKey(targetPath);
        void runDashboardWorktreeMutation(host, {
          pendingKey,
          pendingAction: "creating",
          request: async () => {
            await postToProjectService(host, "/worktrees/create", { name });
          },
          settle: () => waitForRenderedDashboardWorktreeState(host, targetPath, (group) => Boolean(group)),
          onSuccess: () => {
            debug(`worktree created from UI: ${name}`, "worktree");
            host.settleDashboardCreatePending?.(pendingKey);
          },
          onError: (err) => {
            removeOptimisticDashboardWorktree(host, targetPath);
            debug(`worktree create failed: ${err instanceof Error ? err.message : String(err)}`, "worktree");
            host.showDashboardError(`Failed to create "${name}"`, [err instanceof Error ? err.message : String(err)]);
          },
        });
        return;
      }
      try {
        host.createDesktopWorktree(name);
        debug(`worktree created from UI: ${name}`, "worktree");
      } catch (err) {
        debug(`worktree create failed: ${err instanceof Error ? err.message : String(err)}`, "worktree");
      }
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
  process.stdout.write(buildWorktreeListOverlayOutput(host));
}

export function renderWorktreeRemoveConfirm(host: WorktreeHost): void {
  if (host.mode === "dashboard" && typeof host.redrawDashboardWithOverlay === "function") {
    host.redrawDashboardWithOverlay();
    return;
  }
  const output = buildWorktreeRemoveConfirmOverlayOutput(host);
  if (output) process.stdout.write(output);
}

export function beginWorktreeRemoval(host: WorktreeHost, path: string, name: string, oldIdx: number): void {
  if (host.worktreeRemovalJob?.path === path) return;
  if (host.worktreeRemovalJob && host.worktreeRemovalJob.path !== path) {
    const inFlightName = host.worktreeRemovalJob.name;
    host.footerFlash = `Already removing ${inFlightName}`;
    host.footerFlashTicks = 4;
    host.showDashboardError("Worktree removal already in progress", [
      `Finish removing "${inFlightName}" before removing "${name}".`,
    ]);
    host.renderDashboard();
    return;
  }
  if (host.pendingWorktreeRemovals?.has?.(path)) return;

  debug(`begin worktree removal: name=${name} path=${path}`, "worktree");
  host.worktreeRemovalJob = {
    path,
    name,
    startedAt: Date.now(),
    oldIdx,
    stderr: "",
  };
  host.refreshLocalDashboardModel();
  host.renderDashboard();
  if (host.mode === "dashboard") {
    const pendingKey = DashboardPendingActions.worktreeKey(path);
    void runDashboardWorktreeMutation(host, {
      pendingKey,
      pendingAction: "removing",
      request: async () => {
        await postToProjectService(host, "/worktrees/remove", { path });
      },
      settle: () => waitForRenderedDashboardWorktreeState(host, path, (group) => !group),
      onSuccess: () => {
        debug(`removeDesktopWorktree succeeded: name=${name} path=${path}`, "worktree");
        finishWorktreeRemoval(host, 0);
      },
      onError: (err) => {
        if (host.worktreeRemovalJob) {
          host.worktreeRemovalJob.stderr += `\n${err instanceof Error ? err.message : String(err)}`;
        }
        debug(
          `removeDesktopWorktree failed: name=${name} path=${path} error=${err instanceof Error ? err.message : String(err)}`,
          "worktree",
        );
        finishWorktreeRemoval(host, 1);
      },
    });
    return;
  }
  void (async () => {
    try {
      await host.removeDesktopWorktree(path);
      debug(`removeDesktopWorktree succeeded: name=${name} path=${path}`, "worktree");
      finishWorktreeRemoval(host, 0);
    } catch (err) {
      if (host.worktreeRemovalJob) {
        host.worktreeRemovalJob.stderr += `\n${err instanceof Error ? err.message : String(err)}`;
      }
      debug(
        `removeDesktopWorktree failed: name=${name} path=${path} error=${err instanceof Error ? err.message : String(err)}`,
        "worktree",
      );
      finishWorktreeRemoval(host, 1);
    }
  })();
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
    host.footerFlash = `Removed: ${job.name}`;
    host.footerFlashTicks = 3;
    debug(`removed worktree: ${job.name}`, "worktree");

    const newWorktrees = listAllWorktrees().filter((wt: any) => !wt.isBare);
    host.dashboardState.worktreeNavOrder = newWorktrees.map((wt: any) => wt.path);
    if (job.oldIdx >= 0 && job.oldIdx < host.dashboardState.worktreeNavOrder.length) {
      host.dashboardState.focusedWorktreePath = host.dashboardState.worktreeNavOrder[job.oldIdx];
    } else if (host.dashboardState.worktreeNavOrder.length > 1) {
      host.dashboardState.focusedWorktreePath =
        host.dashboardState.worktreeNavOrder[host.dashboardState.worktreeNavOrder.length - 1];
    } else {
      host.dashboardState.focusedWorktreePath = undefined;
    }
  } else {
    const message = details[0] ?? `git worktree remove exited with code ${code}`;
    host.footerFlash = `Failed: ${message}`;
    host.footerFlashTicks = 5;
    host.showDashboardError(`Failed to remove "${job.name}"`, [`Path: ${job.path}`, `Error: ${message}`, ...details]);
    return;
  }

  host.renderDashboard();
}

export function handleWorktreeRemoveConfirmKey(host: WorktreeHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const key = events[0].name || events[0].char;

  if (key === "y") {
    const confirm = host.worktreeRemoveConfirm;
    if (confirm) {
      host.worktreeRemoveConfirm = null;
      host.clearDashboardOverlay();
      const oldIdx = host.dashboardState.worktreeNavOrder.indexOf(confirm.path);
      beginWorktreeRemoval(host, confirm.path, confirm.name, oldIdx);
      return;
    }
  }

  host.worktreeRemoveConfirm = null;
  host.clearDashboardOverlay();
  host.restoreDashboardAfterOverlayDismiss();
}

export function handleWorktreeListKey(host: WorktreeHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  const event = events[0];
  const key = event.name || event.char;

  if (key === "escape") {
    host.clearDashboardOverlay();
    host.restoreDashboardAfterOverlayDismiss();
  }
}
