import { existsSync, readFileSync } from "node:fs";
import { getGraveyardPath, getProjectId, getRepoRoot } from "../paths.js";
import { readAllTasks, type Task } from "../tasks.js";
import { loadMetadataState } from "../metadata-store.js";
import type { SessionTeamMetadata } from "../team.js";
import {
  type RuntimeTopology,
  type RuntimeTopologyBinding,
  type RuntimeTopologyEdge,
  type RuntimeTopologyNode,
  type RuntimeTopologyQueueItem,
  type RuntimeTopologySession,
  type RuntimeTopologySessionStatus,
  createRuntimeTopologyStore,
  emptyRuntimeTopology,
} from "./topology-store.js";

interface LegacySessionLike {
  id: string;
  command?: string;
  tool?: string;
  toolConfigKey?: string;
  args?: string[];
  status?: string;
  lifecycle?: string;
  createdAt?: string;
  startTime?: number;
  backendSessionId?: string;
  team?: SessionTeamMetadata;
  worktreePath?: string;
  label?: string;
}

interface LegacyTmuxTargetLike {
  sessionName?: string;
  windowId?: string;
  windowIndex?: number;
  windowName?: string;
  paneId?: string;
}

interface BuildRuntimeTopologyInput {
  projectRoot: string;
  projectId: string;
  liveSessions?: LegacySessionLike[];
  offlineSessions?: LegacySessionLike[];
  graveyardSessions?: LegacySessionLike[];
  tasks?: Task[];
  metadataSessions?: Record<string, any>;
  sessionToolKeys?: Map<string, string>;
  sessionOriginalArgs?: Map<string, string[]>;
  sessionWorktreePaths?: Map<string, string>;
  sessionLabels?: Map<string, string>;
  sessionTmuxTargets?: Map<string, LegacyTmuxTargetLike>;
  now?: string;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${value.replace(/[^A-Za-z0-9_.:-]+/g, "-")}`;
}

function createdAtFor(session: LegacySessionLike, fallback: string): string {
  if (session.createdAt) return session.createdAt;
  if (typeof session.startTime === "number" && Number.isFinite(session.startTime)) {
    return new Date(session.startTime).toISOString();
  }
  return fallback;
}

function statusFor(session: LegacySessionLike, fallback: RuntimeTopologySessionStatus): RuntimeTopologySessionStatus {
  if (session.lifecycle === "offline") return "offline";
  if (session.lifecycle === "graveyard") return "graveyard";
  if (session.status === "idle") return "idle";
  if (session.status === "running") return "running";
  if (session.status === "error") return "error";
  if (session.lifecycle === "live") return "running";
  return fallback;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

function sessionNode(input: {
  session: LegacySessionLike;
  rigId: string;
  projectRoot: string;
  metadata?: any;
  sessionToolKeys?: Map<string, string>;
  sessionWorktreePaths?: Map<string, string>;
  sessionLabels?: Map<string, string>;
  now: string;
}): RuntimeTopologyNode {
  const { session, rigId, projectRoot, metadata, sessionToolKeys, sessionWorktreePaths, sessionLabels, now } = input;
  const toolConfigKey = sessionToolKeys?.get(session.id) ?? session.toolConfigKey ?? session.tool ?? session.command;
  return {
    id: stableId("node", session.id),
    rigId,
    logicalId: session.id,
    role: session.team?.role,
    runtime: session.tool ?? session.command ?? toolConfigKey,
    toolConfigKey,
    cwd: sessionWorktreePaths?.get(session.id) ?? session.worktreePath ?? metadata?.worktreePath ?? projectRoot,
    label: sessionLabels?.get(session.id) ?? session.label ?? metadata?.label ?? session.team?.label,
    createdAt: createdAtFor(session, now),
  };
}

function sessionRecord(input: {
  session: LegacySessionLike;
  nodeId: string;
  fallbackStatus: RuntimeTopologySessionStatus;
  metadata?: any;
  sessionOriginalArgs?: Map<string, string[]>;
  sessionWorktreePaths?: Map<string, string>;
  now: string;
}): RuntimeTopologySession {
  const { session, nodeId, fallbackStatus, metadata, sessionOriginalArgs, sessionWorktreePaths, now } = input;
  const createdAt = createdAtFor(session, now);
  return {
    id: session.id,
    nodeId,
    status: statusFor(session, fallbackStatus),
    tool: session.tool ?? session.command ?? session.toolConfigKey,
    command: session.command ?? session.tool,
    args: sessionOriginalArgs?.get(session.id) ?? session.args,
    backendSessionId: session.backendSessionId ?? metadata?.backendSessionId,
    worktreePath: sessionWorktreePaths?.get(session.id) ?? session.worktreePath ?? metadata?.worktreePath,
    createdAt,
    updatedAt: metadata?.updatedAt ?? now,
    lastSeenAt: metadata?.lastSeenAt ?? metadata?.derived?.lastSeenAt,
  };
}

function bindingFor(
  sessionId: string,
  nodeId: string,
  target?: LegacyTmuxTargetLike,
  now = new Date().toISOString(),
): RuntimeTopologyBinding | null {
  if (!target) return null;
  return {
    id: stableId("binding", sessionId),
    nodeId,
    tmuxSession: target.sessionName,
    tmuxWindowId: target.windowId,
    tmuxWindowIndex: target.windowIndex,
    tmuxWindowName: target.windowName,
    tmuxPane: target.paneId,
    updatedAt: now,
  };
}

function teammateEdges(sessions: LegacySessionLike[], rigId: string, now: string): RuntimeTopologyEdge[] {
  const known = new Set(sessions.map((session) => session.id));
  const edges: RuntimeTopologyEdge[] = [];
  for (const session of sessions) {
    const parentSessionId = session.team?.parentSessionId;
    if (!parentSessionId || !known.has(parentSessionId)) continue;
    edges.push({
      id: stableId("edge", `${parentSessionId}-delegates-${session.id}`),
      rigId,
      sourceNodeId: stableId("node", parentSessionId),
      targetNodeId: stableId("node", session.id),
      kind: "delegates",
      createdAt: now,
    });
  }
  return edges;
}

function queueStatus(task: Task): RuntimeTopologyQueueItem["status"] {
  return task.status === "pending" ? "queued" : task.status;
}

function queueItems(tasks: Task[], now: string): RuntimeTopologyQueueItem[] {
  return tasks.map((task) => ({
    id: task.id,
    sourceSessionId: task.assignedBy,
    targetSessionId: task.assignedTo,
    status: queueStatus(task),
    kind: "task",
    title: task.description,
    body: task.prompt,
    createdAt: task.createdAt ?? now,
    updatedAt: task.updatedAt ?? now,
  }));
}

export function buildRuntimeTopologyFromLegacyState(input: BuildRuntimeTopologyInput): RuntimeTopology {
  const now = input.now ?? new Date().toISOString();
  const rigId = stableId("rig", input.projectId);
  const topology = emptyRuntimeTopology(now);
  topology.rigs = [
    {
      id: rigId,
      name: input.projectId,
      projectRoot: input.projectRoot,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const liveSessions = uniqueById(input.liveSessions ?? []);
  const offlineSessions = uniqueById(input.offlineSessions ?? []).filter(
    (session) => !liveSessions.some((live) => live.id === session.id),
  );
  const graveyardSessions = uniqueById(input.graveyardSessions ?? []).filter(
    (session) =>
      !liveSessions.some((live) => live.id === session.id) &&
      !offlineSessions.some((offline) => offline.id === session.id),
  );
  const allSessions = [...liveSessions, ...offlineSessions, ...graveyardSessions];

  const nodes: RuntimeTopologyNode[] = [];
  const sessions: RuntimeTopologySession[] = [];
  const bindings: RuntimeTopologyBinding[] = [];

  for (const session of allSessions) {
    const metadata = input.metadataSessions?.[session.id];
    const node = sessionNode({
      session,
      rigId,
      projectRoot: input.projectRoot,
      metadata,
      sessionToolKeys: input.sessionToolKeys,
      sessionWorktreePaths: input.sessionWorktreePaths,
      sessionLabels: input.sessionLabels,
      now,
    });
    const fallbackStatus: RuntimeTopologySessionStatus = liveSessions.some((live) => live.id === session.id)
      ? "running"
      : graveyardSessions.some((graveyard) => graveyard.id === session.id)
        ? "graveyard"
        : "offline";
    nodes.push(node);
    sessions.push(
      sessionRecord({
        session,
        nodeId: node.id,
        fallbackStatus,
        metadata,
        sessionOriginalArgs: input.sessionOriginalArgs,
        sessionWorktreePaths: input.sessionWorktreePaths,
        now,
      }),
    );
    const binding = bindingFor(session.id, node.id, input.sessionTmuxTargets?.get(session.id), now);
    if (binding) bindings.push(binding);
  }

  topology.nodes = nodes;
  topology.sessions = sessions;
  topology.bindings = bindings;
  topology.edges = teammateEdges(allSessions, rigId, now);
  topology.queue = queueItems(input.tasks ?? [], now);
  return topology;
}

function readGraveyardSessions(): LegacySessionLike[] {
  const path = getGraveyardPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function projectHostRuntimeTopology(host: any): RuntimeTopology {
  const metadata = loadMetadataState();
  const topology = buildRuntimeTopologyFromLegacyState({
    projectRoot: getRepoRoot(),
    projectId: getProjectId(),
    liveSessions: host.sessions ?? [],
    offlineSessions: host.offlineSessions ?? [],
    graveyardSessions: readGraveyardSessions(),
    tasks: readAllTasks(),
    metadataSessions: metadata.sessions,
    sessionToolKeys: host.sessionToolKeys,
    sessionOriginalArgs: host.sessionOriginalArgs,
    sessionWorktreePaths: host.sessionWorktreePaths,
    sessionLabels: host.sessionLabels,
    sessionTmuxTargets: host.sessionTmuxTargets,
  });
  createRuntimeTopologyStore().write(topology);
  return topology;
}
