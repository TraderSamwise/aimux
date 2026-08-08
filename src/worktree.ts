import { execFile, execFileSync, execSync, type ExecFileException } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { loadConfig } from "./config.js";

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  isBare: boolean;
  createdAt?: string;
}

export function isToolInternalWorktree(worktree: Pick<WorktreeInfo, "name" | "path" | "branch">): boolean {
  const normalizedPath = worktree.path.replace(/\\/g, "/");
  return (
    (worktree.name.startsWith("agent-") && worktree.branch.startsWith("worktree-agent-")) ||
    /\/\.claude\/worktrees\/agent-[^/]+$/.test(normalizedPath)
  );
}

// Strip inherited GIT_* env so git honors `cwd` even when invoked from a
// context (e.g. git hook) where the parent set GIT_DIR/GIT_WORK_TREE.
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  return env;
}

function execFileText(command: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: gitEnv(),
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
      },
      (error: ExecFileException | null, stdout: string) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function parseWorktreeList(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  const blocks = output.split("\n\n").filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    let path = "";
    let branch = "";
    let isBare = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        isBare = true;
      } else if (line.startsWith("HEAD ") || line === "detached") {
        if (!branch) branch = "(detached)";
      }
    }

    if (!path) continue;

    worktrees.push({
      name: basename(path),
      path,
      branch: branch || basename(path),
      isBare,
    });
  }

  return worktrees;
}

// Instrumentation for tests that assert how many git subprocesses one operation spawns.
let gitCallCount = 0;

export function getWorktreeGitCallCount(): number {
  return gitCallCount;
}

export function resetWorktreeGitCallCount(): void {
  gitCallCount = 0;
}

/**
 * Memoize `git worktree list --porcelain` for the duration of one synchronous scope.
 *
 * Building a desktop-state snapshot asks for the same worktree listing several times
 * over — once directly, once per `computeDashboardSessions` pass, once while sorting,
 * and once per offline session — at ~18ms a subprocess.
 *
 * Only safe because the wrapped scope must be fully synchronous: the event loop cannot
 * interleave, so the memo cannot outlive the call or be seen by anything else, and a
 * snapshot is a point-in-time view anyway. Do NOT wrap a scope that creates or removes
 * worktrees, or one containing an `await`.
 */
interface WorktreeMemo {
  // The raw subprocess result, shared by findMainRepo and listWorktrees because they
  // run the identical command. Failures are memoized as well as successes so each
  // function can keep its own reaction to them: listWorktrees swallows, findMainRepo
  // throws.
  output: Map<string, { ok: true; text: string } | { ok: false; error: unknown }>;
  main: Map<string, string>;
  list: Map<string, WorktreeInfo[]>;
}

let worktreeMemo: WorktreeMemo | null = null;

export function withWorktreeMemo<T>(fn: () => T): T {
  if (worktreeMemo) return fn(); // Already inside a memoized scope; inherit it.
  worktreeMemo = { output: new Map(), main: new Map(), list: new Map() };
  try {
    return fn();
  } finally {
    worktreeMemo = null;
  }
}

function readWorktreeList(effectiveCwd: string): string {
  const memoized = worktreeMemo?.output.get(effectiveCwd);
  if (memoized) {
    if (memoized.ok) return memoized.text;
    throw memoized.error;
  }
  try {
    const text = execSync("git worktree list --porcelain", {
      cwd: effectiveCwd,
      env: gitEnv(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    gitCallCount += 1;
    worktreeMemo?.output.set(effectiveCwd, { ok: true, text });
    return text;
  } catch (error) {
    gitCallCount += 1;
    worktreeMemo?.output.set(effectiveCwd, { ok: false, error });
    throw error;
  }
}

/**
 * Find the main repository path (the primary worktree, not a linked one).
 * Uses `git worktree list --porcelain` — the first entry is always the main worktree.
 */
export function findMainRepo(cwd?: string): string {
  const effectiveCwd = cwd ?? process.cwd();
  const memoized = worktreeMemo?.main.get(effectiveCwd);
  if (memoized !== undefined) return memoized;
  const output = readWorktreeList(effectiveCwd);
  const firstLine = output.split("\n")[0];
  const match = firstLine.match(/^worktree\s+(.+)$/);
  if (!match) {
    gitCallCount += 1;
    const fallback = execSync("git rev-parse --show-toplevel", {
      cwd: cwd ?? process.cwd(),
      env: gitEnv(),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    worktreeMemo?.main.set(effectiveCwd, fallback);
    return fallback;
  }
  worktreeMemo?.main.set(effectiveCwd, match[1]);
  return match[1];
}

/**
 * List all git worktrees by parsing `git worktree list --porcelain`.
 * Returns all worktrees including the main one.
 */
export function listWorktrees(cwd?: string): WorktreeInfo[] {
  const effectiveCwd = cwd ?? process.cwd();
  const memoized = worktreeMemo?.list.get(effectiveCwd);
  if (memoized !== undefined) return memoized;
  let output: string;
  try {
    output = readWorktreeList(effectiveCwd);
  } catch {
    // A cwd that is not a repo stays not-a-repo for the scope; readWorktreeList has
    // already memoized the failure so no caller re-pays the subprocess.
    const empty: WorktreeInfo[] = [];
    worktreeMemo?.list.set(effectiveCwd, empty);
    return empty;
  }
  const worktrees = parseWorktreeList(output)
    .filter((worktree) => worktree.isBare || existsSync(worktree.path))
    .map(withWorktreeCreatedAt);
  worktreeMemo?.list.set(effectiveCwd, worktrees);
  return worktrees;
}

export async function listWorktreesAsync(cwd?: string): Promise<WorktreeInfo[]> {
  const effectiveCwd = cwd ?? process.cwd();
  const output = await execFileText("git", ["worktree", "list", "--porcelain"], effectiveCwd);
  if (!output) return [];
  return parseWorktreeList(output)
    .filter((worktree) => worktree.isBare || existsSync(worktree.path))
    .map(withWorktreeCreatedAt);
}

function withWorktreeCreatedAt(worktree: WorktreeInfo): WorktreeInfo {
  if (worktree.isBare) return worktree;
  try {
    const stat = statSync(worktree.path);
    const createdMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
    return { ...worktree, createdAt: new Date(createdMs).toISOString() };
  } catch {
    return worktree;
  }
}

/**
 * Get the repository name from the main worktree.
 */
export function getRepoName(cwd?: string): string {
  return basename(findMainRepo(cwd));
}

export function getWorktreeBaseDir(cwd?: string): string {
  const mainRepo = findMainRepo(cwd);
  const baseDir = loadConfig().worktrees.baseDir;
  return isAbsolute(baseDir) ? baseDir : resolve(mainRepo, baseDir);
}

export function getWorktreeCreatePath(name: string, cwd?: string): string {
  return join(getWorktreeBaseDir(cwd), name);
}

export function branchExistsInRepo(cwd: string, branch: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd,
      env: gitEnv(),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function getWorktreeAddArgs(name: string, targetPath: string, cwd?: string): string[] {
  const mainRepo = findMainRepo(cwd);
  return branchExistsInRepo(mainRepo, name)
    ? ["worktree", "add", targetPath, name]
    : ["worktree", "add", targetPath, "-b", name];
}

export function createWorktree(name: string, cwd?: string): string {
  const mainRepo = findMainRepo(cwd);
  const targetPath = getWorktreeCreatePath(name, cwd);
  mkdirSync(dirname(targetPath), { recursive: true });
  execFileSync("git", getWorktreeAddArgs(name, targetPath, mainRepo), {
    cwd: mainRepo,
    env: gitEnv(),
    encoding: "utf-8",
    stdio: "pipe",
  });
  return targetPath;
}
