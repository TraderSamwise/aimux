import { basename } from "node:path";
import { parseRecencyTimestamp } from "../recency.js";
import type { LastUsedEntry } from "../last-used.js";
import { isTeammateSession, selectOrphanTeammates } from "../team.js";
import type { ServiceState, SessionState } from "./index.js";
import type { WorktreeGraveyardEntry } from "./worktree-graveyard.js";

export const MAX_VISIBLE_ATTACHED_AGENTS_PER_WORKTREE = 5;

export type GraveyardAgentView = {
  entry: SessionState;
  lastUsedAt?: string;
  source: "worktree" | "standalone";
};

export type GraveyardServiceView = {
  entry: ServiceState;
  lastUsedAt?: string;
};

export type GraveyardSectionRow = {
  kind: "section";
  label: string;
};

export type GraveyardAgentWorktreeRow = {
  kind: "agent-worktree";
  path: string;
  name: string;
};

export type GraveyardWorktreeRow = {
  kind: "worktree";
  entry: WorktreeGraveyardEntry;
  actionIndex: number;
  actionNumber: number;
  attachedAgents: GraveyardAgentView[];
  visibleAttachedAgents: GraveyardAgentView[];
  hiddenAttachedAgentCount: number;
  attachedServices: GraveyardServiceView[];
  lastUsedAt?: string;
  sortAt?: string;
};

export type GraveyardAttachedAgentRow = {
  kind: "attached-agent-display";
  parentPath: string;
  agent: GraveyardAgentView;
};

export type GraveyardAttachedServiceRow = {
  kind: "attached-service-display";
  parentPath: string;
  service: GraveyardServiceView;
};

export type GraveyardAttachedMoreRow = {
  kind: "attached-more-display";
  parentPath: string;
  hiddenAgentCount: number;
};

export type GraveyardStandaloneAgentRow = {
  kind: "standalone-agent" | "orphan-agent";
  entry: SessionState;
  actionIndex: number;
  actionNumber: number;
  lastUsedAt?: string;
};

export type GraveyardOrphanTeammateRow = {
  kind: "orphan-teammate-display";
  entry: SessionState;
  parentSessionId: string;
  lastUsedAt?: string;
};

export type GraveyardViewRow =
  | GraveyardSectionRow
  | GraveyardAgentWorktreeRow
  | GraveyardWorktreeRow
  | GraveyardAttachedAgentRow
  | GraveyardAttachedServiceRow
  | GraveyardAttachedMoreRow
  | GraveyardStandaloneAgentRow
  | GraveyardOrphanTeammateRow;

export type GraveyardSelectableRow = GraveyardWorktreeRow | GraveyardStandaloneAgentRow;

export interface GraveyardViewModel {
  rows: GraveyardViewRow[];
  selectableRows: GraveyardSelectableRow[];
}

export interface BuildGraveyardViewModelInput {
  worktrees: WorktreeGraveyardEntry[];
  agents: SessionState[];
  parentSessions?: SessionState[];
  teammates?: SessionState[];
  lastUsedById?: Record<string, LastUsedEntry | undefined>;
}

export function buildGraveyardViewModel(input: BuildGraveyardViewModelInput): GraveyardViewModel {
  const rows: GraveyardViewRow[] = [];
  const selectableRows: GraveyardSelectableRow[] = [];
  const flatAgentsClaimedByWorktree = new Set<string>();
  const renderedAgentIds = new Set<string>();

  const addSelectable = <T extends GraveyardWorktreeRow | GraveyardStandaloneAgentRow>(
    row: Omit<T, "actionIndex" | "actionNumber">,
  ): T => {
    const actionIndex = selectableRows.length;
    const withAction = { ...row, actionIndex, actionNumber: actionIndex + 1 } as T;
    selectableRows.push(withAction);
    return withAction;
  };

  if (input.worktrees.length > 0) {
    rows.push({ kind: "section", label: "Worktrees" });
    for (const worktree of sortWorktrees(input.worktrees, input.agents, input.lastUsedById ?? {})) {
      const attachedAgents = collectAttachedAgents(worktree, input.agents, input.lastUsedById ?? {});
      const attachedAgentIds = new Set(attachedAgents.map((agent) => agent.entry.id));
      for (const agent of input.agents) {
        if (agent.worktreePath === worktree.path && attachedAgentIds.has(agent.id)) {
          flatAgentsClaimedByWorktree.add(agent.id);
        }
      }
      const attachedServices = collectAttachedServices(worktree, input.lastUsedById ?? {});
      const visibleAttachedAgents = attachedAgents.slice(0, MAX_VISIBLE_ATTACHED_AGENTS_PER_WORKTREE);
      const worktreeRow = addSelectable<GraveyardWorktreeRow>({
        kind: "worktree",
        entry: worktree,
        attachedAgents,
        visibleAttachedAgents,
        hiddenAttachedAgentCount: Math.max(0, attachedAgents.length - visibleAttachedAgents.length),
        attachedServices,
        lastUsedAt: maxLastUsedAt([...attachedAgents, ...attachedServices]),
        sortAt: worktreeSortTimestamp(worktree, attachedAgents, attachedServices),
      });
      rows.push(worktreeRow);
      for (const agent of attachedAgents) {
        renderedAgentIds.add(agent.entry.id);
      }
      for (const agent of visibleAttachedAgents) {
        rows.push({ kind: "attached-agent-display", parentPath: worktree.path, agent });
      }
      if (worktreeRow.hiddenAttachedAgentCount > 0) {
        rows.push({
          kind: "attached-more-display",
          parentPath: worktree.path,
          hiddenAgentCount: worktreeRow.hiddenAttachedAgentCount,
        });
      }
      for (const service of attachedServices) {
        rows.push({ kind: "attached-service-display", parentPath: worktree.path, service });
      }
    }
  }

  const standaloneAgents = input.agents.filter((agent) => !flatAgentsClaimedByWorktree.has(agent.id));
  const agentsByWorktree = groupStandaloneAgentsByWorktree(standaloneAgents, input.lastUsedById ?? {});
  if (agentsByWorktree.length > 0) {
    rows.push({ kind: "section", label: "Agents by Worktree" });
    for (const [worktreePath, agents] of agentsByWorktree) {
      rows.push({ kind: "agent-worktree", path: worktreePath, name: basename(worktreePath) || worktreePath });
      for (const agent of agents) {
        rows.push(
          addSelectable<GraveyardStandaloneAgentRow>({
            kind: "standalone-agent",
            entry: agent,
            lastUsedAt: input.lastUsedById?.[agent.id]?.lastUsedAt,
          }),
        );
        renderedAgentIds.add(agent.id);
      }
    }
  }

  const orphanAgents = standaloneAgents.filter((agent) => !agent.worktreePath);
  if (orphanAgents.length > 0) {
    rows.push({ kind: "section", label: "Orphaned Agents" });
    for (const agent of sortAgents(orphanAgents, input.lastUsedById ?? {})) {
      rows.push(
        addSelectable<GraveyardStandaloneAgentRow>({
          kind: "orphan-agent",
          entry: agent,
          lastUsedAt: input.lastUsedById?.[agent.id]?.lastUsedAt,
        }),
      );
      renderedAgentIds.add(agent.id);
    }
  }

  const orphanTeammates = selectOrphanTeammates(input.teammates ?? [], collectKnownParentIds(input)).filter(
    (session) => !renderedAgentIds.has(session.id) && !input.agents.some((agent) => agent.id === session.id),
  );
  if (orphanTeammates.length > 0) {
    rows.push({ kind: "section", label: "Orphaned Teammates" });
    for (const teammate of orphanTeammates) {
      const parentSessionId = teammate.team?.parentSessionId;
      if (!parentSessionId) continue;
      rows.push({
        kind: "orphan-teammate-display",
        entry: teammate,
        parentSessionId,
        lastUsedAt: input.lastUsedById?.[teammate.id]?.lastUsedAt,
      });
    }
  }

  return { rows, selectableRows };
}

function collectKnownParentIds(input: BuildGraveyardViewModelInput): Set<string> {
  const ids = new Set<string>();
  const add = (session: SessionState | undefined): void => {
    if (!session || isTeammateSession(session)) return;
    ids.add(session.id);
  };

  for (const session of input.parentSessions ?? []) add(session);
  for (const agent of input.agents) add(agent);
  for (const worktree of input.worktrees) {
    for (const agent of worktree.agents ?? []) add(agent);
  }
  return ids;
}

function sortWorktrees(
  worktrees: WorktreeGraveyardEntry[],
  flatAgents: SessionState[],
  lastUsedById: Record<string, LastUsedEntry | undefined>,
): WorktreeGraveyardEntry[] {
  const sortMsByPath = new Map<string, number>();
  for (const worktree of worktrees) {
    const attachedAgents = collectAttachedAgents(worktree, flatAgents, lastUsedById);
    const attachedServices = collectAttachedServices(worktree, lastUsedById);
    sortMsByPath.set(
      worktree.path,
      parseRecencyTimestamp(worktreeSortTimestamp(worktree, attachedAgents, attachedServices)) ?? 0,
    );
  }
  return [...worktrees].sort((left, right) => {
    const diff = (sortMsByPath.get(right.path) ?? 0) - (sortMsByPath.get(left.path) ?? 0);
    return diff || left.name.localeCompare(right.name);
  });
}

function collectAttachedAgents(
  worktree: WorktreeGraveyardEntry,
  flatAgents: SessionState[],
  lastUsedById: Record<string, LastUsedEntry | undefined>,
): GraveyardAgentView[] {
  const byId = new Map<string, GraveyardAgentView>();
  for (const agent of worktree.agents ?? []) {
    byId.set(agent.id, {
      entry: agent,
      source: "worktree",
      lastUsedAt: lastUsedById[agent.id]?.lastUsedAt,
    });
  }
  for (const agent of flatAgents) {
    if (agent.worktreePath !== worktree.path) continue;
    if (byId.has(agent.id)) continue;
    byId.set(agent.id, {
      entry: agent,
      source: "standalone",
      lastUsedAt: lastUsedById[agent.id]?.lastUsedAt,
    });
  }
  return [...byId.values()].sort((a, b) => compareRecencyOrCreated(a.entry, a.lastUsedAt, b.entry, b.lastUsedAt));
}

function collectAttachedServices(
  worktree: WorktreeGraveyardEntry,
  lastUsedById: Record<string, LastUsedEntry | undefined>,
): GraveyardServiceView[] {
  return [...(worktree.services ?? [])]
    .map((service) => ({
      entry: service,
      lastUsedAt: lastUsedById[service.id]?.lastUsedAt,
    }))
    .sort((a, b) => compareRecencyOrCreated(a.entry, a.lastUsedAt, b.entry, b.lastUsedAt));
}

function groupStandaloneAgentsByWorktree(
  agents: SessionState[],
  lastUsedById: Record<string, LastUsedEntry | undefined>,
): Array<[string, SessionState[]]> {
  const byWorktree = new Map<string, SessionState[]>();
  for (const agent of agents) {
    if (!agent.worktreePath) continue;
    const list = byWorktree.get(agent.worktreePath) ?? [];
    list.push(agent);
    byWorktree.set(agent.worktreePath, list);
  }
  return [...byWorktree.entries()]
    .map(
      ([path, entries]) =>
        [
          path,
          [...entries].sort((a, b) =>
            compareRecencyOrCreated(a, lastUsedById[a.id]?.lastUsedAt, b, lastUsedById[b.id]?.lastUsedAt),
          ),
        ] as [string, SessionState[]],
    )
    .sort(([left], [right]) => left.localeCompare(right));
}

function sortAgents(agents: SessionState[], lastUsedById: Record<string, LastUsedEntry | undefined>): SessionState[] {
  return [...agents].sort((a, b) =>
    compareRecencyOrCreated(a, lastUsedById[a.id]?.lastUsedAt, b, lastUsedById[b.id]?.lastUsedAt),
  );
}

function maxLastUsedAt(items: Array<{ lastUsedAt?: string }>): string | undefined {
  let best: string | undefined;
  let bestMs = 0;
  for (const item of items) {
    const ms = parseRecencyTimestamp(item.lastUsedAt) ?? 0;
    if (ms > bestMs) {
      bestMs = ms;
      best = item.lastUsedAt;
    }
  }
  return best;
}

function worktreeSortTimestamp(
  worktree: WorktreeGraveyardEntry,
  agents: GraveyardAgentView[],
  services: GraveyardServiceView[],
): string | undefined {
  let best = maxLastUsedAt([...agents, ...services]);
  let bestMs = parseRecencyTimestamp(best) ?? 0;
  for (const agent of agents) {
    const createdMs = parseRecencyTimestamp(agent.entry.createdAt) ?? 0;
    if (createdMs > bestMs) {
      best = agent.entry.createdAt;
      bestMs = createdMs;
    }
  }
  for (const service of services) {
    const createdMs = parseRecencyTimestamp(service.entry.createdAt) ?? 0;
    if (createdMs > bestMs) {
      best = service.entry.createdAt;
      bestMs = createdMs;
    }
  }
  const graveyardedMs = parseRecencyTimestamp(worktree.graveyardedAt) ?? 0;
  if (graveyardedMs > bestMs) {
    best = worktree.graveyardedAt;
  }
  return best;
}

function compareRecencyOrCreated(
  left: { id: string; createdAt?: string },
  leftLastUsedAt: string | undefined,
  right: { id: string; createdAt?: string },
  rightLastUsedAt: string | undefined,
): number {
  const leftUsed = parseRecencyTimestamp(leftLastUsedAt) ?? 0;
  const rightUsed = parseRecencyTimestamp(rightLastUsedAt) ?? 0;
  if (leftUsed !== rightUsed) return rightUsed - leftUsed;
  const leftCreated = parseRecencyTimestamp(left.createdAt) ?? 0;
  const rightCreated = parseRecencyTimestamp(right.createdAt) ?? 0;
  return rightCreated - leftCreated || left.id.localeCompare(right.id);
}
