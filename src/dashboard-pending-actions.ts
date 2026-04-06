import type { DashboardService, DashboardSession } from "./dashboard.js";

export type PendingDashboardActionKind = "creating" | "starting" | "stopping" | "graveyarding" | "renaming";

export class DashboardPendingActions {
  private actions = new Map<string, PendingDashboardActionKind>();

  constructor(private readonly onChange: () => void) {}

  set(sessionId: string, kind: PendingDashboardActionKind | null): void {
    if (kind) {
      this.actions.set(sessionId, kind);
    } else {
      this.actions.delete(sessionId);
    }
    this.onChange();
  }

  get(sessionId: string): PendingDashboardActionKind | undefined {
    return this.actions.get(sessionId);
  }

  applyToSessions(sessions: DashboardSession[]): DashboardSession[] {
    if (this.actions.size === 0) return sessions;
    return sessions.map((session) => {
      const pendingAction = this.actions.get(session.id);
      if (!pendingAction) return session;
      return { ...session, pendingAction, optimistic: true };
    });
  }

  applyToServices(services: DashboardService[]): DashboardService[] {
    if (this.actions.size === 0) return services;
    return services.map((service) => {
      const pendingAction = this.actions.get(service.id);
      if (!pendingAction) return service;
      return { ...service, pendingAction, optimistic: true };
    });
  }

  settleCreatePending(itemId: string, onSettled: () => void): void {
    const minVisibleMs = 250;
    const startedAt = Date.now();
    void (async () => {
      const remaining = minVisibleMs - (Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      this.set(itemId, null);
      onSettled();
    })();
  }
}
