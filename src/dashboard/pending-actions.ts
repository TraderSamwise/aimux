import type { DashboardService, DashboardSession, WorktreeGroup } from "./index.js";

export type PendingDashboardActionKind =
  | "creating"
  | "starting"
  | "stopping"
  | "graveyarding"
  | "renaming"
  | "removing";

interface PendingActionEntry {
  kind: PendingDashboardActionKind;
  timeoutId?: ReturnType<typeof setTimeout>;
}

export class DashboardPendingActions {
  private actions = new Map<string, PendingActionEntry>();

  constructor(private readonly onChange: () => void) {}

  static worktreeKey(path: string): string {
    return `worktree:${path}`;
  }

  set(
    sessionId: string,
    kind: PendingDashboardActionKind | null,
    opts?: { timeoutMs?: number; onTimeout?: () => void },
  ): void {
    const existing = this.actions.get(sessionId);
    if (existing?.timeoutId) {
      clearTimeout(existing.timeoutId);
    }
    if (kind) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          const current = this.actions.get(sessionId);
          if (current?.kind !== kind) return;
          this.actions.delete(sessionId);
          opts.onTimeout?.();
          this.onChange();
        }, opts.timeoutMs);
      }
      this.actions.set(sessionId, { kind, timeoutId });
    } else {
      this.actions.delete(sessionId);
    }
    this.onChange();
  }

  get(sessionId: string): PendingDashboardActionKind | undefined {
    return this.actions.get(sessionId)?.kind;
  }

  applyToSessions(sessions: DashboardSession[]): DashboardSession[] {
    if (this.actions.size === 0) return sessions;
    return sessions.map((session) => {
      const pendingAction = this.actions.get(session.id)?.kind;
      if (pendingAction === "removing") return session;
      if (!pendingAction) return session;
      return { ...session, pendingAction, optimistic: true };
    });
  }

  applyToServices(services: DashboardService[]): DashboardService[] {
    if (this.actions.size === 0) return services;
    return services.map((service) => {
      const pendingAction = this.actions.get(service.id)?.kind;
      if (pendingAction === "removing") return service;
      if (!pendingAction) return service;
      return { ...service, pendingAction, optimistic: true };
    });
  }

  applyToWorktrees(worktrees: WorktreeGroup[]): WorktreeGroup[] {
    if (this.actions.size === 0) return worktrees;
    return worktrees.map((worktree) => {
      const pendingAction = this.actions.get(DashboardPendingActions.worktreeKey(worktree.path))?.kind;
      if (!pendingAction) return worktree;
      return {
        ...worktree,
        pending: true,
        removing: pendingAction === "removing",
        pendingAction: pendingAction === "removing" || pendingAction === "creating" ? pendingAction : undefined,
        optimistic: true,
      };
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
