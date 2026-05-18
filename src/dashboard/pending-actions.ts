import type { DashboardService, DashboardSession, WorktreeGroup } from "./index.js";
import type {
  PendingDashboardActionKind,
  PendingServiceActionKind,
  PendingSessionActionKind,
  PendingWorktreeActionKind,
} from "../pending-actions.js";

type PendingActionTarget = "session" | "service" | "worktree";

interface PendingActionEntry {
  target: PendingActionTarget;
  kind: PendingDashboardActionKind;
  token: number;
  timeoutId?: ReturnType<typeof setTimeout>;
  sessionSeed?: DashboardSession;
  serviceSeed?: DashboardService;
}

interface PendingActionOptions {
  timeoutMs?: number;
  onTimeout?: () => void;
}

interface PendingSessionActionOptions extends PendingActionOptions {
  sessionSeed?: DashboardSession;
}

interface PendingServiceActionOptions extends PendingActionOptions {
  serviceSeed?: DashboardService;
}

function visibleEntryKey(entry?: PendingActionEntry): string {
  if (!entry) return "";
  return JSON.stringify({
    target: entry.target,
    kind: entry.kind,
    sessionSeed: entry.sessionSeed,
    serviceSeed: entry.serviceSeed,
  });
}

function canSynthesizeMissingSession(
  kind: PendingDashboardActionKind,
): kind is Extract<PendingSessionActionKind, "creating" | "forking" | "migrating" | "starting" | "stopping"> {
  return (
    kind === "creating" || kind === "forking" || kind === "migrating" || kind === "starting" || kind === "stopping"
  );
}

function canSynthesizeMissingService(
  kind: PendingDashboardActionKind,
): kind is Extract<PendingServiceActionKind, "creating" | "starting" | "stopping"> {
  return kind === "creating" || kind === "starting" || kind === "stopping";
}

export class DashboardPendingActions {
  private actions = new Map<string, PendingActionEntry>();
  private version = 0;
  private nextEntryToken = 0;

  constructor(private readonly onChange: () => void) {}

  static worktreeKey(path?: string): string {
    return `worktree:${path ?? "__main__"}`;
  }

  private static actionKey(target: PendingActionTarget, id: string): string {
    return `${target}:${id}`;
  }

  setSessionAction(sessionId: string, kind: PendingSessionActionKind, opts?: PendingSessionActionOptions): void {
    this.setEntry("session", sessionId, kind, opts);
  }

  clearSessionAction(sessionId: string): void {
    this.clearEntry("session", sessionId);
  }

  setServiceAction(serviceId: string, kind: PendingServiceActionKind, opts?: PendingServiceActionOptions): void {
    this.setEntry("service", serviceId, kind, opts);
  }

  clearServiceAction(serviceId: string): void {
    this.clearEntry("service", serviceId);
  }

  setWorktreeAction(path: string | undefined, kind: PendingWorktreeActionKind, opts?: PendingActionOptions): void {
    this.setEntry("worktree", DashboardPendingActions.worktreeKey(path), kind, opts);
  }

  clearWorktreeAction(path: string | undefined): void {
    this.clearEntry("worktree", DashboardPendingActions.worktreeKey(path));
  }

  getSessionAction(sessionId: string): PendingSessionActionKind | undefined {
    const entry = this.actions.get(DashboardPendingActions.actionKey("session", sessionId));
    return entry?.target === "session" ? (entry.kind as PendingSessionActionKind) : undefined;
  }

  getServiceAction(serviceId: string): PendingServiceActionKind | undefined {
    const entry = this.actions.get(DashboardPendingActions.actionKey("service", serviceId));
    return entry?.target === "service" ? (entry.kind as PendingServiceActionKind) : undefined;
  }

  getWorktreeAction(path: string | undefined): PendingWorktreeActionKind | undefined {
    const entry = this.actions.get(
      DashboardPendingActions.actionKey("worktree", DashboardPendingActions.worktreeKey(path)),
    );
    return entry?.target === "worktree" ? (entry.kind as PendingWorktreeActionKind) : undefined;
  }

  private setEntry(
    target: PendingActionTarget,
    id: string,
    kind: PendingDashboardActionKind,
    opts?: {
      timeoutMs?: number;
      onTimeout?: () => void;
      sessionSeed?: DashboardSession;
      serviceSeed?: DashboardService;
    },
  ): void {
    const key = DashboardPendingActions.actionKey(target, id);
    const existing = this.actions.get(key);
    const previousVisibleKey = visibleEntryKey(existing);
    if (existing?.timeoutId) {
      clearTimeout(existing.timeoutId);
    }
    const token = ++this.nextEntryToken;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        const current = this.actions.get(key);
        if (current?.target !== target || current.kind !== kind || current.token !== token) return;
        this.actions.delete(key);
        this.version += 1;
        try {
          opts.onTimeout?.();
        } finally {
          this.onChange();
        }
      }, opts.timeoutMs);
    }
    this.actions.set(key, {
      target,
      kind,
      token,
      timeoutId,
      sessionSeed: opts?.sessionSeed,
      serviceSeed: opts?.serviceSeed,
    });
    const changed = previousVisibleKey !== visibleEntryKey(this.actions.get(key));
    if (changed) {
      this.version += 1;
      this.onChange();
    }
  }

  private clearEntry(target: PendingActionTarget, id: string): void {
    const key = DashboardPendingActions.actionKey(target, id);
    const existing = this.actions.get(key);
    const previousVisibleKey = visibleEntryKey(existing);
    if (existing?.timeoutId) {
      clearTimeout(existing.timeoutId);
    }
    this.actions.delete(key);
    const changed = previousVisibleKey !== visibleEntryKey(this.actions.get(key));
    if (changed) {
      this.version += 1;
      this.onChange();
    }
  }

  getVersion(): number {
    return this.version;
  }

  applyToSessions(sessions: DashboardSession[]): DashboardSession[] {
    if (this.actions.size === 0) return sessions;
    const seen = new Set<string>();
    const applied = sessions.map((session) => {
      seen.add(session.id);
      const pendingAction = this.getSessionAction(session.id);
      if (!pendingAction) return session;
      return { ...session, pendingAction, optimistic: true };
    });
    for (const [entryKey, entry] of this.actions.entries()) {
      if (entry.target !== "session") continue;
      const sessionId = entryKey.slice("session:".length);
      if (seen.has(sessionId)) continue;
      if (!entry.sessionSeed) continue;
      if (!canSynthesizeMissingSession(entry.kind)) continue;
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
      const pendingAction = this.getServiceAction(service.id);
      if (pendingAction === "removing") return service;
      if (!pendingAction) return service;
      return { ...service, pendingAction, optimistic: true };
    });
    for (const [entryKey, entry] of this.actions.entries()) {
      if (entry.target !== "service") continue;
      const serviceId = entryKey.slice("service:".length);
      if (seen.has(serviceId)) continue;
      if (!entry.serviceSeed) continue;
      if (!canSynthesizeMissingService(entry.kind)) continue;
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
      const pendingAction = this.getWorktreeAction(worktree.path);
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

  settleCreatePending(
    target: PendingActionTarget,
    itemId: string,
    onSettled: () => void,
    opts?: { isSettled?: () => boolean | Promise<boolean>; timeoutMs?: number },
  ): void {
    const minVisibleMs = 250;
    const timeoutMs = opts?.timeoutMs ?? 10_000;
    const startedAt = Date.now();
    void (async () => {
      const remaining = minVisibleMs - (Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      if (opts?.isSettled) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (await opts.isSettled()) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      this.clearEntry(target, itemId);
      onSettled();
    })();
  }
}
