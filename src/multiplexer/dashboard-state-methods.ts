import type { DashboardService, DashboardSession, WorktreeGroup } from "../dashboard/index.js";
import { openDashboardTarget } from "../dashboard/targets.js";
import {
  applyDashboardModel as applyDashboardModelImpl,
  buildDashboardWorktreeGroups as buildDashboardWorktreeGroupsImpl,
  buildDesktopStateSnapshot as buildDesktopStateSnapshotImpl,
  computeDashboardServices as computeDashboardServicesImpl,
  computeDashboardSessions as computeDashboardSessionsImpl,
  invalidateDesktopStateSnapshot as invalidateDesktopStateSnapshotImpl,
  readTmuxProcessInfo as readTmuxProcessInfoImpl,
  refreshDashboardModelFromService as refreshDashboardModelFromServiceImpl,
  refreshDesktopStateSnapshot as refreshDesktopStateSnapshotImpl,
  refreshLocalDashboardModel as refreshLocalDashboardModelImpl,
  startProjectServices as startProjectServicesImpl,
} from "./dashboard-model.js";
import { hydrateDashboardArchiveScreenState } from "./archives.js";
import { hydrateDashboardNotificationScreenState } from "./notifications.js";
import type { TmuxTarget } from "../tmux/runtime-manager.js";

export const dashboardStateMethods = {
  isTmuxBackend(this: any): boolean {
    return true;
  },

  openTmuxDashboardTarget(this: any): void {
    openDashboardTarget(this.projectRoot, this.tmuxRuntimeManager);
  },

  invalidateDashboardFrame(this: any): void {
    this.lastRenderedFrame = null;
    this.lastRenderedBaseFrame = null;
    this.lastRenderedFrameKey = null;
  },

  getDashboardViewportTarget(this: any): string | null {
    const paneId = process.env.TMUX_PANE?.trim();
    return paneId || null;
  },

  getViewportKey(this: any): string {
    const { cols, rows } = this.getViewportSize();
    return `${cols}x${rows}`;
  },

  isFocusInReport(this: any, data: Buffer): boolean {
    return data.includes(Buffer.from("\x1b[I"));
  },

  handleDashboardFocusIn(this: any): void {
    this.loadDashboardUiState();
    this.hydrateDashboardScreenState?.();
    this.writeDashboardClientStatuslineFile();
    this.terminalHost.enterAlternateScreen();
    this.invalidateDashboardFrame();
    this.renderCurrentDashboardView();
    this.tmuxRuntimeManager.refreshStatus();
  },

  loadDashboardUiState(this: any): void {
    this.dashboardUiStateStore.loadInto(this.dashboardState, this.getDashboardUiClientKey());
  },

  hydrateDashboardScreenState(this: any): void {
    hydrateDashboardArchiveScreenState(this);
    hydrateDashboardNotificationScreenState(this);
  },

  persistDashboardUiState(this: any): void {
    this.dashboardUiStateStore.persist(
      this.mode,
      this.getDashboardUiClientKey(),
      this.dashboardState,
      this.activeIndex,
      this.getDashboardSessions(),
    );
  },

  getDashboardUiClientKey(this: any): string {
    try {
      const sessionName = this.tmuxRuntimeManager?.currentClientSession?.()?.trim();
      if (sessionName) return sessionName.replace(/[^a-zA-Z0-9._-]/g, "_");
    } catch {}
    const paneId = process.env.TMUX_PANE?.trim();
    if (paneId) return `pane-${paneId.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    return "standalone";
  },

  isDashboardOverlay(this: any, kind: string): boolean {
    return this.dashboardOverlayState.is(kind);
  },

  openDashboardOverlay(this: any, kind: string): void {
    this.dashboardOverlayState.open(kind);
  },

  clearDashboardOverlay(this: any): void {
    this.dashboardOverlayState.clear();
  },

  reconcileDashboardRenderState(this: any): void {
    const dashSessions = this.dashboardSessionsCache;
    const worktreeGroups = this.dashboardWorktreeGroupsCache;
    const hasWorktrees = worktreeGroups.length > 0;

    this.dashboardState.worktreeNavOrder = worktreeGroups.map((wt: any) => wt.path);
    if (!this.dashboardState.worktreeNavOrder.includes(this.dashboardState.focusedWorktreePath)) {
      this.dashboardState.focusedWorktreePath = undefined;
      this.dashboardUiStateStore.markSelectionDirty();
    }
    if (hasWorktrees) {
      this.updateWorktreeSessions();
    }
    this.restoreDashboardSelectionFromPreference(dashSessions, hasWorktrees);
  },

  restoreDashboardSelectionFromPreference(this: any, dashSessions: DashboardSession[], hasWorktrees: boolean): void {
    this.dashboardUiStateStore.consumeSelectionRestore(
      this.dashboardState,
      dashSessions,
      hasWorktrees,
      this.activeIndex,
      (value: number) => {
        this.activeIndex = value;
      },
    );
  },

  writeFrame(this: any, output: string, force = false): void {
    if (this.mode === "dashboard") {
      this.lastRenderedBaseFrame = output;
      const overlayOutput = this.buildActiveDashboardOverlayOutput?.() ?? null;
      const finalOutput = overlayOutput ? `${output}${overlayOutput}` : output;
      const renderKey = [
        this.getViewportKey(),
        `model:${this.dashboardModelVersion ?? 0}`,
        `pending:${this.dashboardPendingActions.getVersion?.() ?? 0}`,
        `overlay:${this.dashboardOverlayState.version ?? 0}`,
        `ui:${this.dashboardState.renderStateKey?.() ?? ""}`,
      ].join("|");
      if (!force && this.lastRenderedFrameKey === renderKey && this.lastRenderedFrame === finalOutput) return;
      process.stdout.write(`\x1b[H\x1b[J${finalOutput}`);
      this.lastRenderedFrame = finalOutput;
      this.lastRenderedFrameKey = renderKey;
      return;
    }
    if (!force && this.lastRenderedFrame === output) return;
    process.stdout.write(output);
    this.lastRenderedFrame = output;
  },

  redrawDashboardWithOverlay(this: any, force = true): void {
    if (this.mode !== "dashboard") {
      this.renderCurrentDashboardView();
      return;
    }
    const base = this.lastRenderedBaseFrame ?? this.lastRenderedFrame;
    if (!base) {
      this.renderCurrentDashboardView();
      return;
    }
    this.writeFrame(base, force);
  },

  getViewportSize(this: any): { cols: number; rows: number } {
    const target = this.getDashboardViewportTarget();

    try {
      const paneRaw = target ? this.tmuxRuntimeManager.displayMessage("#{pane_width}\t#{pane_height}", target) : null;
      if (paneRaw) {
        const [tmuxColsRaw, tmuxRowsRaw] = paneRaw.split("\t");
        const tmuxCols = Number(tmuxColsRaw);
        const tmuxRows = Number(tmuxRowsRaw);
        if (Number.isFinite(tmuxCols) && tmuxCols > 0 && Number.isFinite(tmuxRows) && tmuxRows > 0) {
          const size = { cols: tmuxCols, rows: tmuxRows };
          const previous = this.dashboardLastViewportSize;
          if (previous) {
            const expands = size.cols > previous.cols || size.rows > previous.rows;
            if (expands) {
              const samePending =
                this.dashboardPendingExpandedViewportSize &&
                this.dashboardPendingExpandedViewportSize.cols === size.cols &&
                this.dashboardPendingExpandedViewportSize.rows === size.rows;
              this.dashboardPendingExpandedViewportSize = size;
              this.dashboardPendingExpandedViewportCount = samePending
                ? this.dashboardPendingExpandedViewportCount + 1
                : 1;
              if (this.dashboardPendingExpandedViewportCount < 2) {
                return previous;
              }
            } else {
              this.dashboardPendingExpandedViewportSize = null;
              this.dashboardPendingExpandedViewportCount = 0;
            }
          }
          this.dashboardLastViewportSize = size;
          this.dashboardPendingExpandedViewportSize = null;
          this.dashboardPendingExpandedViewportCount = 0;
          return size;
        }
      }
    } catch {}

    if (target && this.dashboardLastViewportSize) {
      return this.dashboardLastViewportSize;
    }

    let cols = process.stdout.columns ?? 0;
    let rows = process.stdout.rows ?? 0;

    if (typeof process.stdout.getWindowSize === "function") {
      try {
        const [ttyCols, ttyRows] = process.stdout.getWindowSize();
        if (Number.isFinite(ttyCols) && ttyCols > 0) cols = ttyCols;
        if (Number.isFinite(ttyRows) && ttyRows > 0) rows = ttyRows;
      } catch {}
    }

    if (!(Number.isFinite(cols) && cols > 0)) cols = 80;
    if (!(Number.isFinite(rows) && rows > 0)) rows = 24;

    const size = { cols, rows };
    this.dashboardLastViewportSize = size;
    return size;
  },

  restoreDashboardAfterOverlayDismiss(this: any): void {
    this.invalidateDashboardFrame();
    if (this.mode === "dashboard") {
      this.renderCurrentDashboardView();
    } else {
      this.focusSession(this.activeIndex);
    }
  },

  buildDashboardWorktreeGroups(
    this: any,
    dashSessions: DashboardSession[],
    dashServices: DashboardService[],
    worktrees: Array<{ name: string; path: string; branch: string; isBare: boolean }>,
    mainRepoPath?: string,
  ): WorktreeGroup[] {
    return buildDashboardWorktreeGroupsImpl(this, dashSessions, dashServices, worktrees, mainRepoPath);
  },

  applyDashboardModel(
    this: any,
    dashSessions: DashboardSession[],
    dashServices: DashboardService[],
    worktreeGroups: WorktreeGroup[],
    mainCheckoutInfo: { name: string; branch: string },
  ): boolean {
    return applyDashboardModelImpl(this, dashSessions, dashServices, worktreeGroups, mainCheckoutInfo);
  },

  invalidateDesktopStateSnapshot(this: any): void {
    invalidateDesktopStateSnapshotImpl(this);
  },

  refreshDesktopStateSnapshot(this: any): void {
    refreshDesktopStateSnapshotImpl(this);
  },

  computeDashboardSessions(this: any): DashboardSession[] {
    return computeDashboardSessionsImpl(this);
  },

  computeDashboardServices(this: any, worktrees = this.listDesktopWorktrees()): DashboardService[] {
    return computeDashboardServicesImpl(this, worktrees);
  },

  readTmuxProcessInfo(this: any, target: TmuxTarget): { command?: string; pid?: number; previewLine?: string } {
    return readTmuxProcessInfoImpl(this, target);
  },

  buildDesktopStateSnapshot(this: any): {
    sessions: DashboardSession[];
    services: DashboardService[];
    worktrees: Array<{ name: string; path: string; branch: string; isBare: boolean }>;
    mainCheckoutInfo: { name: string; branch: string };
    mainCheckoutPath?: string;
  } {
    return buildDesktopStateSnapshotImpl(this);
  },

  async refreshDashboardModelFromService(this: any, force = false): Promise<boolean> {
    return refreshDashboardModelFromServiceImpl(this, force);
  },

  refreshLocalDashboardModel(this: any): void {
    refreshLocalDashboardModelImpl(this);
  },

  async startProjectServices(this: any): Promise<void> {
    await startProjectServicesImpl(this);
  },
};

export type DashboardStateMethods = typeof dashboardStateMethods;
