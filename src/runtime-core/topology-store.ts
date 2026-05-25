import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { getRuntimeTopologyPath } from "../paths.js";

export const RUNTIME_TOPOLOGY_VERSION = 1;
const UPDATE_LOCK_TIMEOUT_MS = 5_000;
const UPDATE_LOCK_RETRY_MS = 25;

export type RuntimeTopologySessionStatus =
  | "planned"
  | "starting"
  | "running"
  | "idle"
  | "offline"
  | "graveyard"
  | "error";

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
  team?: unknown;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
}

export interface RuntimeTopologyQueueItem {
  id: string;
  sourceSessionId?: string;
  targetSessionId?: string;
  status: "queued" | "assigned" | "in_progress" | "blocked" | "done" | "failed";
  kind: "task" | "handoff" | "message";
  title?: string;
  body?: string;
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
  queue: RuntimeTopologyQueueItem[];
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
    queue: [],
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

  return {
    ...topology,
    nodes,
    edges: topology.edges.filter(
      (edge) => rigIds.has(edge.rigId) && nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId),
    ),
    bindings: topology.bindings.filter((binding) => nodeIds.has(binding.nodeId)),
    sessions,
    queue: topology.queue.filter((item) => {
      if (item.sourceSessionId && !sessionIds.has(item.sourceSessionId)) return false;
      if (item.targetSessionId && !sessionIds.has(item.targetSessionId)) return false;
      return true;
    }),
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
        team: row.team,
        createdAt: asString(row.createdAt, `sessions[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `sessions[${index}].updatedAt`),
        lastSeenAt: asOptionalString(row.lastSeenAt),
      };
    }),
    queue: asArray(record.queue).map((entry, index) => {
      const row = asRecord(entry, `queue[${index}]`);
      return {
        id: asString(row.id, `queue[${index}].id`),
        sourceSessionId: asOptionalString(row.sourceSessionId),
        targetSessionId: asOptionalString(row.targetSessionId),
        status: asQueueStatus(row.status),
        kind: asQueueKind(row.kind),
        title: asOptionalString(row.title),
        body: asOptionalString(row.body),
        createdAt: asString(row.createdAt, `queue[${index}].createdAt`),
        updatedAt: asString(row.updatedAt, `queue[${index}].updatedAt`),
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

function asQueueStatus(value: unknown): RuntimeTopologyQueueItem["status"] {
  const status = String(value);
  if (
    status === "queued" ||
    status === "assigned" ||
    status === "in_progress" ||
    status === "blocked" ||
    status === "done" ||
    status === "failed"
  ) {
    return status;
  }
  return "failed";
}

function asQueueKind(value: unknown): RuntimeTopologyQueueItem["kind"] {
  const kind = String(value);
  if (kind === "task" || kind === "handoff" || kind === "message") return kind;
  return "task";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class RuntimeTopologyStore {
  constructor(readonly path = getRuntimeTopologyPath()) {}

  read(): RuntimeTopology {
    if (!existsSync(this.path)) return emptyRuntimeTopology();
    const parsed = parse(readFileSync(this.path, "utf-8"));
    return coerceRuntimeTopology(parsed);
  }

  write(topology: RuntimeTopology): RuntimeTopology {
    mkdirSync(dirname(this.path), { recursive: true });
    const normalized = coerceRuntimeTopology(topology);
    const tmpPath = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(
      tmpPath,
      stringify(normalized, {
        lineWidth: 120,
        sortMapEntries: false,
      }),
    );
    renameSync(tmpPath, this.path);
    return normalized;
  }

  private acquireUpdateLock(): () => void {
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + UPDATE_LOCK_TIMEOUT_MS;
    while (true) {
      try {
        mkdirSync(lockPath);
        writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
        return () => rmSync(lockPath, { recursive: true, force: true });
      } catch (error) {
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
