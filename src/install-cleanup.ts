import { lstatSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAimuxStableShimPath } from "./cli-launcher.js";
import { listProcessArgs as defaultListProcessArgs } from "./process-inspector.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";

export const DEFAULT_INSTALL_RETENTION_DAYS = 30;
export const DEFAULT_INSTALL_KEEP_RECENT = 10;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Why an install survived the sweep. Liveness reasons outrank age reasons. */
export type InstallKeepReason = "current-install" | "in-use" | "recent" | "within-retention" | "references-unverified";

export interface InstallCleanupCandidate {
  name: string;
  path: string;
  ageDays: number;
  sizeBytes: number;
}

export interface InstallCleanupKept {
  name: string;
  reason: InstallKeepReason;
}

export interface InstallCleanupPlan {
  root: string;
  currentInstall: string | null;
  retentionDays: number;
  keepRecent: number;
  /** False when a reference source could not be read; nothing is removed in that case. */
  referencesComplete: boolean;
  remove: InstallCleanupCandidate[];
  keep: InstallCleanupKept[];
  reclaimableBytes: number;
}

export interface InstallReferenceText {
  text: string[];
  complete: boolean;
}

export interface InstallCleanupItemResult {
  name: string;
  status: "removed" | "dry-run" | "failed";
  sizeBytes: number;
  error?: string;
}

export interface InstallCleanupRunResult {
  dryRun: boolean;
  plan: InstallCleanupPlan;
  results: InstallCleanupItemResult[];
  reclaimedBytes: number;
}

export interface PlanInstallCleanupOptions {
  root?: string;
  keepRecent?: number;
  retentionDays?: number;
  now?: () => number;
  stableShimPath?: string;
  /** Text sources scanned for install references. Anything named here is never removed. */
  listReferenceText?: () => InstallReferenceText;
  measureSize?: (path: string) => number;
}

export interface InstallCleanupOperations {
  removeDir?: (path: string) => void;
}

function installRootFrom(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeRoot(env.AIMUX_INSTALL_ROOT?.trim() || join(homedir(), ".aimux", "native"));
}

/** A trailing slash would build a `root//name` pattern that matches no real reference. */
function normalizeRoot(root: string): string {
  const trimmed = root.replace(/\/+$/, "");
  return trimmed || "/";
}

function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * The install a path sits in, or null. Names are a single segment under the root,
 * so a reference anywhere inside an install pins the whole install.
 */
function installNameFor(path: string, root: string): string | null {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  const name = rest.split("/")[0];
  return name ? name : null;
}

function currentInstallName(root: string, stableShimPath: string): string | null {
  const resolved = canonical(stableShimPath);
  if (!resolved) return null;
  // The shim resolves through symlinks, so the root has to be compared in both
  // forms — on macOS /var and /private/var name the same directory.
  const canonicalRoot = canonical(root);
  return installNameFor(resolved, root) ?? (canonicalRoot ? installNameFor(resolved, canonicalRoot) : null);
}

/**
 * Everything that can name an install: live process arguments, plus the command
 * text tmux persists on its server. A still-referenced install must never be aged out.
 */
function defaultReferenceText(): InstallReferenceText {
  const processArgs = defaultListProcessArgs()
    .map((entry) => entry.args)
    .join("\n");
  const tmux = new TmuxRuntimeManager();
  // No tmux at all is a complete answer; a tmux that failed mid-read is not.
  if (!tmux.isAvailable()) return { text: [processArgs].filter(Boolean), complete: true };
  const persisted = tmux.listPersistedCommandText();
  return { text: [processArgs, ...persisted.text].filter(Boolean), complete: persisted.complete };
}

function referencedInstalls(roots: string[], text: string[]): Set<string> {
  const patterns = [...new Set(roots)].map(
    (root) => new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/\\s'"]+)`, "g"),
  );
  const names = new Set<string>();
  for (const chunk of text) {
    for (const pattern of patterns) {
      for (const match of chunk.matchAll(pattern)) {
        const name = match[1];
        if (name) names.add(name);
      }
    }
  }
  return names;
}

/**
 * Newest of the install directory and its immediate children. The installer moves an
 * extracted tree into place, and both `mv` and `tar -x` can carry an archived mtime,
 * so the directory alone can look far older than the install actually is.
 */
function installMtime(path: string): number {
  let newest = 0;
  const consider = (candidate: string): void => {
    try {
      newest = Math.max(newest, statSync(candidate).mtimeMs);
    } catch {
      // An unreadable entry simply cannot raise the timestamp.
    }
  };
  consider(path);
  try {
    for (const entry of readdirSync(path)) consider(join(path, entry));
  } catch {
    // A root we cannot enumerate keeps whatever the directory itself reported.
  }
  return newest;
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
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      try {
        total += lstatSync(child).size;
      } catch {
        // A file vanishing mid-walk just means it does not count toward the total.
      }
    }
  }
  return total;
}

export function planInstallCleanup(options: PlanInstallCleanupOptions = {}): InstallCleanupPlan {
  const root = normalizeRoot(options.root ?? installRootFrom());
  const keepRecent = options.keepRecent ?? DEFAULT_INSTALL_KEEP_RECENT;
  const retentionDays = options.retentionDays ?? DEFAULT_INSTALL_RETENTION_DAYS;
  const now = (options.now ?? Date.now)();
  const stableShimPath = options.stableShimPath ?? getAimuxStableShimPath();
  const measureSize = options.measureSize ?? directorySize;

  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return {
      root,
      currentInstall: null,
      retentionDays,
      keepRecent,
      referencesComplete: true,
      remove: [],
      keep: [],
      reclaimableBytes: 0,
    };
  }

  const current = currentInstallName(root, stableShimPath);
  const canonicalRoot = canonical(root);
  const references = (options.listReferenceText ?? defaultReferenceText)();
  const referenced = referencedInstalls(canonicalRoot ? [root, canonicalRoot] : [root], references.text);

  const withMtime = names.map((name) => {
    const path = join(root, name);
    return { name, path, mtimeMs: installMtime(path) };
  });
  const newest = new Set(
    [...withMtime]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, keepRecent)
      .map((entry) => entry.name),
  );

  const remove: InstallCleanupCandidate[] = [];
  const keep: InstallCleanupKept[] = [];
  for (const entry of withMtime) {
    const ageDays = (now - entry.mtimeMs) / MS_PER_DAY;
    // Liveness first: mtime records install time, never last use, so it can never
    // by itself justify removing something still referenced.
    if (entry.name === current) keep.push({ name: entry.name, reason: "current-install" });
    // A partial reference scan cannot distinguish unreferenced from unread.
    else if (!references.complete) keep.push({ name: entry.name, reason: "references-unverified" });
    else if (referenced.has(entry.name)) keep.push({ name: entry.name, reason: "in-use" });
    else if (newest.has(entry.name)) keep.push({ name: entry.name, reason: "recent" });
    else if (ageDays < retentionDays) keep.push({ name: entry.name, reason: "within-retention" });
    else remove.push({ name: entry.name, path: entry.path, ageDays, sizeBytes: measureSize(entry.path) });
  }

  return {
    root,
    currentInstall: current,
    retentionDays,
    keepRecent,
    referencesComplete: references.complete,
    remove,
    keep,
    reclaimableBytes: remove.reduce((total, entry) => total + entry.sizeBytes, 0),
  };
}

export function runInstallCleanup(
  plan: InstallCleanupPlan,
  operations: InstallCleanupOperations = {},
  input?: { dryRun?: boolean },
): InstallCleanupRunResult {
  // Deleting is the opt-in: a caller that says nothing gets a dry run.
  const dryRun = input?.dryRun !== false;
  const removeDir = operations.removeDir ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const results: InstallCleanupItemResult[] = [];
  let reclaimedBytes = 0;

  for (const candidate of plan.remove) {
    if (dryRun) {
      results.push({ name: candidate.name, status: "dry-run", sizeBytes: candidate.sizeBytes });
      continue;
    }
    // Re-check containment so a crafted or mutated name cannot escape the root.
    if (installNameFor(candidate.path, plan.root) !== candidate.name) {
      results.push({
        name: candidate.name,
        status: "failed",
        sizeBytes: candidate.sizeBytes,
        error: "refusing to remove a path outside the install root",
      });
      continue;
    }
    try {
      removeDir(candidate.path);
      reclaimedBytes += candidate.sizeBytes;
      results.push({ name: candidate.name, status: "removed", sizeBytes: candidate.sizeBytes });
    } catch (error) {
      results.push({
        name: candidate.name,
        status: "failed",
        sizeBytes: candidate.sizeBytes,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { dryRun, plan, results, reclaimedBytes };
}
