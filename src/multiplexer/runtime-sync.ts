import type { InstanceDirectory } from "../instance-directory.js";
import type { InstanceSessionRef } from "../instance-registry.js";

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
      getInstanceSessionRefs: () => InstanceSessionRef[];
      syncSessionsFromState: () => void;
      loadOfflineSessions: () => boolean;
      renderCurrentDashboardView: () => void;
      renderDashboard: () => void;
      handleSessionClaimed: (sessionId: string) => void;
      writeStatuslineFile: () => void;
    },
  ) {}

  startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      if (this.deps.getMode() === "project-service") {
        this.deps.syncSessionsFromState();
        return;
      }
      let dashboardNeedsRender = false;
      const sessions = this.deps.getInstanceSessionRefs();
      this.deps.instanceDirectory
        .reconcileHeartbeat(this.deps.instanceId, sessions, this.deps.cwd, this.deps.getConfirmedRegistered())
        .then((result) => {
          for (const id of result.claimedIds) {
            this.deps.handleSessionClaimed(id);
            dashboardNeedsRender = true;
          }
          this.deps.setConfirmedRegistered(result.confirmedIds);
          if (dashboardNeedsRender && this.deps.getMode() === "dashboard") {
            this.deps.renderCurrentDashboardView();
          }
        })
        .catch(() => {});

      const offlineChanged = this.deps.loadOfflineSessions();
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
      this.deps.syncSessionsFromState();
    }, 2000);
  }

  stopProjectServiceRefresh(): void {
    if (this.projectServiceInterval) {
      clearInterval(this.projectServiceInterval);
      this.projectServiceInterval = null;
    }
  }
}
