const HEARTBEAT_INTERVAL_MS = 5_000;

export class MultiplexerRuntimeSync {
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      cwd: string;
      getMode: () => "dashboard" | "project-service";
      syncSessionsFromTopology: () => void;
      loadOfflineTopologySessions: () => boolean;
      renderCurrentDashboardView: () => void;
      renderDashboard: () => void;
      writeStatuslineFile: () => void;
      refreshRuntimeGuard?: () => void;
    },
  ) {}

  startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      if (this.deps.getMode() === "project-service") {
        return;
      }
      const offlineChanged = this.deps.loadOfflineTopologySessions();
      if (offlineChanged && this.deps.getMode() === "dashboard") {
        this.deps.renderCurrentDashboardView();
      }
      if (this.deps.getMode() === "dashboard") {
        this.deps.refreshRuntimeGuard?.();
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatInterval.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  startProjectServiceRefresh(): void {
    // Kept as a lifecycle hook; explicit repair/restart owns tmux reconciliation.
  }

  stopProjectServiceRefresh(): void {
    // No background project-service timer to stop.
  }
}
