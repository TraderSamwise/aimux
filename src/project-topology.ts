export type TopologyHealth = "active" | "attention" | "idle" | "offline";

export interface TopologyRow {
  kind: "worktree" | "agent" | "service";
  depth: number;
  label: string;
  detail?: string;
  health: TopologyHealth;
  status?: string;
  sessionId?: string;
  serviceId?: string;
  worktreePath?: string;
}

export interface TopologyWorktreeView {
  name: string;
  branch: string;
  path?: string;
  health: TopologyHealth;
  agents: number;
  services: number;
}

export interface ProjectTopology {
  projectName: string;
  health: TopologyHealth;
  counts: { worktrees: number; agents: number; services: number };
  worktrees: TopologyWorktreeView[];
  rows: TopologyRow[];
}

interface TopoSession {
  id: string;
  command: string;
  label?: string;
  role?: string;
  status?: string;
  pendingAction?: string;
}
interface TopoService {
  id: string;
  command: string;
  label?: string;
  status?: string;
  pendingAction?: string;
}
interface TopoWorktree {
  name: string;
  branch: string;
  path?: string;
  status?: string;
  pending?: boolean;
  removing?: boolean;
  pendingAction?: string;
  sessions: TopoSession[];
  services: TopoService[];
}

export interface ProjectTopologyInput {
  projectName: string;
  worktrees: TopoWorktree[];
}

// Mirrors app/lib/openrig-topology.ts healthForStatus semantics.
export function healthForStatus(status?: string, pendingAction?: string): TopologyHealth {
  if (pendingAction) return "attention";
  switch (status) {
    case "running":
      return "active";
    case "waiting":
      return "attention";
    case "offline":
    case "exited":
      return "offline";
    case "idle":
      return "idle";
    default:
      return "idle";
  }
}

const HEALTH_RANK: Record<TopologyHealth, number> = { offline: 0, idle: 1, active: 2, attention: 3 };

export function rollupHealth(healths: TopologyHealth[]): TopologyHealth {
  if (healths.length === 0) return "idle";
  return healths.reduce((best, h) => (HEALTH_RANK[h] > HEALTH_RANK[best] ? h : best), "offline" as TopologyHealth);
}

function worktreeHealth(worktree: TopoWorktree, childHealths: TopologyHealth[]): TopologyHealth {
  if (worktree.pending || worktree.pendingAction) return "attention";
  if (worktree.removing) return "offline";
  if (childHealths.length > 0) return rollupHealth(childHealths);
  return worktree.status === "offline" ? "offline" : "idle";
}

export function buildProjectTopology(input: ProjectTopologyInput): ProjectTopology {
  const rows: TopologyRow[] = [];
  const worktrees: TopologyWorktreeView[] = [];
  let agentCount = 0;
  let serviceCount = 0;

  for (const worktree of input.worktrees) {
    const childHealths: TopologyHealth[] = [];
    const childRows: TopologyRow[] = [];

    for (const session of worktree.sessions) {
      const health = healthForStatus(session.status, session.pendingAction);
      childHealths.push(health);
      childRows.push({
        kind: "agent",
        depth: 1,
        label: session.label ?? session.command,
        detail: session.role,
        health,
        status: session.status,
        sessionId: session.id,
        worktreePath: worktree.path,
      });
    }
    for (const service of worktree.services) {
      const health = healthForStatus(service.status, service.pendingAction);
      childHealths.push(health);
      childRows.push({
        kind: "service",
        depth: 1,
        label: service.label ?? service.command,
        detail: "service",
        health,
        status: service.status,
        serviceId: service.id,
        worktreePath: worktree.path,
      });
    }

    agentCount += worktree.sessions.length;
    serviceCount += worktree.services.length;
    const health = worktreeHealth(worktree, childHealths);
    worktrees.push({
      name: worktree.name,
      branch: worktree.branch,
      path: worktree.path,
      health,
      agents: worktree.sessions.length,
      services: worktree.services.length,
    });
    rows.push({
      kind: "worktree",
      depth: 0,
      label: worktree.name,
      detail: worktree.branch,
      health,
      status: worktree.status,
      worktreePath: worktree.path,
    });
    rows.push(...childRows);
  }

  return {
    projectName: input.projectName,
    health: rollupHealth(worktrees.map((w) => w.health)),
    counts: { worktrees: input.worktrees.length, agents: agentCount, services: serviceCount },
    worktrees,
    rows,
  };
}
