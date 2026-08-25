import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { listTopologyServiceStates } from "./runtime-core/topology-services.js";
import { listTopologySessionStates } from "./runtime-core/topology-sessions.js";
import { getWorktreeBaseDir, listWorktrees, type WorktreeInfo } from "./worktree.js";

export const DEFAULT_WORKTREE_CACHE_DIR_NAMES = ["node_modules", ".next"];
export const ALLOWED_WORKTREE_CACHE_DIR_NAMES = ["node_modules", ".next", ".turbo"];

export interface WorktreeCacheCleanupTarget {
  worktreePath: string;
  relativePath: string;
  path: string;
  sizeBytes: number;
}

export interface WorktreeCacheCleanupSkippedWorktree {
  worktreePath: string;
  reason: "main-worktree" | "outside-aimux-worktrees" | "active-runtime";
  sessions?: string[];
  services?: string[];
}

export interface WorktreeCacheCleanupProtectedWorktree {
  worktreePath: string;
  sessions?: string[];
  services?: string[];
}

export interface WorktreeCacheCleanupPlan {
  projectRoot: string;
  dryRun: boolean;
  includeActive: boolean;
  cacheDirNames: string[];
  targets: WorktreeCacheCleanupTarget[];
  skipped: WorktreeCacheCleanupSkippedWorktree[];
  reclaimableBytes: number;
}

export type WorktreeCacheCleanupItemResult =
  | {
      path: string;
      status: "removed" | "dry-run";
      sizeBytes: number;
    }
  | {
      path: string;
      status: "failed";
      sizeBytes: number;
      error: string;
    };

export interface WorktreeCacheCleanupRunResult {
  dryRun: boolean;
  plan: WorktreeCacheCleanupPlan;
  results: WorktreeCacheCleanupItemResult[];
  reclaimedBytes: number;
}

export interface WorktreeCacheCleanupWorktreeSummary {
  worktreePath: string;
  sizeBytes: number;
  targetCount: number;
}

export interface WorktreeCacheCleanupOptions {
  projectRoot: string;
  worktreeBaseDir?: string;
  dryRun?: boolean;
  includeActive?: boolean;
  cacheDirNames?: string[];
  protectedWorktrees?: WorktreeCacheCleanupProtectedWorktree[];
  worktrees?: WorktreeInfo[];
  measureSize?: (path: string) => number;
  removeDir?: (path: string) => void;
}

export type WorktreeCacheCleanupAsyncOptions = Omit<WorktreeCacheCleanupOptions, "removeDir"> & {
  removeDir?: (path: string) => void | Promise<void>;
};

export function formatWorktreeCacheBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)}${units[unitIndex]}`;
}

export function summarizeWorktreeCacheTargets(
  targets: WorktreeCacheCleanupTarget[],
): WorktreeCacheCleanupWorktreeSummary[] {
  const byWorktree = new Map<string, WorktreeCacheCleanupWorktreeSummary>();
  for (const target of targets) {
    const entry = byWorktree.get(target.worktreePath) ?? {
      worktreePath: target.worktreePath,
      sizeBytes: 0,
      targetCount: 0,
    };
    entry.sizeBytes += target.sizeBytes;
    entry.targetCount += 1;
    byWorktree.set(target.worktreePath, entry);
  }
  return [...byWorktree.values()].sort((left, right) => right.sizeBytes - left.sizeBytes);
}

export function renderWorktreeCacheCleanupRunResult(
  result: WorktreeCacheCleanupRunResult,
  opts: { maxWorktrees?: number; maxTargets?: number } = {},
): string[] {
  const maxWorktrees = opts.maxWorktrees ?? 12;
  const maxTargets = opts.maxTargets ?? 20;
  const action = result.dryRun ? "would remove" : "removed";
  const bytes = result.dryRun ? result.plan.reclaimableBytes : result.reclaimedBytes;
  const failed = result.results.filter((item) => item.status === "failed").length;
  const lines = [
    `Worktree cache cleanup ${action} ${result.plan.targets.length} item(s), ${formatWorktreeCacheBytes(
      bytes,
    )}; ${failed} failed.`,
  ];
  const byWorktree = summarizeWorktreeCacheTargets(result.plan.targets);
  if (byWorktree.length > 0) {
    lines.push("By worktree:");
    for (const entry of byWorktree.slice(0, maxWorktrees)) {
      lines.push(
        `${formatWorktreeCacheBytes(entry.sizeBytes).padStart(7)}  ${entry.targetCount
          .toString()
          .padStart(4)} item(s)  ${entry.worktreePath}`,
      );
    }
    if (byWorktree.length > maxWorktrees) {
      lines.push(`... ${byWorktree.length - maxWorktrees} more worktree(s) hidden; use --json for full detail.`);
    }
  }
  if (result.plan.targets.length > 0 && result.plan.targets.length <= maxTargets) {
    lines.push("Targets:");
    for (const target of result.plan.targets) {
      lines.push(`${formatWorktreeCacheBytes(target.sizeBytes).padStart(7)}  ${target.path}`);
    }
  } else if (result.plan.targets.length > maxTargets) {
    lines.push(`Targets hidden (${result.plan.targets.length}); use --json for full detail.`);
  }
  if (result.plan.skipped.length > 0) {
    const activeSkipped = result.plan.skipped.filter((entry) => entry.reason === "active-runtime").length;
    const suffix = activeSkipped > 0 ? ` (${activeSkipped} active-runtime)` : "";
    lines.push(`Skipped ${result.plan.skipped.length} worktree(s)${suffix}.`);
  }
  return lines;
}

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isInside(parent: string, child: string): boolean {
  const parentPath = canonical(parent);
  const childPath = canonical(child);
  return (
    childPath === parentPath || childPath.startsWith(parentPath.endsWith(sep) ? parentPath : `${parentPath}${sep}`)
  );
}

function normalizeCacheDirNames(names: string[] | undefined): string[] {
  const result = new Set<string>();
  const allowed = new Set(ALLOWED_WORKTREE_CACHE_DIR_NAMES);
  for (const name of names?.length ? names : DEFAULT_WORKTREE_CACHE_DIR_NAMES) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") continue;
    if (!allowed.has(trimmed)) continue;
    result.add(trimmed);
  }
  return [...result];
}

function directorySize(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      try {
        const stat = lstatSync(child);
        if (stat.isDirectory()) {
          total += stat.size;
          stack.push(child);
        } else {
          total += stat.size;
        }
      } catch {
        // Files can disappear during cleanup planning; absent bytes are not reclaimable.
      }
    }
  }
  return total;
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function listCacheTargets(
  worktreePath: string,
  cacheDirNames: string[],
): Array<{ path: string; relativePath: string }> {
  const cacheNames = new Set(cacheDirNames);
  const targets: Array<{ path: string; relativePath: string }> = [];
  const stack = [worktreePath];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (!isRealDirectory(child)) continue;
      if (cacheNames.has(entry.name)) {
        targets.push({ path: child, relativePath: relative(worktreePath, child) || entry.name });
        continue;
      }
      if (entry.name === ".git") continue;
      stack.push(child);
    }
  }
  return targets;
}

function activeRuntimeByWorktree(
  protectedWorktrees: WorktreeCacheCleanupProtectedWorktree[] | undefined,
): Map<string, { sessions: Set<string>; services: Set<string> }> {
  const active = new Map<string, { sessions: Set<string>; services: Set<string> }>();
  const add = (path: string | undefined, kind: "sessions" | "services", id: string): void => {
    if (!path) return;
    const key = canonical(path);
    const entry = active.get(key) ?? { sessions: new Set<string>(), services: new Set<string>() };
    entry[kind].add(id);
    active.set(key, entry);
  };
  for (const session of listTopologySessionStates({ statuses: ["starting", "running", "idle"] })) {
    add(session.worktreePath, "sessions", session.id);
  }
  for (const service of listTopologyServiceStates({ statuses: ["starting", "running"] })) {
    add(service.worktreePath, "services", service.id);
  }
  for (const protectedWorktree of protectedWorktrees ?? []) {
    for (const sessionId of protectedWorktree.sessions ?? []) {
      add(protectedWorktree.worktreePath, "sessions", sessionId);
    }
    for (const serviceId of protectedWorktree.services ?? []) {
      add(protectedWorktree.worktreePath, "services", serviceId);
    }
  }
  return active;
}

export function buildWorktreeCacheCleanupPlan(options: WorktreeCacheCleanupOptions): WorktreeCacheCleanupPlan {
  const projectRoot = canonical(options.projectRoot);
  const dryRun = options.dryRun !== false;
  const includeActive = options.includeActive === true;
  const cacheDirNames = normalizeCacheDirNames(options.cacheDirNames);
  const worktrees = options.worktrees ?? listWorktrees(projectRoot);
  const measureSize = options.measureSize ?? directorySize;
  const active = activeRuntimeByWorktree(options.protectedWorktrees);
  const aimuxWorktreeRoot = options.worktreeBaseDir
    ? canonical(options.worktreeBaseDir)
    : getWorktreeBaseDir(projectRoot);
  const targets: WorktreeCacheCleanupTarget[] = [];
  const skipped: WorktreeCacheCleanupSkippedWorktree[] = [];

  for (const worktree of worktrees) {
    const worktreePath = canonical(worktree.path);
    if (worktreePath === projectRoot) {
      skipped.push({ worktreePath, reason: "main-worktree" });
      continue;
    }
    if (!isInside(aimuxWorktreeRoot, worktreePath)) {
      skipped.push({ worktreePath, reason: "outside-aimux-worktrees" });
      continue;
    }
    const activeEntry = active.get(worktreePath);
    if (activeEntry && !includeActive) {
      skipped.push({
        worktreePath,
        reason: "active-runtime",
        sessions: [...activeEntry.sessions],
        services: [...activeEntry.services],
      });
      continue;
    }
    for (const target of listCacheTargets(worktreePath, cacheDirNames)) {
      const targetPath = target.path;
      if (!existsSync(targetPath)) continue;
      targets.push({
        worktreePath,
        relativePath: target.relativePath,
        path: targetPath,
        sizeBytes: measureSize(targetPath),
      });
    }
  }

  return {
    projectRoot,
    dryRun,
    includeActive,
    cacheDirNames,
    targets,
    skipped,
    reclaimableBytes: targets.reduce((sum, target) => sum + target.sizeBytes, 0),
  };
}

export function runWorktreeCacheCleanup(options: WorktreeCacheCleanupOptions): WorktreeCacheCleanupRunResult {
  const plan = buildWorktreeCacheCleanupPlan(options);
  const dryRun = plan.dryRun;
  const removeDir = options.removeDir ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const results: WorktreeCacheCleanupItemResult[] = [];
  let reclaimedBytes = 0;

  for (const target of plan.targets) {
    if (dryRun) {
      results.push({ path: target.path, status: "dry-run", sizeBytes: target.sizeBytes });
      continue;
    }
    try {
      if (!isRemovableCacheTarget(target, plan.cacheDirNames)) {
        throw new Error("planned cache target failed final safety validation");
      }
      removeDir(target.path);
      reclaimedBytes += target.sizeBytes;
      results.push({ path: target.path, status: "removed", sizeBytes: target.sizeBytes });
    } catch (error) {
      results.push({
        path: target.path,
        status: "failed",
        sizeBytes: target.sizeBytes,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { dryRun, plan, results, reclaimedBytes };
}

export async function runWorktreeCacheCleanupAsync(
  options: WorktreeCacheCleanupAsyncOptions,
): Promise<WorktreeCacheCleanupRunResult> {
  const plan = buildWorktreeCacheCleanupPlan(options);
  const dryRun = plan.dryRun;
  const removeDir = options.removeDir ?? ((path: string) => rm(path, { recursive: true, force: true }));
  const results: WorktreeCacheCleanupItemResult[] = [];
  let reclaimedBytes = 0;

  for (const target of plan.targets) {
    if (dryRun) {
      results.push({ path: target.path, status: "dry-run", sizeBytes: target.sizeBytes });
      continue;
    }
    try {
      if (!isRemovableCacheTarget(target, plan.cacheDirNames)) {
        throw new Error("planned cache target failed final safety validation");
      }
      await removeDir(target.path);
      reclaimedBytes += target.sizeBytes;
      results.push({ path: target.path, status: "removed", sizeBytes: target.sizeBytes });
    } catch (error) {
      results.push({
        path: target.path,
        status: "failed",
        sizeBytes: target.sizeBytes,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { dryRun, plan, results, reclaimedBytes };
}

function isRemovableCacheTarget(target: WorktreeCacheCleanupTarget, cacheDirNames: string[]): boolean {
  if (!cacheDirNames.includes(basename(target.path))) return false;
  if (!isInside(target.worktreePath, target.path)) return false;
  return isRealDirectory(target.path);
}
