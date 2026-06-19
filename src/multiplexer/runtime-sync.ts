export class MultiplexerRuntimeSync {
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private projectServiceInterval: ReturnType<typeof setInterval> | null = null;

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
        this.deps.syncSessionsFromTopology();
        return;
      }
      const offlineChanged = this.deps.loadOfflineTopologySessions();
      if (offlineChanged && this.deps.getMode() === "dashboard") {
        this.deps.renderCurrentDashboardView();
      }
      if (this.deps.getMode() === "dashboard") {
        this.deps.refreshRuntimeGuard?.();
      }
    }, 5000);
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  startProjectServiceRefresh(): void {
    if (this.projectServiceInterval) return;
    this.projectServiceInterval = setInterval(() => {
      this.deps.syncSessionsFromTopology();
    }, 2000);
  }

  stopProjectServiceRefresh(): void {
    if (this.projectServiceInterval) {
      clearInterval(this.projectServiceInterval);
      this.projectServiceInterval = null;
    }
  }
}
