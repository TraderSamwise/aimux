import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GraveyardConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { writeJsonAtomic } from "./atomic-write.js";
import { loadMetadataState, saveMetadataState } from "./metadata-store.js";
import { getContextDir, getHistoryDir, getPlansDir, getRecordingsDir, getStatusDir } from "./paths.js";
import {
  listTopologySessionStates,
  removeTopologySession,
  type RuntimeTopologySessionState,
} from "./runtime-core/topology-sessions.js";
import {
  listTopologyWorktreeGraveyard,
  type RuntimeTopologyWorktreeGraveyardState,
} from "./runtime-core/topology-worktrees.js";

const DEFAULT_RETENTION_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface GraveyardCleanupConfig {
  cleanupEnabled: boolean;
  retentionDays: number;
}

export interface GraveyardCleanupAgentTarget {
  kind: "agent";
  sessionId: string;
  graveyardedAt: string;
  expiresAt: string;
  worktreePath?: string;
}

export interface GraveyardCleanupWorktreeTarget {
  kind: "worktree";
  path: string;
  name?: string;
  graveyardedAt: string;
  expiresAt: string;
}

export interface GraveyardCleanupPlan {
  enabled: boolean;
  now: string;
  cutoff: string;
  retentionDays: number;
  agents: GraveyardCleanupAgentTarget[];
  worktrees: GraveyardCleanupWorktreeTarget[];
}

export interface GraveyardCleanupDeletedAgent {
  sessionId: string;
  removedAssets: string[];
}

export type GraveyardCleanupItemResult =
  | {
      kind: "agent" | "worktree";
      id: string;
      status: "removed" | "dry-run";
      removedAssets?: string[];
    }
  | {
      kind: "agent" | "worktree";
      id: string;
      status: "failed";
      error: string;
    };

export interface GraveyardCleanupRunResult {
  dryRun: boolean;
  plan: GraveyardCleanupPlan;
  results: GraveyardCleanupItemResult[];
}

export interface GraveyardCleanupOperations {
  deleteAgent?: (sessionId: string) => Promise<GraveyardCleanupDeletedAgent> | GraveyardCleanupDeletedAgent;
  deleteWorktree?: (path: string) => Promise<{ path: string; status: string }> | { path: string; status: string };
}

function normalizeCleanupConfig(config: Partial<GraveyardConfig> | undefined): GraveyardCleanupConfig {
  const retentionDays = Number(config?.retentionDays);
  return {
    cleanupEnabled: config?.cleanupEnabled !== false,
    retentionDays: Number.isFinite(retentionDays) && retentionDays >= 0 ? retentionDays : DEFAULT_RETENTION_DAYS,
  };
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function expiresAtIso(graveyardedAtMs: number, retentionDays: number): string {
  return new Date(graveyardedAtMs + retentionDays * MS_PER_DAY).toISOString();
}

function isExpired(graveyardedAt: string | undefined, cutoffMs: number): graveyardedAt is string {
  const parsed = parseTime(graveyardedAt);
  return parsed !== undefined && parsed <= cutoffMs;
}

export function buildGraveyardCleanupPlan(input?: {
  now?: Date | string;
  config?: Partial<GraveyardConfig>;
  sessions?: RuntimeTopologySessionState[];
  worktrees?: RuntimeTopologyWorktreeGraveyardState[];
}): GraveyardCleanupPlan {
  const config = normalizeCleanupConfig(input?.config ?? loadConfig().graveyard);
  const now = input?.now instanceof Date ? input.now : new Date(input?.now ?? Date.now());
  const nowMs = now.getTime();
  const cutoffMs = nowMs - config.retentionDays * MS_PER_DAY;
  const sessions = input?.sessions ?? listTopologySessionStates({ statuses: ["graveyard"] });
  const worktrees = input?.worktrees ?? listTopologyWorktreeGraveyard();
  if (!config.cleanupEnabled) {
    return {
      enabled: false,
      now: now.toISOString(),
      cutoff: new Date(cutoffMs).toISOString(),
      retentionDays: config.retentionDays,
      agents: [],
      worktrees: [],
    };
  }

  const agents = sessions.flatMap((session): GraveyardCleanupAgentTarget[] => {
    const graveyardedAt = session.graveyardedAt ?? session.updatedAt;
    const graveyardedAtMs = parseTime(graveyardedAt);
    if (!isExpired(graveyardedAt, cutoffMs) || graveyardedAtMs === undefined) return [];
    return [
      {
        kind: "agent",
        sessionId: session.id,
        graveyardedAt,
        expiresAt: expiresAtIso(graveyardedAtMs, config.retentionDays),
        worktreePath: session.worktreePath,
      },
    ];
  });

  return {
    enabled: true,
    now: now.toISOString(),
    cutoff: new Date(cutoffMs).toISOString(),
    retentionDays: config.retentionDays,
    agents,
    worktrees: worktrees.flatMap((worktree): GraveyardCleanupWorktreeTarget[] => {
      const graveyardedAtMs = parseTime(worktree.graveyardedAt);
      if (!isExpired(worktree.graveyardedAt, cutoffMs) || graveyardedAtMs === undefined) return [];
      return [
        {
          kind: "worktree",
          path: worktree.path,
          name: worktree.name,
          graveyardedAt: worktree.graveyardedAt,
          expiresAt: expiresAtIso(graveyardedAtMs, config.retentionDays),
        },
      ];
    }),
  };
}

function removeIfExists(path: string, removedAssets: string[], opts?: { recursive?: boolean }): void {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: opts?.recursive === true, force: true });
  removedAssets.push(path);
}

function removeAgentMetadata(sessionId: string): void {
  const metadata = loadMetadataState();
  if (!metadata.sessions[sessionId]) return;
  delete metadata.sessions[sessionId];
  saveMetadataState(metadata);
}

export function deleteGraveyardAgent(sessionId: string): GraveyardCleanupDeletedAgent {
  const existing = listTopologySessionStates({ statuses: ["graveyard"] }).find((session) => session.id === sessionId);
  if (!existing) {
    throw new Error(`Graveyard session "${sessionId}" not found`);
  }

  const removedAssets: string[] = [];
  removeIfExists(join(getRecordingsDir(), `${sessionId}.log`), removedAssets);
  removeIfExists(join(getRecordingsDir(), `${sessionId}.txt`), removedAssets);
  removeIfExists(join(getHistoryDir(), `${sessionId}.jsonl`), removedAssets);
  removeIfExists(join(getContextDir(), sessionId), removedAssets, { recursive: true });
  removeIfExists(join(getPlansDir(), `${sessionId}.md`), removedAssets);
  removeIfExists(join(getStatusDir(), `${sessionId}.md`), removedAssets);
  removeAgentMetadata(sessionId);
  removeTopologySession(sessionId);
  return { sessionId, removedAssets };
}

export async function runGraveyardCleanup(
  plan: GraveyardCleanupPlan,
  operations: GraveyardCleanupOperations = {},
  input?: { dryRun?: boolean },
): Promise<GraveyardCleanupRunResult> {
  const dryRun = input?.dryRun === true;
  const results: GraveyardCleanupItemResult[] = [];
  if (!plan.enabled) return { dryRun, plan, results };

  for (const worktree of plan.worktrees) {
    if (dryRun) {
      results.push({ kind: "worktree", id: worktree.path, status: "dry-run" });
      continue;
    }
    try {
      const deleteWorktree = operations.deleteWorktree;
      if (!deleteWorktree) throw new Error("worktree cleanup operation is not configured");
      await deleteWorktree(worktree.path);
      results.push({ kind: "worktree", id: worktree.path, status: "removed" });
    } catch (error) {
      results.push({
        kind: "worktree",
        id: worktree.path,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const agent of plan.agents) {
    if (plan.worktrees.some((worktree) => worktree.path === agent.worktreePath)) {
      continue;
    }
    if (dryRun) {
      results.push({ kind: "agent", id: agent.sessionId, status: "dry-run" });
      continue;
    }
    try {
      const deleted = await (operations.deleteAgent ?? deleteGraveyardAgent)(agent.sessionId);
      results.push({
        kind: "agent",
        id: agent.sessionId,
        status: "removed",
        removedAssets: deleted.removedAssets,
      });
    } catch (error) {
      results.push({
        kind: "agent",
        id: agent.sessionId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { dryRun, plan, results };
}

export function writeGraveyardCleanupReport(path: string, result: GraveyardCleanupRunResult): void {
  writeJsonAtomic(path, result);
}
