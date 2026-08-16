import type { DashboardService, DashboardSession, WorktreeGroup } from "./index.js";

export function isDashboardSessionOffline(session: DashboardSession): boolean {
  if (session.pendingAction) return false;
  return session.semantic?.user.label === "offline" || session.status === "offline" || session.status === "exited";
}

function worktreeKey(path: string | undefined): string {
  return path ?? "__main__";
}

function shouldKeepOperationalWorktree(group: WorktreeGroup): boolean {
  return Boolean(group.pending || group.removing || group.pendingAction || group.operationFailure || group.optimistic);
}

export function filterDashboardVisibleModel(input: {
  hideOfflineAgents: boolean;
  sessions: DashboardSession[];
  services: DashboardService[];
  worktreeGroups: WorktreeGroup[];
}): {
  sessions: DashboardSession[];
  services: DashboardService[];
  worktreeGroups: WorktreeGroup[];
} {
  if (!input.hideOfflineAgents) {
    return {
      sessions: input.sessions,
      services: input.services,
      worktreeGroups: input.worktreeGroups,
    };
  }

  const sessions = input.sessions.filter((session) => !isDashboardSessionOffline(session));
  const visibleSessionWorktrees = new Set(sessions.map((session) => worktreeKey(session.worktreePath)));
  const visibleServiceIds = new Set<string>();
  const visibleGroupWorktrees = new Set<string>();

  const worktreeGroups = input.worktreeGroups.flatMap((group) => {
    const groupSessions = group.sessions.filter((session) => !isDashboardSessionOffline(session));
    const keepGroup = groupSessions.length > 0 || shouldKeepOperationalWorktree(group);
    if (!keepGroup) return [];

    visibleGroupWorktrees.add(worktreeKey(group.path));
    for (const service of group.services) {
      visibleServiceIds.add(service.id);
    }
    return [
      {
        ...group,
        sessions: groupSessions,
      },
    ];
  });

  const services = input.services.filter((service) => {
    const key = worktreeKey(service.worktreePath);
    return visibleServiceIds.has(service.id) || visibleSessionWorktrees.has(key) || visibleGroupWorktrees.has(key);
  });

  return { sessions, services, worktreeGroups };
}
