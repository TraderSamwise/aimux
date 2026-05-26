import { createHash } from "node:crypto";
import { basename } from "node:path";
import { getProjectId, getRepoRoot } from "../paths.js";
import {
  createRuntimeTopologyStore,
  emptyRuntimeTopology,
  type RuntimeTopology,
  type RuntimeTopologyStore,
  type RuntimeTopologyWorktree,
  type RuntimeTopologyWorktreeGraveyardEntry,
  type RuntimeTopologyWorktreeStatus,
} from "./topology-store.js";

export type RuntimeTopologyWorktreeState = {
  id?: string;
  path: string;
  name?: string;
  status?: RuntimeTopologyWorktreeStatus;
  branch?: string;
  head?: string;
  basePath?: string;
  createdAt?: string;
  removedAt?: string;
  operationFailure?: string;
};

export type RuntimeTopologyWorktreeGraveyardState = {
  id: string;
  worktreeId?: string;
  path: string;
  name?: string;
  branch?: string;
  graveyardedAt: string;
  reason?: string;
  deletedAt?: string;
};

function worktreeIdForPath(path: string): string {
  return `worktree:${createHash("sha256").update(path).digest("base64url").slice(0, 24)}`;
}

function graveyardIdForPath(path: string): string {
  return `worktree-graveyard:${createHash("sha256").update(path).digest("base64url").slice(0, 24)}`;
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

function worktreeToTopologyWorktree(
  worktree: RuntimeTopologyWorktreeState,
  rigId: string,
  status: RuntimeTopologyWorktreeStatus,
  now: string,
): RuntimeTopologyWorktree {
  return {
    id: worktree.id ?? worktreeIdForPath(worktree.path),
    rigId,
    path: worktree.path,
    name: worktree.name ?? basename(worktree.path),
    status,
    branch: worktree.branch,
    head: worktree.head,
    basePath: worktree.basePath,
    createdAt: worktree.createdAt ?? now,
    updatedAt: now,
    removedAt: worktree.removedAt,
    operationFailure: worktree.operationFailure,
  };
}

export function topologyWorktreeToWorktreeState(worktree: RuntimeTopologyWorktree): RuntimeTopologyWorktreeState {
  return {
    id: worktree.id,
    path: worktree.path,
    name: worktree.name,
    status: worktree.status,
    branch: worktree.branch,
    head: worktree.head,
    basePath: worktree.basePath,
    createdAt: worktree.createdAt,
    removedAt: worktree.removedAt,
    operationFailure: worktree.operationFailure,
  };
}

export function topologyWorktreeGraveyardToState(
  entry: RuntimeTopologyWorktreeGraveyardEntry,
): RuntimeTopologyWorktreeGraveyardState {
  return {
    id: entry.id,
    worktreeId: entry.worktreeId,
    path: entry.path,
    name: entry.name,
    branch: entry.branch,
    graveyardedAt: entry.graveyardedAt,
    reason: entry.reason,
    deletedAt: entry.deletedAt,
  };
}

export function listTopologyWorktreeStates(input?: {
  statuses?: RuntimeTopologyWorktreeStatus[];
  store?: RuntimeTopologyStore;
}): RuntimeTopologyWorktreeState[] {
  const topology = (input?.store ?? createRuntimeTopologyStore()).read();
  const statuses = input?.statuses ? new Set(input.statuses) : undefined;
  return topology.worktrees
    .filter((worktree) => !statuses || statuses.has(worktree.status))
    .map(topologyWorktreeToWorktreeState);
}

export function listTopologyWorktreeGraveyard(input?: {
  includeDeleted?: boolean;
  store?: RuntimeTopologyStore;
}): RuntimeTopologyWorktreeGraveyardState[] {
  const topology = (input?.store ?? createRuntimeTopologyStore()).read();
  return topology.worktreeGraveyard
    .filter((entry) => input?.includeDeleted || !entry.deletedAt)
    .map(topologyWorktreeGraveyardToState);
}

export function listTopologyWorktreeGraveyardPaths(input?: { store?: RuntimeTopologyStore }): Set<string> {
  return new Set(listTopologyWorktreeGraveyard(input).map((entry) => entry.path));
}

export function upsertTopologyWorktree(
  worktree: RuntimeTopologyWorktreeState,
  status: RuntimeTopologyWorktreeStatus,
  input?: { store?: RuntimeTopologyStore; now?: string; projectRoot?: string },
): RuntimeTopology {
  const store = input?.store ?? createRuntimeTopologyStore();
  const now = input?.now ?? new Date().toISOString();
  const projectRoot = input?.projectRoot ?? getRepoRoot();
  return store.update((current) => {
    const topology = current.version ? current : emptyRuntimeTopology(now);
    topology.generatedAt = now;
    const rigId = ensureRig(topology, projectRoot, now);
    const next = worktreeToTopologyWorktree(worktree, rigId, status, now);
    topology.worktrees = [...topology.worktrees.filter((entry) => entry.id !== next.id), next];
    return topology;
  });
}

export function moveTopologyWorktreeToGraveyard(
  path: string,
  input?: { store?: RuntimeTopologyStore; now?: string; reason?: string; projectRoot?: string },
): RuntimeTopologyWorktreeGraveyardState | undefined {
  const store = input?.store ?? createRuntimeTopologyStore();
  const now = input?.now ?? new Date().toISOString();
  const projectRoot = input?.projectRoot ?? getRepoRoot();
  let moved: RuntimeTopologyWorktreeGraveyardState | undefined;
  store.update((current) => {
    const topology = current.version ? current : emptyRuntimeTopology(now);
    topology.generatedAt = now;
    const rigId = ensureRig(topology, projectRoot, now);
    const existing = topology.worktrees.find((worktree) => worktree.path === path);
    if (!existing) return topology;
    const graveyardEntry: RuntimeTopologyWorktreeGraveyardEntry = {
      id: graveyardIdForPath(path),
      rigId,
      worktreeId: existing.id,
      path,
      name: existing.name,
      branch: existing.branch,
      graveyardedAt: now,
      reason: input?.reason,
    };
    existing.status = "graveyard";
    existing.removedAt = now;
    existing.updatedAt = now;
    topology.worktreeGraveyard = [...topology.worktreeGraveyard.filter((entry) => entry.path !== path), graveyardEntry];
    moved = topologyWorktreeGraveyardToState(graveyardEntry);
    return topology;
  });
  return moved;
}

export function deleteTopologyWorktreeGraveyardEntry(
  path: string,
  input?: { store?: RuntimeTopologyStore; now?: string },
): RuntimeTopologyWorktreeGraveyardState | undefined {
  const store = input?.store ?? createRuntimeTopologyStore();
  const now = input?.now ?? new Date().toISOString();
  let deleted: RuntimeTopologyWorktreeGraveyardState | undefined;
  store.update((topology) => {
    const existing = topology.worktreeGraveyard.find((entry) => entry.path === path && !entry.deletedAt);
    if (!existing) return topology;
    existing.deletedAt = now;
    topology.generatedAt = now;
    deleted = topologyWorktreeGraveyardToState(existing);
    return topology;
  });
  return deleted;
}

export function resurrectTopologyWorktreeFromGraveyard(
  path: string,
  input?: { store?: RuntimeTopologyStore; now?: string; projectRoot?: string },
): RuntimeTopologyWorktreeState | undefined {
  const store = input?.store ?? createRuntimeTopologyStore();
  const now = input?.now ?? new Date().toISOString();
  const projectRoot = input?.projectRoot ?? getRepoRoot();
  let resurrected: RuntimeTopologyWorktreeState | undefined;
  store.update((current) => {
    const topology = current.version ? current : emptyRuntimeTopology(now);
    topology.generatedAt = now;
    const rigId = ensureRig(topology, projectRoot, now);
    const graveyardEntry = topology.worktreeGraveyard.find((entry) => entry.path === path && !entry.deletedAt);
    if (!graveyardEntry) return topology;
    const existing = topology.worktrees.find(
      (worktree) => worktree.id === graveyardEntry.worktreeId || worktree.path === path,
    );
    if (existing) {
      existing.rigId = rigId;
      existing.path = path;
      existing.name = existing.name ?? graveyardEntry.name;
      existing.branch = existing.branch ?? graveyardEntry.branch;
      existing.status = "active";
      existing.updatedAt = now;
      delete existing.removedAt;
      resurrected = topologyWorktreeToWorktreeState(existing);
    } else {
      const next = worktreeToTopologyWorktree(
        {
          path,
          name: graveyardEntry.name,
          branch: graveyardEntry.branch,
          createdAt: graveyardEntry.graveyardedAt,
        },
        rigId,
        "active",
        now,
      );
      topology.worktrees.push(next);
      resurrected = topologyWorktreeToWorktreeState(next);
    }
    topology.worktreeGraveyard = topology.worktreeGraveyard.filter((entry) => entry.path !== path);
    return topology;
  });
  return resurrected;
}

export function removeTopologyWorktree(
  path: string,
  input?: { store?: RuntimeTopologyStore; now?: string },
): RuntimeTopologyWorktreeState | undefined {
  const store = input?.store ?? createRuntimeTopologyStore();
  const now = input?.now ?? new Date().toISOString();
  let removed: RuntimeTopologyWorktreeState | undefined;
  store.update((topology) => {
    const existing = topology.worktrees.find((worktree) => worktree.path === path);
    if (!existing) return topology;
    removed = topologyWorktreeToWorktreeState(existing);
    topology.generatedAt = now;
    topology.worktrees = topology.worktrees.filter((worktree) => worktree.path !== path);
    topology.lifecycleOperations = topology.lifecycleOperations.filter(
      (operation) => !(operation.targetKind === "worktree" && operation.targetId === existing.id),
    );
    return topology;
  });
  return removed;
}
