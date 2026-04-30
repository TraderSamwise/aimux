import type { DashboardService, DashboardSession, MainCheckoutInfo, WorktreeGroup } from "./index.js";
import { HOTKEY_TIMEOUT_MS } from "../hotkeys.js";
import { dashboardCreatedSortKey, sortDashboardEntriesByCreatedAt } from "./sort.js";

export const DASHBOARD_QUICK_JUMP_TIMEOUT_MS = HOTKEY_TIMEOUT_MS;
export const DASHBOARD_QUICK_JUMP_LIMIT = 9;

export interface DashboardQuickJumpEntry {
  digit?: number;
  kind: "session" | "service";
  id: string;
}

export interface DashboardQuickJumpWorktree {
  digit?: number;
  path?: string;
  name: string;
  branch: string;
  pending?: boolean;
  removing?: boolean;
  pendingAction?: "creating" | "removing" | "graveyarding";
  sessions: DashboardSession[];
  services: DashboardService[];
  entries: DashboardQuickJumpEntry[];
}

export type DashboardQuickJumpTarget =
  | { kind: "worktree"; worktree: DashboardQuickJumpWorktree }
  | { kind: "entry"; worktree: DashboardQuickJumpWorktree; entry: DashboardQuickJumpEntry; entryIndex: number };

function buildEntryList(sessions: DashboardSession[], services: DashboardService[]): DashboardQuickJumpEntry[] {
  const entries: DashboardQuickJumpEntry[] = [];
  for (const session of sessions) {
    entries.push({
      digit: entries.length < DASHBOARD_QUICK_JUMP_LIMIT ? entries.length + 1 : undefined,
      kind: "session",
      id: session.id,
    });
  }
  for (const service of services) {
    entries.push({
      digit: entries.length < DASHBOARD_QUICK_JUMP_LIMIT ? entries.length + 1 : undefined,
      kind: "service",
      id: service.id,
    });
  }
  return entries;
}

export function buildDashboardQuickJumpWorktrees(input: {
  sessions: DashboardSession[];
  services: DashboardService[];
  worktreeGroups: WorktreeGroup[];
  mainCheckout: MainCheckoutInfo;
}): DashboardQuickJumpWorktree[] {
  const wtSessionMap = new Map<string, DashboardSession[]>();
  const wtServiceMap = new Map<string, DashboardService[]>();
  const mainSessions: DashboardSession[] = [];
  const mainServices: DashboardService[] = [];

  for (const session of input.sessions) {
    if (!session.worktreePath) {
      mainSessions.push(session);
    } else {
      const group = wtSessionMap.get(session.worktreePath) ?? [];
      group.push(session);
      wtSessionMap.set(session.worktreePath, group);
    }
  }

  for (const service of input.services) {
    if (!service.worktreePath) {
      mainServices.push(service);
    } else {
      const group = wtServiceMap.get(service.worktreePath) ?? [];
      group.push(service);
      wtServiceMap.set(service.worktreePath, group);
    }
  }

  for (const [path, sessions] of wtSessionMap) {
    wtSessionMap.set(path, sortDashboardEntriesByCreatedAt(sessions));
  }
  for (const [path, services] of wtServiceMap) {
    wtServiceMap.set(path, sortDashboardEntriesByCreatedAt(services));
  }

  const worktrees: DashboardQuickJumpWorktree[] = [];
  const pushWorktree = (worktree: Omit<DashboardQuickJumpWorktree, "digit" | "entries">): void => {
    worktrees.push({
      ...worktree,
      digit: worktrees.length < DASHBOARD_QUICK_JUMP_LIMIT ? worktrees.length + 1 : undefined,
      entries: buildEntryList(worktree.sessions, worktree.services),
    });
  };

  const renderedPaths = new Set<string>();
  const mainGroup = input.worktreeGroups.find((group) => group.path === undefined);
  if (mainGroup) {
    pushWorktree({
      path: undefined,
      name: mainGroup.name,
      branch: mainGroup.branch,
      pending: mainGroup.pending,
      removing: mainGroup.removing,
      pendingAction: mainGroup.pendingAction,
      sessions: mainSessions,
      services: mainServices,
    });
  } else {
    pushWorktree({
      path: undefined,
      name: input.mainCheckout.name,
      branch: input.mainCheckout.branch,
      sessions: sortDashboardEntriesByCreatedAt(mainSessions),
      services: sortDashboardEntriesByCreatedAt(mainServices),
    });
  }

  const orderedGroups = [...input.worktreeGroups]
    .filter((group): group is WorktreeGroup & { path: string } => group.path !== undefined)
    .sort((a, b) => dashboardCreatedSortKey(b) - dashboardCreatedSortKey(a));
  for (const group of orderedGroups) {
    pushWorktree({
      path: group.path,
      name: group.name,
      branch: group.branch,
      pending: group.pending,
      removing: group.removing,
      pendingAction: group.pendingAction,
      sessions: wtSessionMap.get(group.path) ?? [],
      services: wtServiceMap.get(group.path) ?? [],
    });
    renderedPaths.add(group.path);
  }

  const orphanPaths = new Set<string>([...wtSessionMap.keys(), ...wtServiceMap.keys()]);
  for (const path of orphanPaths) {
    if (!path || renderedPaths.has(path)) continue;
    const sessions = wtSessionMap.get(path) ?? [];
    const services = wtServiceMap.get(path) ?? [];
    const exemplar = sessions[0] ?? services[0];
    pushWorktree({
      path,
      name: exemplar?.worktreeName ?? "unknown",
      branch: exemplar?.worktreeBranch ?? "unknown",
      sessions,
      services,
    });
  }

  return worktrees;
}

export function resolveDashboardQuickJumpTarget(
  worktrees: DashboardQuickJumpWorktree[],
  digits: string,
): DashboardQuickJumpTarget | null {
  if (!digits || digits.length > 2) return null;
  const worktreeDigit = Number.parseInt(digits[0] ?? "", 10);
  if (!Number.isFinite(worktreeDigit) || worktreeDigit < 1 || worktreeDigit > DASHBOARD_QUICK_JUMP_LIMIT) {
    return null;
  }
  const worktree = worktrees.find((entry) => entry.digit === worktreeDigit);
  if (!worktree) return null;
  if (digits.length === 1) {
    return { kind: "worktree", worktree };
  }
  const entryDigit = Number.parseInt(digits[1] ?? "", 10);
  if (!Number.isFinite(entryDigit) || entryDigit < 1 || entryDigit > DASHBOARD_QUICK_JUMP_LIMIT) {
    return { kind: "worktree", worktree };
  }
  const entryIndex = worktree.entries.findIndex((entry) => entry.digit === entryDigit);
  if (entryIndex < 0) {
    return { kind: "worktree", worktree };
  }
  return { kind: "entry", worktree, entry: worktree.entries[entryIndex], entryIndex };
}
