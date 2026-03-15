import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { initProject } from "./config.js";
import { debug } from "./debug.js";

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  status: "active" | "offline";
  createdAt: string;
  sessions: string[];
}

export interface WorktreeRegistry {
  repoName: string;
  mainRepoPath: string;
  worktrees: WorktreeInfo[];
}

/**
 * Get the repository name from git toplevel.
 */
export function getRepoName(cwd?: string): string {
  const toplevel = execSync("git rev-parse --show-toplevel", {
    cwd: cwd ?? process.cwd(),
    encoding: "utf-8",
  }).trim();
  return basename(toplevel);
}

/**
 * Find the main repository path (the primary worktree, not a linked one).
 * Uses `git worktree list --porcelain` — the first entry is always the main worktree.
 */
export function findMainRepo(cwd?: string): string {
  const output = execSync("git worktree list --porcelain", {
    cwd: cwd ?? process.cwd(),
    encoding: "utf-8",
  });
  // First line is "worktree /path/to/main"
  const firstLine = output.split("\n")[0];
  const match = firstLine.match(/^worktree\s+(.+)$/);
  if (!match) {
    // Fallback to rev-parse
    return execSync("git rev-parse --show-toplevel", {
      cwd: cwd ?? process.cwd(),
      encoding: "utf-8",
    }).trim();
  }
  return match[1];
}

/**
 * Get the registry file path (always in the main repo's .aimux/).
 */
function registryPath(cwd?: string): string {
  const mainRepo = findMainRepo(cwd);
  return join(mainRepo, ".aimux", "worktrees.json");
}

/**
 * Load the worktree registry from the main repo's .aimux/worktrees.json.
 */
export function loadRegistry(cwd?: string): WorktreeRegistry {
  const regPath = registryPath(cwd);
  if (!existsSync(regPath)) {
    return {
      repoName: getRepoName(cwd),
      mainRepoPath: findMainRepo(cwd),
      worktrees: [],
    };
  }
  try {
    const raw = readFileSync(regPath, "utf-8");
    return JSON.parse(raw) as WorktreeRegistry;
  } catch {
    return {
      repoName: getRepoName(cwd),
      mainRepoPath: findMainRepo(cwd),
      worktrees: [],
    };
  }
}

/**
 * Save the worktree registry to the main repo's .aimux/worktrees.json.
 */
export function saveRegistry(registry: WorktreeRegistry, cwd?: string): void {
  const mainRepo = findMainRepo(cwd);
  const dir = join(mainRepo, ".aimux");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, "worktrees.json"), JSON.stringify(registry, null, 2) + "\n");
}

/**
 * Create a new worktree as a sibling directory.
 * Naming convention: {repoName}-{name} in the parent directory.
 */
export function createWorktree(name: string, branch?: string, cwd?: string): WorktreeInfo {
  const effectiveCwd = cwd ?? process.cwd();
  const repoName = getRepoName(effectiveCwd);
  const mainRepo = findMainRepo(effectiveCwd);
  const parentDir = dirname(mainRepo);
  const worktreePath = join(parentDir, `${repoName}-${name}`);
  const branchName = branch ?? name;

  if (existsSync(worktreePath)) {
    throw new Error(`Directory already exists: ${worktreePath}`);
  }

  // Create the worktree with a new branch
  debug(`creating worktree: ${worktreePath} (branch: ${branchName})`, "worktree");
  try {
    execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
      cwd: mainRepo,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    // Branch might already exist — try without -b
    try {
      execSync(`git worktree add "${worktreePath}" "${branchName}"`, {
        cwd: mainRepo,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (err2: unknown) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      throw new Error(`Failed to create worktree: ${msg}`, { cause: err2 });
    }
  }

  // Initialize .aimux/ in the new worktree
  initProject(worktreePath);

  // Register in the registry
  const info: WorktreeInfo = {
    name,
    path: worktreePath,
    branch: branchName,
    status: "offline",
    createdAt: new Date().toISOString(),
    sessions: [],
  };

  const registry = loadRegistry(effectiveCwd);
  registry.worktrees.push(info);
  saveRegistry(registry, effectiveCwd);

  debug(`worktree created: ${name} at ${worktreePath}`, "worktree");
  return info;
}

/**
 * List all known worktrees. Merges registry with filesystem scan.
 */
export function listWorktrees(cwd?: string): WorktreeInfo[] {
  const effectiveCwd = cwd ?? process.cwd();
  const repoName = getRepoName(effectiveCwd);
  const mainRepo = findMainRepo(effectiveCwd);
  const parentDir = dirname(mainRepo);
  const registry = loadRegistry(effectiveCwd);
  const prefix = `${repoName}-`;

  // Scan for sibling directories matching the naming convention
  const discovered = new Map<string, string>(); // path -> name
  try {
    const entries = readdirSync(parentDir);
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const fullPath = join(parentDir, entry);
      try {
        const stat = statSync(fullPath);
        if (!stat.isDirectory()) continue;
        // Verify it's a git worktree
        execSync("git rev-parse --git-dir", {
          cwd: fullPath,
          encoding: "utf-8",
          stdio: "pipe",
        });
        const worktreeName = entry.slice(prefix.length);
        discovered.set(resolve(fullPath), worktreeName);
      } catch {
        // Not a git directory, skip
      }
    }
  } catch {
    // Parent dir not readable, skip scan
  }

  // Merge: keep registered ones that still exist, add discovered ones
  const result: WorktreeInfo[] = [];
  const seenPaths = new Set<string>();

  for (const wt of registry.worktrees) {
    const resolvedPath = resolve(wt.path);
    if (existsSync(wt.path)) {
      // Update sessions from .aimux/sessions.json
      const sessions = readWorktreeSessions(wt.path);
      result.push({ ...wt, sessions });
      seenPaths.add(resolvedPath);
    }
    // If path doesn't exist, skip (worktree was removed externally)
  }

  // Add discovered worktrees not in registry
  for (const [path, name] of discovered) {
    if (seenPaths.has(path)) continue;
    const branch = getWorktreeBranch(path);
    const sessions = readWorktreeSessions(path);
    result.push({
      name,
      path,
      branch,
      status: sessions.length > 0 ? "active" : "offline",
      createdAt: new Date().toISOString(),
      sessions,
    });
  }

  // Update registry with current state
  const updatedRegistry: WorktreeRegistry = {
    repoName,
    mainRepoPath: mainRepo,
    worktrees: result,
  };
  saveRegistry(updatedRegistry, effectiveCwd);

  return result;
}

/**
 * Remove a worktree by name.
 */
export function removeWorktree(name: string, cwd?: string): void {
  const effectiveCwd = cwd ?? process.cwd();
  const mainRepo = findMainRepo(effectiveCwd);
  const registry = loadRegistry(effectiveCwd);
  const wt = registry.worktrees.find((w) => w.name === name);

  if (!wt) {
    throw new Error(`Worktree "${name}" not found in registry`);
  }

  // Check for active sessions
  const sessions = readWorktreeSessions(wt.path);
  if (sessions.length > 0) {
    throw new Error(`Worktree "${name}" has ${sessions.length} active session(s). Kill them first.`);
  }

  // Remove via git
  debug(`removing worktree: ${name} at ${wt.path}`, "worktree");
  try {
    execSync(`git worktree remove "${wt.path}" --force`, {
      cwd: mainRepo,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    // If git worktree remove fails (e.g. already gone), try manual cleanup
    if (existsSync(wt.path)) {
      rmSync(wt.path, { recursive: true, force: true });
    }
    // Prune stale worktree entries
    try {
      execSync("git worktree prune", {
        cwd: mainRepo,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {}
  }

  // Deregister
  registry.worktrees = registry.worktrees.filter((w) => w.name !== name);
  saveRegistry(registry, effectiveCwd);
  debug(`worktree removed: ${name}`, "worktree");
}

/**
 * Clean up worktrees that are offline and have no active sessions.
 * Returns names of removed worktrees.
 */
export function cleanWorktrees(cwd?: string): string[] {
  const worktrees = listWorktrees(cwd);
  const removed: string[] = [];

  for (const wt of worktrees) {
    if (wt.status === "offline" && wt.sessions.length === 0) {
      try {
        removeWorktree(wt.name, cwd);
        removed.push(wt.name);
      } catch (err) {
        debug(`failed to clean worktree ${wt.name}: ${err instanceof Error ? err.message : String(err)}`, "worktree");
      }
    }
  }

  return removed;
}

/**
 * Update a worktree's status in the registry.
 */
export function updateWorktreeStatus(name: string, status: "active" | "offline", cwd?: string): void {
  const registry = loadRegistry(cwd);
  const wt = registry.worktrees.find((w) => w.name === name);
  if (!wt) {
    throw new Error(`Worktree "${name}" not found in registry`);
  }
  wt.status = status;
  saveRegistry(registry, cwd);
}

// --- Helpers ---

/**
 * Read session IDs from a worktree's .aimux/sessions.json.
 */
function readWorktreeSessions(worktreePath: string): string[] {
  const sessionsPath = join(worktreePath, ".aimux", "sessions.json");
  if (!existsSync(sessionsPath)) return [];
  try {
    const raw = readFileSync(sessionsPath, "utf-8");
    const sessions = JSON.parse(raw) as Array<{ id: string }>;
    return sessions.map((s) => s.id);
  } catch {
    return [];
  }
}

/**
 * Get the branch name of a worktree.
 */
function getWorktreeBranch(worktreePath: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return "unknown";
  }
}
