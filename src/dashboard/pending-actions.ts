import type { DashboardService, DashboardSession, WorktreeGroup } from "./index.js";

export type PendingDashboardActionKind =
  | "creating"
  | "forking"
  | "migrating"
  | "starting"
  | "stopping"
  | "graveyarding"
  | "renaming"
  | "removing";

interface PendingActionEntry {
  kind: PendingDashboardActionKind;
  timeoutId?: ReturnType<typeof setTimeout>;
  sessionSeed?: DashboardSession;
  serviceSeed?: DashboardService;
}

export class DashboardPendingActions {
  private actions = new Map<string, PendingActionEntry>();
  private version = 0;

  constructor(private readonly onChange: () => void) {}

  static worktreeKey(path?: string): string {
    return `worktree:${path ?? "__main__"}`;
  }

  set(
    sessionId: string,
    kind: PendingDashboardActionKind | null,
    opts?: {
      timeoutMs?: number;
      onTimeout?: () => void;
      sessionSeed?: DashboardSession;
      serviceSeed?: DashboardService;
    },
  ): void {
    const existing = this.actions.get(sessionId);
    const previousKind = existing?.kind;
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
      this.actions.set(sessionId, { kind, timeoutId, sessionSeed: opts?.sessionSeed, serviceSeed: opts?.serviceSeed });
    } else {
      this.actions.delete(sessionId);
    }
    if (previousKind !== kind) {
      this.version += 1;
    }
    this.onChange();
  }

  get(sessionId: string): PendingDashboardActionKind | undefined {
    return this.actions.get(sessionId)?.kind;
  }

  getVersion(): number {
    return this.version;
  }

  applyToSessions(sessions: DashboardSession[]): DashboardSession[] {
    if (this.actions.size === 0) return sessions;
    const seen = new Set<string>();
    const applied = sessions.map((session) => {
      seen.add(session.id);
      const pendingAction = this.actions.get(session.id)?.kind;
      if (pendingAction === "removing") return session;
      if (!pendingAction) return session;
      return { ...session, pendingAction, optimistic: true };
    });
    for (const [sessionId, entry] of this.actions.entries()) {
      if (seen.has(sessionId)) continue;
      if (!entry.sessionSeed) continue;
      if (entry.kind !== "creating" && entry.kind !== "forking") continue;
      applied.push({
        ...entry.sessionSeed,
        id: sessionId,
        pendingAction: entry.kind,
        optimistic: true,
      });
    }
    return applied;
  }

  applyToServices(services: DashboardService[]): DashboardService[] {
    if (this.actions.size === 0) return services;
    const seen = new Set<string>();
    const applied = services.map((service) => {
      seen.add(service.id);
      const pendingAction = this.actions.get(service.id)?.kind;
      if (pendingAction === "removing") return service;
      if (!pendingAction) return service;
      return { ...service, pendingAction, optimistic: true };
    });
    for (const [serviceId, entry] of this.actions.entries()) {
      if (seen.has(serviceId)) continue;
      if (!entry.serviceSeed) continue;
      if (entry.kind !== "creating") continue;
      applied.push({
        ...entry.serviceSeed,
        id: serviceId,
        pendingAction: entry.kind,
        optimistic: true,
      });
    }
    return applied;
  }

  applyToWorktrees(worktrees: WorktreeGroup[]): WorktreeGroup[] {
    if (this.actions.size === 0) return worktrees;
    return worktrees.map((worktree) => {
      const pendingAction = this.actions.get(DashboardPendingActions.worktreeKey(worktree.path))?.kind;
      if (!pendingAction) return worktree;
      return {
        ...worktree,
        pending: true,
        removing: pendingAction === "removing" || pendingAction === "graveyarding",
        pendingAction:
          pendingAction === "removing" || pendingAction === "creating" || pendingAction === "graveyarding"
            ? pendingAction
            : undefined,
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
