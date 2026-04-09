import { createWorktree, listWorktrees as listAllWorktrees } from "../worktree.js";
import { debug } from "../debug.js";
import { parseKeys } from "../key-parser.js";
import { renderWorktreeListOverlay, renderWorktreeRemoveConfirmOverlay } from "../tui/screens/overlay-renderers.js";

type WorktreeHost = any;

export function showWorktreeCreatePrompt(host: WorktreeHost): void {
  host.worktreeInputActive = true;
  host.worktreeInputBuffer = "";
  renderWorktreeInput(host);
}

export function renderWorktreeInput(host: WorktreeHost): void {
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
  process.stdout.write(output);
}

export function handleWorktreeInputKey(host: WorktreeHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  const event = events[0];
  const key = event.name || event.char;

  if (key === "escape") {
    host.worktreeInputActive = false;
    if (host.mode === "dashboard") {
      host.renderDashboard();
    } else {
      host.focusSession(host.activeIndex);
    }
    return;
  }

  if (key === "enter" || key === "return") {
    host.worktreeInputActive = false;
    const name = host.worktreeInputBuffer.trim();
    if (name) {
      try {
        createWorktree(name);
        debug(`worktree created from UI: ${name}`, "worktree");
      } catch (err) {
        debug(`worktree create failed: ${err instanceof Error ? err.message : String(err)}`, "worktree");
      }
    }
    if (host.mode === "dashboard") {
      host.renderDashboard();
    } else {
      host.focusSession(host.activeIndex);
    }
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
  host.worktreeListActive = true;
  renderWorktreeList(host);
}

export function renderWorktreeList(host: WorktreeHost): void {
  renderWorktreeListOverlay(host);
}

export function renderWorktreeRemoveConfirm(host: WorktreeHost): void {
  renderWorktreeRemoveConfirmOverlay(host);
}

export function beginWorktreeRemoval(host: WorktreeHost, path: string, name: string, oldIdx: number): void {
  if (host.worktreeRemovalJob?.path === path) return;
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
    host.dashboardState.worktreeNavOrder = [undefined, ...newWorktrees.map((wt: any) => wt.path)];
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
      const oldIdx = host.dashboardState.worktreeNavOrder.indexOf(confirm.path);
      beginWorktreeRemoval(host, confirm.path, confirm.name, oldIdx);
      return;
    }
  }

  host.worktreeRemoveConfirm = null;
  host.restoreDashboardAfterOverlayDismiss();
}

export function handleWorktreeListKey(host: WorktreeHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  const event = events[0];
  const key = event.name || event.char;

  if (key === "escape") {
    host.worktreeListActive = false;
    host.restoreDashboardAfterOverlayDismiss();
  }
}
