import {
  closeNotificationPanel as closeNotificationPanelImpl,
  handleNotificationPanelKey as handleNotificationPanelKeyImpl,
  showNotificationPanel as showNotificationPanelImpl,
} from "./notifications.js";
import {
  beginWorktreeRemoval as beginWorktreeRemovalImpl,
  finishWorktreeRemoval as finishWorktreeRemovalImpl,
  handleWorktreeInputKey as handleWorktreeInputKeyImpl,
  handleWorktreeRemoveConfirmKey as handleWorktreeRemoveConfirmKeyImpl,
  handleWorktreeListKey as handleWorktreeListKeyImpl,
  renderWorktreeInput as renderWorktreeInputImpl,
  renderWorktreeList as renderWorktreeListImpl,
  renderWorktreeRemoveConfirm as renderWorktreeRemoveConfirmImpl,
  showWorktreeCreatePrompt as showWorktreeCreatePromptImpl,
  showWorktreeList as showWorktreeListImpl,
} from "./worktrees.js";
import {
  createService as createServiceImpl,
  removeOfflineService as removeOfflineServiceImpl,
  resumeOfflineService as resumeOfflineServiceImpl,
  resumeOfflineServiceById as resumeOfflineServiceByIdImpl,
  serviceLabelForCommand as serviceLabelForCommandImpl,
  stopService as stopServiceImpl,
} from "./services.js";
import {
  renderDashboardBusyOverlay,
  renderDashboardErrorOverlay,
  renderLabelInputOverlay,
  renderNotificationPanel,
  renderServiceInputOverlay,
} from "../tui/screens/overlay-renderers.js";

export const dashboardViewMethods = {
  serviceLabelForCommand(this: any, commandLine: string): string {
    return serviceLabelForCommandImpl(commandLine);
  },

  generateDashboardSessionId(this: any, command: string): string {
    return `${command}-${Math.random().toString(36).slice(2, 8)}`;
  },

  settleDashboardCreatePending(this: any, itemId: string): void {
    if (!(this.startedInDashboard && this.mode === "dashboard")) return;
    this.dashboardPendingActions.settleCreatePending(itemId, () => {
      this.refreshLocalDashboardModel();
      this.renderDashboard();
    });
  },

  preferDashboardEntrySelection(this: any, kind: "session" | "service", id: string, worktreePath?: string): void {
    if (!(this.startedInDashboard && this.mode === "dashboard")) return;
    this.dashboardUiStateStore.preferEntrySelection(this.dashboardState, kind, id, worktreePath);
  },

  createService(this: any, commandLine: string, worktreePath?: string): { serviceId: string } {
    return createServiceImpl(this, commandLine, worktreePath);
  },

  stopService(this: any, serviceId: string): { serviceId: string; status: "stopped" } {
    return stopServiceImpl(this, serviceId);
  },

  removeOfflineService(this: any, serviceId: string): { serviceId: string; status: "removed" } {
    return removeOfflineServiceImpl(this, serviceId);
  },

  resumeOfflineService(this: any, service: any): { serviceId: string; status: "running" } {
    return resumeOfflineServiceImpl(this, service);
  },

  resumeOfflineServiceById(this: any, serviceId: string): { serviceId: string; status: "running" } {
    return resumeOfflineServiceByIdImpl(this, serviceId);
  },

  renderDashboard(this: any): void {
    const renderOptions = this.dashboardRenderOptions ?? null;
    this.dashboardRenderOptions = null;

    try {
      if (!renderOptions?.skipStatusline) {
        this.writeStatuslineFile();
      }

      const { cols, rows } = renderOptions?.fastViewport
        ? {
            cols: process.stdout.columns ?? 80,
            rows: process.stdout.rows ?? 24,
          }
        : this.getViewportSize();
      const dashSessions = this.dashboardSessionsCache;
      const dashServices = this.dashboardServicesCache;
      const worktreeGroups = this.dashboardWorktreeGroupsCache;
      const mainCheckoutInfo = this.dashboardMainCheckoutInfoCache;

      const hasWorktrees = worktreeGroups.length > 0;
      this.dashboardState.worktreeNavOrder = [undefined, ...worktreeGroups.map((wt: any) => wt.path)];
      if (!this.dashboardState.worktreeNavOrder.includes(this.dashboardState.focusedWorktreePath)) {
        this.dashboardState.focusedWorktreePath = undefined;
        this.dashboardUiStateStore.markSelectionDirty();
      }
      this.restoreDashboardSelectionFromPreference(dashSessions, hasWorktrees);

      let selectedSession: string | undefined;
      let selectedService: string | undefined;

      if (hasWorktrees && this.dashboardState.level === "sessions" && this.dashboardState.worktreeEntries.length > 0) {
        const selectedEntry = this.dashboardState.worktreeEntries[this.dashboardState.sessionIndex];
        if (selectedEntry?.kind === "session") selectedSession = selectedEntry.id;
        if (selectedEntry?.kind === "service") selectedService = selectedEntry.id;
      } else if (!hasWorktrees && dashSessions.length > 0) {
        selectedSession = dashSessions[this.activeIndex]?.id;
      }

      this.dashboard.update(
        dashSessions,
        dashServices,
        worktreeGroups,
        this.dashboardState.focusedWorktreePath,
        hasWorktrees ? this.dashboardState.level : "sessions",
        selectedSession,
        selectedService,
        "tmux",
        mainCheckoutInfo,
        this.worktreeRemovalJob
          ? {
              path: this.worktreeRemovalJob.path,
              name: this.worktreeRemovalJob.name,
              startedAt: this.worktreeRemovalJob.startedAt,
              stderr: this.worktreeRemovalJob.stderr,
            }
          : undefined,
      );
      this.syncTuiNotificationContext(Boolean(this.notificationPanelState));
      this.writeFrame(this.dashboard.render(cols, rows));
      if (!renderOptions?.skipPersist) {
        this.persistDashboardUiState();
      }
      if (this.dashboardBusyState) {
        this.renderDashboardBusyOverlay();
      } else if (this.dashboardErrorState) {
        this.renderDashboardErrorOverlay();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dashboardFeedback.clearBusy();
      this.dashboardFeedback.errorState = {
        title: "Dashboard render failed",
        lines: [message],
      };
      this.lastRenderedFrame = "\x1b[2J\x1b[H";
      process.stdout.write(this.lastRenderedFrame);
      try {
        this.renderDashboardErrorOverlay();
      } catch {}
    }
  },

  showWorktreeCreatePrompt(this: any): void {
    showWorktreeCreatePromptImpl(this);
  },

  showServiceCreatePrompt(this: any): void {
    this.serviceInputActive = true;
    this.serviceInputBuffer = "";
    this.renderServiceInput();
  },

  renderWorktreeInput(this: any): void {
    renderWorktreeInputImpl(this);
  },

  renderServiceInput(this: any): void {
    renderServiceInputOverlay(this);
  },

  handleWorktreeInputKey(this: any, data: Buffer): void {
    handleWorktreeInputKeyImpl(this, data);
  },

  renderLabelInput(this: any): void {
    renderLabelInputOverlay(this);
  },

  showWorktreeList(this: any): void {
    showWorktreeListImpl(this);
  },

  renderWorktreeList(this: any): void {
    renderWorktreeListImpl(this);
  },

  renderWorktreeRemoveConfirm(this: any): void {
    renderWorktreeRemoveConfirmImpl(this);
  },

  renderDashboardBusyOverlay(this: any): void {
    renderDashboardBusyOverlay(this);
  },

  renderDashboardErrorOverlay(this: any): void {
    renderDashboardErrorOverlay(this);
  },

  showNotificationPanel(this: any): void {
    showNotificationPanelImpl(this);
  },

  closeNotificationPanel(this: any): void {
    closeNotificationPanelImpl(this);
  },

  renderNotificationPanel(this: any): void {
    renderNotificationPanel(this);
  },

  handleNotificationPanelKey(this: any, data: Buffer): void {
    handleNotificationPanelKeyImpl(this, data);
  },

  startDashboardBusy(this: any, title: string, lines: string[]): void {
    this.dashboardFeedback.startBusy(title, lines);
  },

  updateDashboardBusy(this: any, lines: string[]): void {
    this.dashboardFeedback.updateBusy(lines);
  },

  clearDashboardBusy(this: any): void {
    this.dashboardFeedback.clearBusy();
  },

  showDashboardError(this: any, title: string, lines: string[]): void {
    this.dashboardFeedback.showError(title, lines);
  },

  dismissDashboardError(this: any): void {
    this.dashboardFeedback.dismissError();
    this.restoreDashboardAfterOverlayDismiss();
  },

  beginWorktreeRemoval(this: any, path: string, name: string, oldIdx: number): void {
    beginWorktreeRemovalImpl(this, path, name, oldIdx);
  },

  finishWorktreeRemoval(this: any, code: number): void {
    finishWorktreeRemovalImpl(this, code);
  },

  handleWorktreeRemoveConfirmKey(this: any, data: Buffer): void {
    handleWorktreeRemoveConfirmKeyImpl(this, data);
  },

  handleWorktreeListKey(this: any, data: Buffer): void {
    handleWorktreeListKeyImpl(this, data);
  },
};

export type DashboardViewMethods = typeof dashboardViewMethods;
