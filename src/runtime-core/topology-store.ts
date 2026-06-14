import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWrite } from "../atomic-write.js";
import { getRuntimeTopologyPath } from "../paths.js";

export const RUNTIME_TOPOLOGY_VERSION = 1;
const UPDATE_LOCK_TIMEOUT_MS = 5_000;
const UPDATE_LOCK_RETRY_MS = 25;
// Reclaim a lock whose owner process is gone after a short grace (covers the
// window between mkdir and the owner file being written), or one held far
// longer than any real update could take (a hung process or a reused PID).
const LOCK_STALE_GRACE_MS = 1_000;
const LOCK_STALE_MAX_MS = 60_000;

export type RuntimeTopologySessionStatus =
  | "planned"
  | "starting"
  | "running"
  | "idle"
  | "offline"
  | "graveyard"
  | "error";

export type RuntimeTopologyServiceStatus = "planned" | "starting" | "running" | "stopped" | "offline" | "error";
export type RuntimeTopologyWorktreeStatus =
  | "planned"
  | "creating"
  | "active"
  | "removing"
  | "graveyard"
  | "missing"
  | "error";
export type RuntimeTopologyLifecycleOperationStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type RuntimeTopologyLifecycleOperationTargetKind = "session" | "service" | "worktree" | "node" | "rig";

export interface RuntimeTopologyRig {
  id: string;
  name: string;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeTopologyNode {
  id: string;
  rigId: string;
  logicalId: string;
  role?: string;
  runtime?: string;
  toolConfigKey?: string;
  model?: string;
  cwd?: string;
  label?: string;
  createdAt: string;
}

export interface RuntimeTopologyEdge {
  id: string;
  rigId: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: string;
  createdAt: string;
}

export interface RuntimeTopologyBinding {
  id: string;
  nodeId: string;
  tmuxSession?: string;
  tmuxWindowId?: string;
  tmuxWindowIndex?: number;
  tmuxWindowName?: string;
  tmuxPane?: string;
  updatedAt: string;
}

export interface RuntimeTopologySession {
  id: string;
  nodeId: string;
  status: RuntimeTopologySessionStatus;
  tool?: string;
  command?: string;
  args?: string[];
  backendSessionId?: string;
  worktreePath?: string;
  label?: string;
  headline?: string;
  graveyardReason?: string;
  team?: unknown;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  graveyardedAt?: string;
}

export interface RuntimeTopologyService {
  id: string;
  rigId: string;
  nodeId?: string;
  status: RuntimeTopologyServiceStatus;
  command?: string;
  args?: string[];
  launchCommandLine?: string;
  worktreePath?: string;
  cwd?: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
}

export interface RuntimeTopologyWorktree {
  id: string;
  rigId: string;
  path: string;
  name: string;
  status: RuntimeTopologyWorktreeStatus;
  branch?: string;
  head?: string;
  basePath?: string;
  createdAt: string;
  updatedAt: string;
  removedAt?: string;
  operationFailure?: string;
}

export interface RuntimeTopologyWorktreeGraveyardEntry {
  id: string;
  rigId: string;
  worktreeId?: string;
  path: string;
  name?: string;
  branch?: string;
  graveyardedAt: string;
  reason?: string;
  deletedAt?: string;
}

export interface RuntimeTopologyTeamRole {
  id: string;
  rigId: string;
  nodeId?: string;
  parentNodeId?: string;
  role: string;
  label?: string;
  order?: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeTopologyRemoteClient {
  id: string;
  rigId: string;
  userId?: string;
  displayName?: string;
  shareId?: string;
  ownerUserId?: string;
  status: "online" | "stale" | "offline";
  connectedAt?: string;
  lastSeenAt: string;
  ownsSessionIds?: string[];
}

export interface RuntimeTopologyLifecycleOperation {
  id: string;
  rigId: string;
  kind: string;
  status: RuntimeTopologyLifecycleOperationStatus;
  targetKind: RuntimeTopologyLifecycleOperationTargetKind;
  targetId: string;
  requestedBy?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
}

export interface RuntimeTopologyExchangeRef {
  id: string;
  rigId: string;
  kind: "message" | "handoff" | "task" | "review" | "plan" | "wait" | "continuity" | "attachment";
  exchangeId: string;
  nodeId?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeTopology {
  version: typeof RUNTIME_TOPOLOGY_VERSION;
  generatedAt: string;
  rigs: RuntimeTopologyRig[];
  nodes: RuntimeTopologyNode[];
  edges: RuntimeTopologyEdge[];
  bindings: RuntimeTopologyBinding[];
  sessions: RuntimeTopologySession[];
  services: RuntimeTopologyService[];
  worktrees: RuntimeTopologyWorktree[];
  worktreeGraveyard: RuntimeTopologyWorktreeGraveyardEntry[];
  teamRoles: RuntimeTopologyTeamRole[];
  remoteClients: RuntimeTopologyRemoteClient[];
  lifecycleOperations: RuntimeTopologyLifecycleOperation[];
  exchangeRefs: RuntimeTopologyExchangeRef[];
}

export function emptyRuntimeTopology(now = new Date().toISOString()): RuntimeTopology {
  return {
    version: RUNTIME_TOPOLOGY_VERSION,
    generatedAt: now,
    rigs: [],
    nodes: [],
    edges: [],
    bindings: [],
    sessions: [],
    services: [],
    worktrees: [],
    worktreeGraveyard: [],
    teamRoles: [],
    remoteClients: [],
    lifecycleOperations: [],
    exchangeRefs: [],
  };
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid runtime topology: ${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid runtime topology: ${context} must be a non-empty string`);
  }
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => String(entry));
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeRuntimeTopology(topology: RuntimeTopology): RuntimeTopology {
  const rigIds = new Set(topology.rigs.map((rig) => rig.id));
  const nodes = topology.nodes.filter((node) => rigIds.has(node.rigId));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const sessions = topology.sessions.filter((session) => nodeIds.has(session.nodeId));
  const sessionIds = new Set(sessions.map((session) => session.id));
  const services = topology.services.filter(
    (service) => rigIds.has(service.rigId) && (!service.nodeId || nodeIds.has(service.nodeId)),
  );
  const serviceIds = new Set(services.map((service) => service.id));
  const worktrees = topology.worktrees.filter((worktree) => rigIds.has(worktree.rigId));
  const worktreeIds = new Set(worktrees.map((worktree) => worktree.id));

  const hasLifecycleTarget = (operation: RuntimeTopologyLifecycleOperation): boolean => {
    if (operation.targetKind === "rig") return rigIds.has(operation.targetId);
    if (operation.targetKind === "node") return nodeIds.has(operation.targetId);
    if (operation.targetKind === "session") return sessionIds.has(operation.targetId);
    if (operation.targetKind === "service") return serviceIds.has(operation.targetId);
    return worktreeIds.has(operation.targetId);
  };

  return {
    ...topology,
    nodes,
    edges: topology.edges.filter(
      (edge) => rigIds.has(edge.rigId) && nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId),
    ),
    bindings: topology.bindings.filter((binding) => nodeIds.has(binding.nodeId)),
    sessions,
    services,
    worktrees,
    worktreeGraveyard: topology.worktreeGraveyard.filter((entry) => rigIds.has(entry.rigId)),
    teamRoles: topology.teamRoles.filter(
      (role) =>
        rigIds.has(role.rigId) &&
        (!role.nodeId || nodeIds.has(role.nodeId)) &&
        (!role.parentNodeId || nodeIds.has(role.parentNodeId)),
    ),
    remoteClients: topology.remoteClients
      .filter((client) => rigIds.has(client.rigId))
      .map((client) => ({
        ...client,
        ownsSessionIds: client.ownsSessionIds?.filter((sessionId) => sessionIds.has(sessionId)),
      })),
    lifecycleOperations: topology.lifecycleOperations.filter(
      (operation) => rigIds.has(operation.rigId) && hasLifecycleTarget(operation),
    ),
    exchangeRefs: topology.exchangeRefs.filter(
      (ref) =>
        rigIds.has(ref.rigId) &&
        (!ref.nodeId || nodeIds.has(ref.nodeId)) &&
        (!ref.sessionId || sessionIds.has(ref.sessionId)),
    ),
  };
}

function coerceRuntimeTopology(raw: unknown): RuntimeTopology {
  const record = asRecord(raw, "root");
  if (record.version !== RUNTIME_TOPOLOGY_VERSION) {
    throw new Error(`unsupported runtime topology version: ${String(record.version)}`);
  }
  return normalizeRuntimeTopology({
    version: RUNTIME_TOPOLOGY_VERSION,
    generatedAt: asString(record.generatedAt, "generatedAt"),
    rigs: asArray(record.rigs).map((entry, index) => {
      const row = asRecord(entry, `rigs[${index}]`);
      return {
        id: asString(row.id, `rigs[${index}].id`),
        name: asString(row.name, `rigs[${index}].name`),
        projectRoot: asString(row.projectRoot, `rigs[${index}].projectRoot`),
        createdAt: asString(row.createdAt, `rigs[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `rigs[${index}].updatedAt`),
      };
    }),
    nodes: asArray(record.nodes).map((entry, index) => {
      const row = asRecord(entry, `nodes[${index}]`);
      return {
        id: asString(row.id, `nodes[${index}].id`),
        rigId: asString(row.rigId, `nodes[${index}].rigId`),
        logicalId: asString(row.logicalId, `nodes[${index}].logicalId`),
        role: asOptionalString(row.role),
        runtime: asOptionalString(row.runtime),
        toolConfigKey: asOptionalString(row.toolConfigKey),
        model: asOptionalString(row.model),
        cwd: asOptionalString(row.cwd),
        label: asOptionalString(row.label),
        createdAt: asString(row.createdAt, `nodes[${index}].createdAt`),
      };
    }),
    edges: asArray(record.edges).map((entry, index) => {
      const row = asRecord(entry, `edges[${index}]`);
      return {
        id: asString(row.id, `edges[${index}].id`),
        rigId: asString(row.rigId, `edges[${index}].rigId`),
        sourceNodeId: asString(row.sourceNodeId, `edges[${index}].sourceNodeId`),
        targetNodeId: asString(row.targetNodeId, `edges[${index}].targetNodeId`),
        kind: asString(row.kind, `edges[${index}].kind`),
        createdAt: asString(row.createdAt, `edges[${index}].createdAt`),
      };
    }),
    bindings: asArray(record.bindings).map((entry, index) => {
      const row = asRecord(entry, `bindings[${index}]`);
      return {
        id: asString(row.id, `bindings[${index}].id`),
        nodeId: asString(row.nodeId, `bindings[${index}].nodeId`),
        tmuxSession: asOptionalString(row.tmuxSession),
        tmuxWindowId: asOptionalString(row.tmuxWindowId),
        tmuxWindowIndex: asOptionalNumber(row.tmuxWindowIndex),
        tmuxWindowName: asOptionalString(row.tmuxWindowName),
        tmuxPane: asOptionalString(row.tmuxPane),
        updatedAt: asString(row.updatedAt, `bindings[${index}].updatedAt`),
      };
    }),
    sessions: asArray(record.sessions).map((entry, index) => {
      const row = asRecord(entry, `sessions[${index}]`);
      return {
        id: asString(row.id, `sessions[${index}].id`),
        nodeId: asString(row.nodeId, `sessions[${index}].nodeId`),
        status: asRuntimeSessionStatus(row.status),
        tool: asOptionalString(row.tool),
        command: asOptionalString(row.command),
        args: asStringArray(row.args),
        backendSessionId: asOptionalString(row.backendSessionId),
        worktreePath: asOptionalString(row.worktreePath),
        label: asOptionalString(row.label),
        headline: asOptionalString(row.headline),
        graveyardReason: asOptionalString(row.graveyardReason),
        team: row.team,
        createdAt: asString(row.createdAt, `sessions[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `sessions[${index}].updatedAt`),
        lastSeenAt: asOptionalString(row.lastSeenAt),
        graveyardedAt: asOptionalString(row.graveyardedAt),
      };
    }),
    services: asArray(record.services).map((entry, index) => {
      const row = asRecord(entry, `services[${index}]`);
      return {
        id: asString(row.id, `services[${index}].id`),
        rigId: asString(row.rigId, `services[${index}].rigId`),
        nodeId: asOptionalString(row.nodeId),
        status: asServiceStatus(row.status),
        command: asOptionalString(row.command),
        args: asStringArray(row.args),
        launchCommandLine: asOptionalString(row.launchCommandLine),
        worktreePath: asOptionalString(row.worktreePath),
        cwd: asOptionalString(row.cwd),
        label: asOptionalString(row.label),
        createdAt: asString(row.createdAt, `services[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `services[${index}].updatedAt`),
        lastSeenAt: asOptionalString(row.lastSeenAt),
      };
    }),
    worktrees: asArray(record.worktrees).map((entry, index) => {
      const row = asRecord(entry, `worktrees[${index}]`);
      return {
        id: asString(row.id, `worktrees[${index}].id`),
        rigId: asString(row.rigId, `worktrees[${index}].rigId`),
        path: asString(row.path, `worktrees[${index}].path`),
        name: asString(row.name, `worktrees[${index}].name`),
        status: asWorktreeStatus(row.status),
        branch: asOptionalString(row.branch),
        head: asOptionalString(row.head),
        basePath: asOptionalString(row.basePath),
        createdAt: asString(row.createdAt, `worktrees[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `worktrees[${index}].updatedAt`),
        removedAt: asOptionalString(row.removedAt),
        operationFailure: asOptionalString(row.operationFailure),
      };
    }),
    worktreeGraveyard: asArray(record.worktreeGraveyard).map((entry, index) => {
      const row = asRecord(entry, `worktreeGraveyard[${index}]`);
      return {
        id: asString(row.id, `worktreeGraveyard[${index}].id`),
        rigId: asString(row.rigId, `worktreeGraveyard[${index}].rigId`),
        worktreeId: asOptionalString(row.worktreeId),
        path: asString(row.path, `worktreeGraveyard[${index}].path`),
        name: asOptionalString(row.name),
        branch: asOptionalString(row.branch),
        graveyardedAt: asString(row.graveyardedAt, `worktreeGraveyard[${index}].graveyardedAt`),
        reason: asOptionalString(row.reason),
        deletedAt: asOptionalString(row.deletedAt),
      };
    }),
    teamRoles: asArray(record.teamRoles).map((entry, index) => {
      const row = asRecord(entry, `teamRoles[${index}]`);
      return {
        id: asString(row.id, `teamRoles[${index}].id`),
        rigId: asString(row.rigId, `teamRoles[${index}].rigId`),
        nodeId: asOptionalString(row.nodeId),
        parentNodeId: asOptionalString(row.parentNodeId),
        role: asString(row.role, `teamRoles[${index}].role`),
        label: asOptionalString(row.label),
        order: asOptionalNumber(row.order),
        createdAt: asString(row.createdAt, `teamRoles[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `teamRoles[${index}].updatedAt`),
      };
    }),
    remoteClients: asArray(record.remoteClients).map((entry, index) => {
      const row = asRecord(entry, `remoteClients[${index}]`);
      return {
        id: asString(row.id, `remoteClients[${index}].id`),
        rigId: asString(row.rigId, `remoteClients[${index}].rigId`),
        userId: asOptionalString(row.userId),
        displayName: asOptionalString(row.displayName),
        shareId: asOptionalString(row.shareId),
        ownerUserId: asOptionalString(row.ownerUserId),
        status: asRemoteClientStatus(row.status),
        connectedAt: asOptionalString(row.connectedAt),
        lastSeenAt: asString(row.lastSeenAt, `remoteClients[${index}].lastSeenAt`),
        ownsSessionIds: asStringArray(row.ownsSessionIds),
      };
    }),
    lifecycleOperations: asArray(record.lifecycleOperations).map((entry, index) => {
      const row = asRecord(entry, `lifecycleOperations[${index}]`);
      return {
        id: asString(row.id, `lifecycleOperations[${index}].id`),
        rigId: asString(row.rigId, `lifecycleOperations[${index}].rigId`),
        kind: asString(row.kind, `lifecycleOperations[${index}].kind`),
        status: asLifecycleOperationStatus(row.status),
        targetKind: asLifecycleOperationTargetKind(row.targetKind, `lifecycleOperations[${index}].targetKind`),
        targetId: asString(row.targetId, `lifecycleOperations[${index}].targetId`),
        requestedBy: asOptionalString(row.requestedBy),
        startedAt: asString(row.startedAt, `lifecycleOperations[${index}].startedAt`),
        updatedAt: asString(row.updatedAt, `lifecycleOperations[${index}].updatedAt`),
        completedAt: asOptionalString(row.completedAt),
        error: asOptionalString(row.error),
      };
    }),
    exchangeRefs: asArray(record.exchangeRefs).map((entry, index) => {
      const row = asRecord(entry, `exchangeRefs[${index}]`);
      return {
        id: asString(row.id, `exchangeRefs[${index}].id`),
        rigId: asString(row.rigId, `exchangeRefs[${index}].rigId`),
        kind: asExchangeRefKind(row.kind, `exchangeRefs[${index}].kind`),
        exchangeId: asString(row.exchangeId, `exchangeRefs[${index}].exchangeId`),
        nodeId: asOptionalString(row.nodeId),
        sessionId: asOptionalString(row.sessionId),
        createdAt: asString(row.createdAt, `exchangeRefs[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `exchangeRefs[${index}].updatedAt`),
      };
    }),
  });
}

function asRuntimeSessionStatus(value: unknown): RuntimeTopologySessionStatus {
  const status = String(value);
  if (
    status === "planned" ||
    status === "starting" ||
    status === "running" ||
    status === "idle" ||
    status === "offline" ||
    status === "graveyard" ||
    status === "error"
  ) {
    return status;
  }
  return "error";
}

function asServiceStatus(value: unknown): RuntimeTopologyServiceStatus {
  const status = String(value);
  if (
    status === "planned" ||
    status === "starting" ||
    status === "running" ||
    status === "stopped" ||
    status === "offline" ||
    status === "error"
  ) {
    return status;
  }
  return "error";
}

function asWorktreeStatus(value: unknown): RuntimeTopologyWorktreeStatus {
  const status = String(value);
  if (
    status === "planned" ||
    status === "creating" ||
    status === "active" ||
    status === "removing" ||
    status === "graveyard" ||
    status === "missing" ||
    status === "error"
  ) {
    return status;
  }
  return "error";
}

function asRemoteClientStatus(value: unknown): RuntimeTopologyRemoteClient["status"] {
  const status = String(value);
  if (status === "online" || status === "stale" || status === "offline") return status;
  return "offline";
}

function asLifecycleOperationStatus(value: unknown): RuntimeTopologyLifecycleOperationStatus {
  const status = String(value);
  if (
    status === "pending" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    return status;
  }
  return "failed";
}

function asLifecycleOperationTargetKind(value: unknown, context: string): RuntimeTopologyLifecycleOperationTargetKind {
  const kind = String(value);
  if (kind === "session" || kind === "service" || kind === "worktree" || kind === "node" || kind === "rig") {
    return kind;
  }
  throw new Error(`invalid runtime topology: ${context} must be a supported target kind`);
}

function asExchangeRefKind(value: unknown, context: string): RuntimeTopologyExchangeRef["kind"] {
  const kind = String(value);
  if (
    kind === "message" ||
    kind === "handoff" ||
    kind === "task" ||
    kind === "review" ||
    kind === "plan" ||
    kind === "wait" ||
    kind === "continuity" ||
    kind === "attachment"
  ) {
    return kind;
  }
  throw new Error(`invalid runtime topology: ${context} must be a supported exchange ref kind`);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockOwnerPid(lockPath: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(join(lockPath, "owner"), "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function lockAgeMs(lockPath: string): number | undefined {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
}

function isLockStale(lockPath: string): boolean {
  const age = lockAgeMs(lockPath);
  if (age === undefined) return false; // lock vanished; let mkdir race decide
  const pid = readLockOwnerPid(lockPath);
  if (pid !== undefined && pidAlive(pid)) return age >= LOCK_STALE_MAX_MS;
  // Owner is dead, or not written yet: a tiny grace avoids racing a lock that
  // was just created but whose owner file is not on disk yet.
  return age >= LOCK_STALE_GRACE_MS;
}

/** Reclaim a stale lock via atomic rename so concurrent reclaimers can't delete a fresh lock. */
function reclaimIfStale(lockPath: string): boolean {
  if (!isLockStale(lockPath)) return false;
  const tomb = `${lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lockPath, tomb);
  } catch {
    return true; // another process already reclaimed it; just retry the mkdir
  }
  rmSync(tomb, { recursive: true, force: true });
  return true;
}

export class RuntimeTopologyStore {
  constructor(readonly path = getRuntimeTopologyPath()) {}

  read(): RuntimeTopology {
    if (!existsSync(this.path)) return emptyRuntimeTopology();
    const parsed = parse(readFileSync(this.path, "utf-8"));
    return coerceRuntimeTopology(parsed);
  }

  write(topology: RuntimeTopology): RuntimeTopology {
    const normalized = coerceRuntimeTopology(topology);
    atomicWrite(this.path, stringify(normalized, { lineWidth: 120, sortMapEntries: false }));
    return normalized;
  }

  private acquireUpdateLock(): () => void {
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + UPDATE_LOCK_TIMEOUT_MS;
    while (true) {
      try {
        mkdirSync(lockPath);
        try {
          writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
        } catch (ownerError) {
          rmSync(lockPath, { recursive: true, force: true });
          throw ownerError;
        }
        return () => rmSync(lockPath, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST" && reclaimIfStale(lockPath)) {
          continue; // reclaimed a stale lock (or another process did) — retry immediately
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring runtime topology update lock at ${lockPath}`, { cause: error });
        }
        sleepSync(UPDATE_LOCK_RETRY_MS);
      }
    }
  }

  update(mutator: (topology: RuntimeTopology) => RuntimeTopology): RuntimeTopology {
    const release = this.acquireUpdateLock();
    try {
      return this.write(mutator(this.read()));
    } finally {
      release();
    }
  }
}

export function createRuntimeTopologyStore(path?: string): RuntimeTopologyStore {
  return new RuntimeTopologyStore(path);
}
