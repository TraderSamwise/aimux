import type { InstanceDirectory } from "../instance-directory.js";

export class MultiplexerRuntimeSync {
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private projectServiceInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      instanceDirectory: InstanceDirectory;
      instanceId: string;
      cwd: string;
      getMode: () => "dashboard" | "project-service";
      getConfirmedRegistered: () => Set<string>;
      setConfirmedRegistered: (value: Set<string>) => void;
      syncSessionsFromTopology: () => void;
      loadOfflineTopologySessions: () => boolean;
      renderCurrentDashboardView: () => void;
      renderDashboard: () => void;
      writeStatuslineFile: () => void;
    },
  ) {}

  startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      if (this.deps.getMode() === "project-service") {
        this.deps.syncSessionsFromTopology();
        return;
      }
      this.deps.instanceDirectory
        .reconcileHeartbeat(this.deps.instanceId, [], this.deps.cwd, this.deps.getConfirmedRegistered())
        .then((result) => {
          this.deps.setConfirmedRegistered(result.confirmedIds);
        })
        .catch(() => {});

      const offlineChanged = this.deps.loadOfflineTopologySessions();
      if (offlineChanged && this.deps.getMode() === "dashboard") {
        this.deps.renderCurrentDashboardView();
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
