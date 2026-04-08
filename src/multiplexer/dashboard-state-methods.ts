import type { DashboardService, DashboardSession, WorktreeGroup } from "../dashboard.js";
import { openDashboardTarget } from "../dashboard-targets.js";
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
import type { TmuxTarget } from "../tmux-runtime-manager.js";

export const dashboardStateMethods = {
  isTmuxBackend(this: any): boolean {
    return true;
  },

  openTmuxDashboardTarget(this: any): void {
    openDashboardTarget(this.projectRoot, this.tmuxRuntimeManager);
  },

  invalidateDashboardFrame(this: any): void {
    this.lastRenderedFrame = null;
  },

  isFocusInReport(this: any, data: Buffer): boolean {
    return data.includes(Buffer.from("\x1b[I"));
  },

  handleDashboardFocusIn(this: any): void {
    this.terminalHost.enterAlternateScreen();
    if (this.lastRenderedFrame) {
      process.stdout.write(this.lastRenderedFrame);
    }
    this.tmuxRuntimeManager.refreshStatus();
  },

  loadDashboardUiState(this: any): void {
    this.dashboardUiStateStore.loadInto(this.dashboardState);
  },

  persistDashboardUiState(this: any): void {
    this.dashboardUiStateStore.persist(this.mode, this.dashboardState, this.activeIndex, this.getDashboardSessions());
  },

  restoreDashboardSelectionFromPreference(this: any, dashSessions: DashboardSession[], hasWorktrees: boolean): void {
    this.dashboardUiStateStore.consumeSelectionRestore(
      this.dashboardState,
      dashSessions,
      hasWorktrees,
      () => this.updateWorktreeSessions(),
      this.activeIndex,
      (value: number) => {
        this.activeIndex = value;
      },
    );
  },

  writeFrame(this: any, output: string, force = false): void {
    if (!force && this.lastRenderedFrame === output) return;
    process.stdout.write(output);
    this.lastRenderedFrame = output;
  },

  getViewportSize(this: any): { cols: number; rows: number } {
    let cols = process.stdout.columns ?? 80;
    let rows = process.stdout.rows ?? 24;

    try {
      const paneRaw = this.tmuxRuntimeManager.displayMessage("#{pane_width}\t#{pane_height}");
      if (paneRaw) {
        const [tmuxColsRaw, tmuxRowsRaw] = paneRaw.split("\t");
        const tmuxCols = Number(tmuxColsRaw);
        const tmuxRows = Number(tmuxRowsRaw);
        if (Number.isFinite(tmuxCols) && tmuxCols > 0) cols = tmuxCols;
        if (Number.isFinite(tmuxRows) && tmuxRows > 0) rows = tmuxRows;
      } else {
        const clientRaw = this.tmuxRuntimeManager.displayMessage("#{client_width}\t#{client_height}");
        if (clientRaw) {
          const [tmuxColsRaw, tmuxRowsRaw] = clientRaw.split("\t");
          const tmuxCols = Number(tmuxColsRaw);
          const tmuxRows = Number(tmuxRowsRaw);
          if (Number.isFinite(tmuxCols) && tmuxCols > 0) cols = tmuxCols;
          if (Number.isFinite(tmuxRows) && tmuxRows > 0) rows = tmuxRows;
        }
      }
    } catch {}

    if (typeof process.stdout.getWindowSize === "function") {
      try {
        const [ttyCols, ttyRows] = process.stdout.getWindowSize();
        if (Number.isFinite(ttyCols) && ttyCols > cols) cols = ttyCols;
        if (Number.isFinite(ttyRows) && ttyRows > rows) rows = ttyRows;
      } catch {}
    }

    return { cols, rows };
  },

  restoreDashboardAfterOverlayDismiss(this: any): void {
    this.invalidateDashboardFrame();
    if (this.mode === "dashboard") {
      this.renderDashboard();
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
