import { basename } from "node:path";
import { getProjectId, getRepoRoot, withProjectPaths } from "../paths.js";
import {
  createRuntimeTopologyStore,
  emptyRuntimeTopology,
  type RuntimeTopology,
  type RuntimeTopologyBinding,
  type RuntimeTopologyNode,
  type RuntimeTopologySession,
  type RuntimeTopologySessionStatus,
  type RuntimeTopologyStore,
} from "./topology-store.js";

export type RuntimeTopologySessionState = {
  id: string;
  tool: string;
  toolConfigKey: string;
  command: string;
  args: string[];
  status?: RuntimeTopologySessionStatus;
  lifecycle?: "live" | "offline";
  createdAt?: string;
  updatedAt?: string;
  backendSessionId?: string;
  team?: unknown;
  worktreePath?: string;
  label?: string;
  headline?: string;
  freshRelaunchAllowed?: boolean;
  restoreBlockedReason?: string;
  graveyardReason?: string;
  tmuxTarget?: {
    sessionName: string;
    windowId: string;
    windowIndex: number;
    windowName: string;
  };
  graveyardedAt?: string;
};

type SaveRuntimeTopologySessionsInput = {
  sessions: RuntimeTopologySessionState[];
  projectRoot?: string;
  now?: string;
  store?: RuntimeTopologyStore;
};

type ReconcileRuntimeTopologySessionsInput = SaveRuntimeTopologySessionsInput & {
  removedSessionIds?: Iterable<string>;
};

function sessionStateKey(session: RuntimeTopologySessionState): string {
  return session.backendSessionId ? `backend:${session.backendSessionId}` : `id:${session.id}`;
}

function isRecoverableExistingSession(session: RuntimeTopologySessionState): boolean {
  if (!session.id || !(session.command || session.tool || session.toolConfigKey)) return false;
  if (session.lifecycle === "offline") return true;
  if (session.lifecycle === "live") return true;
  if (session.status === "offline" || session.status === "running" || session.status === "idle") return true;
  return false;
}

function dedupeSessionStates(sessions: RuntimeTopologySessionState[]): RuntimeTopologySessionState[] {
  const byKey = new Map<string, RuntimeTopologySessionState>();
  for (const session of sessions) {
    const key = sessionStateKey(session);
    byKey.delete(key);
    byKey.set(key, session);
  }
  return [...byKey.values()];
}

function nodeIdForSession(sessionId: string): string {
  return `agent:${sessionId}`;
}

function bindingIdForSession(sessionId: string): string {
  return `tmux:${sessionId}`;
}

function statusFromLifecycle(lifecycle: RuntimeTopologySessionState["lifecycle"]): RuntimeTopologySessionStatus {
  return lifecycle === "offline" ? "offline" : "running";
}

function lifecycleFromStatus(status: RuntimeTopologySessionStatus): "live" | "offline" | undefined {
  if (status === "offline") return "offline";
  if (status === "graveyard") return undefined;
  return "live";
}

function ensureRig(topology: RuntimeTopology, projectRoot: string, now: string): string {
  const id = getProjectId();
  const existing = topology.rigs.find((rig) => rig.id === id);
  if (existing) {
    existing.projectRoot = projectRoot;
    existing.name = basename(projectRoot);
    existing.updatedAt = now;
    return existing.id;
  }
  topology.rigs.push({
    id,
    name: basename(projectRoot),
    projectRoot,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function upsertNode(
  topology: RuntimeTopology,
  session: RuntimeTopologySessionState,
  rigId: string,
  now: string,
): RuntimeTopologyNode {
  const nodeId = nodeIdForSession(session.id);
  const existing = topology.nodes.find((node) => node.id === nodeId);
  const next: RuntimeTopologyNode = {
    id: nodeId,
    rigId,
    logicalId: session.id,
    role: typeof (session.team as any)?.role === "string" ? (session.team as any).role : undefined,
    runtime: session.toolConfigKey ?? session.tool ?? session.command,
    toolConfigKey: session.toolConfigKey ?? session.tool ?? session.command,
    cwd: session.worktreePath,
    label: session.label,
    createdAt: existing?.createdAt ?? session.createdAt ?? now,
  };
  if (existing) {
    Object.assign(existing, next);
    return existing;
  }
  topology.nodes.push(next);
  return next;
}

function sessionToTopologySession(
  session: RuntimeTopologySessionState,
  nodeId: string,
  now: string,
): RuntimeTopologySession {
  return {
    id: session.id,
    nodeId,
    status: statusFromLifecycle(session.lifecycle),
    tool: session.tool,
    command: session.command,
    args: session.args ?? [],
    backendSessionId: session.backendSessionId,
    worktreePath: session.worktreePath,
    label: session.label,
    headline: session.headline,
    freshRelaunchAllowed: session.lifecycle === "offline" ? session.freshRelaunchAllowed : undefined,
    restoreBlockedReason: session.lifecycle === "offline" ? session.restoreBlockedReason : undefined,
    graveyardReason: session.graveyardReason,
    team: session.team,
    createdAt: session.createdAt ?? now,
    updatedAt: now,
    lastSeenAt: session.lifecycle === "offline" ? undefined : now,
    graveyardedAt: session.graveyardedAt,
  };
}

function sessionToBinding(
  session: RuntimeTopologySessionState,
  nodeId: string,
  now: string,
): RuntimeTopologyBinding | undefined {
  if (session.lifecycle === "offline") return undefined;
  const target = session.tmuxTarget;
  if (!target) return undefined;
  return {
    id: bindingIdForSession(session.id),
    nodeId,
    tmuxSession: target.sessionName,
    tmuxWindowId: target.windowId,
    tmuxWindowIndex: target.windowIndex,
    tmuxWindowName: target.windowName,
    updatedAt: now,
  };
}

export function topologySessionToSessionState(
  session: RuntimeTopologySession,
  topology: RuntimeTopology,
): RuntimeTopologySessionState {
  const node = topology.nodes.find((entry) => entry.id === session.nodeId);
  const binding =
    session.status === "running" || session.status === "idle" || session.status === "starting"
      ? topology.bindings.find((entry) => entry.nodeId === session.nodeId)
      : undefined;
  const tool = session.tool ?? node?.toolConfigKey ?? session.command ?? "unknown";
  return {
    id: session.id,
    tool,
    toolConfigKey: node?.toolConfigKey ?? tool,
    command: session.command ?? tool,
    args: session.args ?? [],
    status: session.status,
    lifecycle: lifecycleFromStatus(session.status),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    backendSessionId: session.backendSessionId,
    team: session.team,
    worktreePath: session.worktreePath ?? node?.cwd,
    label: session.label ?? node?.label,
    headline: session.headline,
    freshRelaunchAllowed: session.freshRelaunchAllowed,
    restoreBlockedReason: session.restoreBlockedReason,
    graveyardedAt: session.graveyardedAt,
    graveyardReason: session.graveyardReason,
    tmuxTarget:
      binding?.tmuxSession && binding.tmuxWindowId && typeof binding.tmuxWindowIndex === "number"
        ? {
            sessionName: binding.tmuxSession,
            windowId: binding.tmuxWindowId,
            windowIndex: binding.tmuxWindowIndex,
            windowName: binding.tmuxWindowName ?? session.command ?? tool,
          }
        : undefined,
  };
}

export function listTopologySessionStates(input?: {
  statuses?: RuntimeTopologySessionStatus[];
  store?: RuntimeTopologyStore;
  projectRoot?: string;
}): RuntimeTopologySessionState[] {
  const readTopology = () => (input?.store ?? createRuntimeTopologyStore()).read();
  const topology =
    input?.projectRoot && !input.store ? withProjectPaths(input.projectRoot, readTopology) : readTopology();
  const statuses = input?.statuses ? new Set(input.statuses) : undefined;
  return topology.sessions
    .filter((session) => !statuses || statuses.has(session.status))
    .map((session) => topologySessionToSessionState(session, topology));
}

export function saveRuntimeTopologySessions(input: SaveRuntimeTopologySessionsInput): RuntimeTopology {
  const store = input.store ?? createRuntimeTopologyStore();
  const now = input.now ?? new Date().toISOString();
  const projectRoot = input.projectRoot ?? getRepoRoot();
  return store.update((current) => {
    const topology = current.version ? current : emptyRuntimeTopology(now);
    return replaceRuntimeTopologySessions(topology, input.sessions, projectRoot, now);
  });
}

export function reconcileRuntimeTopologySessions(input: ReconcileRuntimeTopologySessionsInput): RuntimeTopology {
  const store = input.store ?? createRuntimeTopologyStore();
  const now = input.now ?? new Date().toISOString();
  const projectRoot = input.projectRoot ?? getRepoRoot();
  return store.update((current) => {
    const topology = current.version ? current : emptyRuntimeTopology(now);
    const removedSessionIds = new Set(input.removedSessionIds ?? []);
    const topologySessions = topology.sessions
      .filter((session) => session.status === "running" || session.status === "idle" || session.status === "offline")
      .map((session) => topologySessionToSessionState(session, topology));
    const topologyByKey = new Map(topologySessions.map((session) => [sessionStateKey(session), session]));
    const topologyById = new Map(topologySessions.map((session) => [session.id, session]));
    const incomingSessions = dedupeSessionStates(
      input.sessions.map((session) => {
        if (session.lifecycle !== "offline") return session;
        const existing =
          topologyByKey.get(sessionStateKey(session)) ??
          (!session.backendSessionId ? topologyById.get(session.id) : undefined);
        if (!existing) return session;
        return {
          ...session,
          backendSessionId: session.backendSessionId ?? existing.backendSessionId,
          freshRelaunchAllowed: session.freshRelaunchAllowed ?? existing.freshRelaunchAllowed,
          restoreBlockedReason: session.restoreBlockedReason ?? existing.restoreBlockedReason,
        };
      }),
    );
    const incomingBackendIds = new Set(incomingSessions.map((session) => session.backendSessionId).filter(Boolean));
    const incomingIds = new Set(incomingSessions.map((session) => session.id));
    const preservedSessions = topologySessions.filter((session) => {
      if (removedSessionIds.has(session.id)) return false;
      if (session.backendSessionId && incomingBackendIds.has(session.backendSessionId)) return false;
      if (incomingIds.has(session.id)) return false;
      return isRecoverableExistingSession(session);
    });
    return replaceRuntimeTopologySessions(
      topology,
      dedupeSessionStates([...preservedSessions, ...incomingSessions]),
      projectRoot,
      now,
    );
  });
}

function replaceRuntimeTopologySessions(
  topology: RuntimeTopology,
  sessions: RuntimeTopologySessionState[],
  projectRoot: string,
  now: string,
): RuntimeTopology {
  topology.generatedAt = now;
  const rigId = ensureRig(topology, projectRoot, now);
  const nextSessionIds = new Set(sessions.map((session) => session.id));
  const preservedGraveyard = topology.sessions.filter(
    (session) => session.status === "graveyard" && !nextSessionIds.has(session.id),
  );
  const nextNodes: RuntimeTopologyNode[] = [];
  const nextBindings: RuntimeTopologyBinding[] = [];
  const nextSessions: RuntimeTopologySession[] = [];
  for (const session of sessions) {
    const node = upsertNode(topology, session, rigId, now);
    nextNodes.push(node);
    const binding = sessionToBinding(session, node.id, now);
    if (binding) nextBindings.push(binding);
    nextSessions.push(sessionToTopologySession(session, node.id, now));
  }
  const activeNodeIds = new Set(nextNodes.map((node) => node.id));
  const preservedServiceNodeIds = new Set(topology.services.map((service) => service.nodeId).filter(Boolean));
  const preservedNodes = topology.nodes.filter(
    (node) => preservedServiceNodeIds.has(node.id) || preservedGraveyard.some((session) => session.nodeId === node.id),
  );
  topology.nodes = [...preservedNodes.filter((node) => !activeNodeIds.has(node.id)), ...nextNodes];
  topology.bindings = [
    ...topology.bindings.filter((binding) => preservedServiceNodeIds.has(binding.nodeId)),
    ...nextBindings,
  ];
  topology.sessions = [...preservedGraveyard, ...nextSessions];
  const retainedNodeIds = new Set(topology.nodes.map((node) => node.id));
  topology.edges = topology.edges.filter(
    (edge) => retainedNodeIds.has(edge.sourceNodeId) && retainedNodeIds.has(edge.targetNodeId),
  );
  const retainedSessionIds = new Set(topology.sessions.map((session) => session.id));
  topology.exchangeRefs = topology.exchangeRefs.filter(
    (ref) =>
      (!ref.sessionId || retainedSessionIds.has(ref.sessionId)) && (!ref.nodeId || retainedNodeIds.has(ref.nodeId)),
  );
  return topology;
}

export function upsertTopologySession(
  session: RuntimeTopologySessionState,
  status: RuntimeTopologySessionStatus,
  input?: { store?: RuntimeTopologyStore; now?: string; projectRoot?: string },
): RuntimeTopology {
  const store = input?.store ?? createRuntimeTopologyStore();
  const now = input?.now ?? new Date().toISOString();
  const projectRoot = input?.projectRoot ?? getRepoRoot();
  return store.update((topology) => {
    topology.generatedAt = now;
    const rigId = ensureRig(topology, projectRoot, now);
    const node = upsertNode(topology, session, rigId, now);
    const nextSession = { ...sessionToTopologySession(session, node.id, now), status };
    if (status !== "offline") {
      delete nextSession.restoreBlockedReason;
    }
    if (status !== "graveyard") {
      delete nextSession.graveyardedAt;
      delete nextSession.graveyardReason;
    }
    topology.sessions = [...topology.sessions.filter((entry) => entry.id !== session.id), nextSession];
    const shouldBind = status === "running" || status === "idle" || status === "starting";
    const binding = shouldBind ? sessionToBinding({ ...session, lifecycle: "live" }, node.id, now) : undefined;
    topology.bindings = binding
      ? [...topology.bindings.filter((entry) => entry.id !== binding.id), binding]
      : topology.bindings.filter((entry) => entry.nodeId !== node.id);
    return topology;
  });
}

export function moveTopologySessionToGraveyard(
  sessionId: string,
  input?: { store?: RuntimeTopologyStore; now?: string; reason?: string },
): RuntimeTopologySessionState | undefined {
  const store = input?.store ?? createRuntimeTopologyStore();
  const now = input?.now ?? new Date().toISOString();
  let moved: RuntimeTopologySessionState | undefined;
  store.update((topology) => {
    const existing = topology.sessions.find((entry) => entry.id === sessionId);
    if (existing) {
      existing.status = "graveyard";
      existing.updatedAt = now;
      existing.graveyardedAt ??= now;
      delete existing.restoreBlockedReason;
      if (input?.reason) existing.graveyardReason = input.reason;
      topology.bindings = topology.bindings.filter((binding) => binding.nodeId !== existing.nodeId);
      moved = topologySessionToSessionState(existing, topology);
      return topology;
    }
    return topology;
  });
  return moved;
}

export function removeTopologySessionsForWorktree(
  worktreePath: string,
  input?: { store?: RuntimeTopologyStore; now?: string },
): RuntimeTopologySessionState[] {
  const store = input?.store ?? createRuntimeTopologyStore();
  const now = input?.now ?? new Date().toISOString();
  let removed: RuntimeTopologySessionState[] = [];
  store.update((topology) => {
    const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
    const removing = topology.sessions.filter(
      (session) => (session.worktreePath ?? nodeById.get(session.nodeId)?.cwd) === worktreePath,
    );
    if (removing.length === 0) return topology;
    const removingSessionIds = new Set(removing.map((session) => session.id));
    const removingNodeIds = new Set(removing.map((session) => session.nodeId));
    removed = removing.map((session) => topologySessionToSessionState(session, topology));
    topology.generatedAt = now;
    topology.sessions = topology.sessions.filter((session) => !removingSessionIds.has(session.id));
    topology.bindings = topology.bindings.filter((binding) => !removingNodeIds.has(binding.nodeId));
    topology.nodes = topology.nodes.filter((node) => !removingNodeIds.has(node.id));
    topology.edges = topology.edges.filter(
      (edge) => !removingNodeIds.has(edge.sourceNodeId) && !removingNodeIds.has(edge.targetNodeId),
    );
    topology.teamRoles = topology.teamRoles.filter(
      (role) => !removingNodeIds.has(role.nodeId ?? "") && !removingNodeIds.has(role.parentNodeId ?? ""),
    );
    topology.remoteClients = topology.remoteClients.map((client) => ({
      ...client,
      ownsSessionIds: client.ownsSessionIds?.filter((id) => !removingSessionIds.has(id)),
    }));
    topology.lifecycleOperations = topology.lifecycleOperations.filter(
      (operation) => !(operation.targetKind === "session" && removingSessionIds.has(operation.targetId)),
    );
    topology.exchangeRefs = topology.exchangeRefs.filter(
      (ref) =>
        (!ref.sessionId || !removingSessionIds.has(ref.sessionId)) && (!ref.nodeId || !removingNodeIds.has(ref.nodeId)),
    );
    return topology;
  });
  return removed;
}

export function removeTopologySession(
  sessionId: string,
  input?: { store?: RuntimeTopologyStore; now?: string },
): RuntimeTopologySessionState | undefined {
  const store = input?.store ?? createRuntimeTopologyStore();
  const now = input?.now ?? new Date().toISOString();
  let removed: RuntimeTopologySessionState | undefined;
  store.update((topology) => {
    const existing = topology.sessions.find((session) => session.id === sessionId);
    if (!existing) return topology;
    removed = topologySessionToSessionState(existing, topology);
    topology.generatedAt = now;
    topology.sessions = topology.sessions.filter((session) => session.id !== sessionId);
    topology.bindings = topology.bindings.filter((binding) => binding.nodeId !== existing.nodeId);
    topology.nodes = topology.nodes.filter((node) => node.id !== existing.nodeId);
    topology.edges = topology.edges.filter(
      (edge) => edge.sourceNodeId !== existing.nodeId && edge.targetNodeId !== existing.nodeId,
    );
    topology.teamRoles = topology.teamRoles.filter(
      (role) => role.nodeId !== existing.nodeId && role.parentNodeId !== existing.nodeId,
    );
    topology.remoteClients = topology.remoteClients.map((client) => ({
      ...client,
      ownsSessionIds: client.ownsSessionIds?.filter((id) => id !== sessionId),
    }));
    topology.lifecycleOperations = topology.lifecycleOperations.filter(
      (operation) => !(operation.targetKind === "session" && operation.targetId === sessionId),
    );
    topology.exchangeRefs = topology.exchangeRefs.filter(
      (ref) => ref.sessionId !== sessionId && ref.nodeId !== existing.nodeId,
    );
    return topology;
  });
  return removed;
}

export function resurrectTopologySession(sessionId: string, input?: { store?: RuntimeTopologyStore; now?: string }) {
  const store = input?.store ?? createRuntimeTopologyStore();
  const now = input?.now ?? new Date().toISOString();
  let restored: RuntimeTopologySessionState | undefined;
  store.update((topology) => {
    const session = topology.sessions.find((entry) => entry.id === sessionId && entry.status === "graveyard");
    if (!session) return topology;
    session.status = "offline";
    session.updatedAt = now;
    delete session.graveyardedAt;
    delete session.graveyardReason;
    delete session.restoreBlockedReason;
    topology.bindings = topology.bindings.filter((binding) => binding.nodeId !== session.nodeId);
    restored = topologySessionToSessionState(session, topology);
    return topology;
  });
  return restored;
}
