import type { DaemonProject } from "@/lib/api";
import type {
  DesktopService,
  DesktopSession,
  DesktopState,
  WorktreeBucket,
} from "@/lib/desktop-state";
import { firstTokenOf } from "@/lib/status-tone";

export type TopologyNodeKind = "project" | "worktree" | "agent" | "service";
export type TopologyHealth = "active" | "attention" | "idle" | "offline";

export interface TopologyNode {
  id: string;
  kind: TopologyNodeKind;
  label: string;
  subtitle?: string;
  status?: string;
  health: TopologyHealth;
  worktreeKey?: string;
  sourceId?: string;
}

export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
}

export interface TopologySummary {
  worktrees: number;
  agents: number;
  services: number;
  active: number;
  attention: number;
  offline: number;
}

export interface TopologyWorktree {
  id: string;
  name: string;
  branch: string;
  path: string | null;
  health: TopologyHealth;
  agents: TopologyNode[];
  services: TopologyNode[];
}

export interface ProjectTopology {
  project: TopologyNode;
  worktrees: TopologyWorktree[];
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  summary: TopologySummary;
}

function normalizeStatus(status?: string): string {
  return status?.trim().toLowerCase() ?? "";
}

export function healthForStatus(status?: string, pendingAction?: string): TopologyHealth {
  if (pendingAction?.trim()) return "attention";
  const normalized = normalizeStatus(status);
  if (normalized === "running") return "active";
  if (normalized === "waiting") return "attention";
  if (normalized === "idle") return "idle";
  if (normalized === "exited" || normalized === "offline") return "offline";
  return "idle";
}

function healthRank(health: TopologyHealth): number {
  switch (health) {
    case "attention":
      return 4;
    case "active":
      return 3;
    case "idle":
      return 2;
    case "offline":
      return 1;
  }
}

function rollupHealth(nodes: TopologyNode[]): TopologyHealth {
  if (nodes.length === 0) return "idle";
  return nodes.reduce<TopologyHealth>(
    (best, node) => (healthRank(node.health) > healthRank(best) ? node.health : best),
    "offline",
  );
}

function agentNode(session: DesktopSession, worktreeKey: string): TopologyNode {
  const tool = firstTokenOf(session.command);
  return {
    id: `agent:${session.id}`,
    kind: "agent",
    label: session.label || session.id,
    subtitle: [tool, session.headline || session.previewLine].filter(Boolean).join(" · "),
    status: session.status,
    health: healthForStatus(session.status, session.pendingAction),
    worktreeKey,
    sourceId: session.id,
  };
}

function serviceNode(service: DesktopService, worktreeKey: string): TopologyNode {
  const detail = service.shellCommand ?? service.previewLine ?? service.command ?? "";
  return {
    id: `service:${service.id}`,
    kind: "service",
    label: service.label || service.id,
    subtitle: detail,
    status: service.status,
    health: healthForStatus(service.status, service.pendingAction),
    worktreeKey,
    sourceId: service.id,
  };
}

export function buildProjectTopology(
  projectInfo: Pick<DaemonProject, "name" | "path">,
  groups: WorktreeBucket[],
  state: DesktopState | null,
): ProjectTopology {
  const projectId = `project:${projectInfo.path}`;
  const worktrees = groups.map<TopologyWorktree>((bucket) => {
    const worktreeId = `worktree:${bucket.key}`;
    const agents = bucket.sessions.map((session) => agentNode(session, bucket.key));
    const services = bucket.services.map((service) => serviceNode(service, bucket.key));
    return {
      id: worktreeId,
      name: bucket.name,
      branch: bucket.branch,
      path: bucket.path,
      health: rollupHealth([...agents, ...services]),
      agents,
      services,
    };
  });

  const project: TopologyNode = {
    id: projectId,
    kind: "project",
    label: projectInfo.name,
    subtitle: projectInfo.path,
    health: state
      ? rollupHealth(worktrees.flatMap((worktree) => [...worktree.agents, ...worktree.services]))
      : "offline",
  };

  const nodes: TopologyNode[] = [
    project,
    ...worktrees.map<TopologyNode>((worktree) => ({
      id: worktree.id,
      kind: "worktree",
      label: worktree.name,
      subtitle: worktree.branch || worktree.path || undefined,
      health: worktree.health,
    })),
    ...worktrees.flatMap((worktree) => [...worktree.agents, ...worktree.services]),
  ];

  const edges: TopologyEdge[] = [
    ...worktrees.map((worktree) => ({
      id: `${projectId}->${worktree.id}`,
      from: projectId,
      to: worktree.id,
    })),
    ...worktrees.flatMap((worktree) =>
      [...worktree.agents, ...worktree.services].map((node) => ({
        id: `${worktree.id}->${node.id}`,
        from: worktree.id,
        to: node.id,
      })),
    ),
  ];

  const agentCount = worktrees.reduce((sum, worktree) => sum + worktree.agents.length, 0);
  const serviceCount = worktrees.reduce((sum, worktree) => sum + worktree.services.length, 0);
  const leafNodes = worktrees.flatMap((worktree) => [...worktree.agents, ...worktree.services]);

  return {
    project,
    worktrees,
    nodes,
    edges,
    summary: {
      worktrees: worktrees.length,
      agents: agentCount,
      services: serviceCount,
      active: leafNodes.filter((node) => node.health === "active").length,
      attention: leafNodes.filter((node) => node.health === "attention").length,
      offline: leafNodes.filter((node) => node.health === "offline").length,
    },
  };
}
