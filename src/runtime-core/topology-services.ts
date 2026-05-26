import { basename } from "node:path";
import { getProjectId, getRepoRoot } from "../paths.js";
import {
  createRuntimeTopologyStore,
  emptyRuntimeTopology,
  type RuntimeTopology,
  type RuntimeTopologyBinding,
  type RuntimeTopologyNode,
  type RuntimeTopologyService,
  type RuntimeTopologyServiceStatus,
  type RuntimeTopologyStore,
} from "./topology-store.js";

export type RuntimeTopologyServiceState = {
  id: string;
  status?: RuntimeTopologyServiceStatus;
  command?: string;
  args?: string[];
  launchCommandLine?: string;
  worktreePath?: string;
  cwd?: string;
  label?: string;
  createdAt?: string;
  lastSeenAt?: string;
  tmuxTarget?: {
    sessionName: string;
    windowId: string;
    windowIndex: number;
    windowName: string;
  };
};

function serviceNodeId(serviceId: string): string {
  return `service:${serviceId}`;
}

function serviceBindingId(serviceId: string): string {
  return `tmux:service:${serviceId}`;
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

function upsertServiceNode(
  topology: RuntimeTopology,
  service: RuntimeTopologyServiceState,
  rigId: string,
  now: string,
): RuntimeTopologyNode {
  const nodeId = serviceNodeId(service.id);
  const existing = topology.nodes.find((node) => node.id === nodeId);
  const next: RuntimeTopologyNode = {
    id: nodeId,
    rigId,
    logicalId: service.id,
    role: "service",
    runtime: "service",
    toolConfigKey: "service",
    cwd: service.cwd ?? service.worktreePath,
    label: service.label,
    createdAt: existing?.createdAt ?? service.createdAt ?? now,
  };
  if (existing) {
    Object.assign(existing, next);
    return existing;
  }
  topology.nodes.push(next);
  return next;
}

function serviceToTopologyService(
  service: RuntimeTopologyServiceState,
  rigId: string,
  nodeId: string,
  status: RuntimeTopologyServiceStatus,
  now: string,
): RuntimeTopologyService {
  return {
    id: service.id,
    rigId,
    nodeId,
    status,
    command: service.command,
    args: service.args ?? [],
    launchCommandLine: service.launchCommandLine,
    worktreePath: service.worktreePath,
    cwd: service.cwd,
    label: service.label,
    createdAt: service.createdAt ?? now,
    updatedAt: now,
    lastSeenAt: status === "running" || status === "starting" ? (service.lastSeenAt ?? now) : undefined,
  };
}

function serviceToBinding(
  service: RuntimeTopologyServiceState,
  nodeId: string,
  status: RuntimeTopologyServiceStatus,
  now: string,
): RuntimeTopologyBinding | undefined {
  if (status !== "running" && status !== "starting" && status !== "stopped") return undefined;
  const target = service.tmuxTarget;
  if (!target) return undefined;
  return {
    id: serviceBindingId(service.id),
    nodeId,
    tmuxSession: target.sessionName,
    tmuxWindowId: target.windowId,
    tmuxWindowIndex: target.windowIndex,
    tmuxWindowName: target.windowName,
    updatedAt: now,
  };
}

export function topologyServiceToServiceState(
  service: RuntimeTopologyService,
  topology: RuntimeTopology,
): RuntimeTopologyServiceState {
  const node = service.nodeId ? topology.nodes.find((entry) => entry.id === service.nodeId) : undefined;
  const binding = service.nodeId ? topology.bindings.find((entry) => entry.nodeId === service.nodeId) : undefined;
  return {
    id: service.id,
    status: service.status,
    command: service.command,
    args: service.args ?? [],
    launchCommandLine: service.launchCommandLine,
    worktreePath: service.worktreePath,
    cwd: service.cwd ?? node?.cwd,
    label: service.label ?? node?.label,
    createdAt: service.createdAt,
    lastSeenAt: service.lastSeenAt,
    tmuxTarget:
      binding?.tmuxSession && binding.tmuxWindowId && typeof binding.tmuxWindowIndex === "number"
        ? {
            sessionName: binding.tmuxSession,
            windowId: binding.tmuxWindowId,
            windowIndex: binding.tmuxWindowIndex,
            windowName: binding.tmuxWindowName ?? service.label ?? service.id,
          }
        : undefined,
  };
}

export function listTopologyServiceStates(input?: {
  statuses?: RuntimeTopologyServiceStatus[];
  store?: RuntimeTopologyStore;
}): RuntimeTopologyServiceState[] {
  const topology = (input?.store ?? createRuntimeTopologyStore()).read();
  const statuses = input?.statuses ? new Set(input.statuses) : undefined;
  return topology.services
    .filter((service) => !statuses || statuses.has(service.status))
    .map((service) => topologyServiceToServiceState(service, topology));
}

export function upsertTopologyService(
  service: RuntimeTopologyServiceState,
  status: RuntimeTopologyServiceStatus,
  input?: { store?: RuntimeTopologyStore; now?: string; projectRoot?: string },
): RuntimeTopology {
  const store = input?.store ?? createRuntimeTopologyStore();
  const now = input?.now ?? new Date().toISOString();
  const projectRoot = input?.projectRoot ?? getRepoRoot();
  return store.update((current) => {
    const topology = current.version ? current : emptyRuntimeTopology(now);
    topology.generatedAt = now;
    const rigId = ensureRig(topology, projectRoot, now);
    const node = upsertServiceNode(topology, service, rigId, now);
    const nextService = serviceToTopologyService(service, rigId, node.id, status, now);
    topology.services = [...topology.services.filter((entry) => entry.id !== service.id), nextService];
    const binding = serviceToBinding(service, node.id, status, now);
    topology.bindings = binding
      ? [...topology.bindings.filter((entry) => entry.id !== binding.id), binding]
      : topology.bindings.filter((entry) => entry.nodeId !== node.id);
    return topology;
  });
}

export function removeTopologyService(
  serviceId: string,
  input?: { store?: RuntimeTopologyStore; now?: string },
): RuntimeTopologyServiceState | undefined {
  const store = input?.store ?? createRuntimeTopologyStore();
  let removed: RuntimeTopologyServiceState | undefined;
  store.update((topology) => {
    const existing = topology.services.find((service) => service.id === serviceId);
    if (!existing) return topology;
    removed = topologyServiceToServiceState(existing, topology);
    topology.generatedAt = input?.now ?? new Date().toISOString();
    topology.services = topology.services.filter((service) => service.id !== serviceId);
    if (existing.nodeId) {
      topology.bindings = topology.bindings.filter((binding) => binding.nodeId !== existing.nodeId);
      topology.nodes = topology.nodes.filter((node) => node.id !== existing.nodeId);
    }
    topology.lifecycleOperations = topology.lifecycleOperations.filter(
      (operation) => !(operation.targetKind === "service" && operation.targetId === serviceId),
    );
    return topology;
  });
  return removed;
}
