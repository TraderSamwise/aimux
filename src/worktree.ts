import { execFile, execSync, type ExecFileException } from "node:child_process";
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

function execFileText(command: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
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

/**
 * Find the main repository path (the primary worktree, not a linked one).
 * Uses `git worktree list --porcelain` — the first entry is always the main worktree.
 */
export function findMainRepo(cwd?: string): string {
  const output = execSync("git worktree list --porcelain", {
    cwd: cwd ?? process.cwd(),
    encoding: "utf-8",
  });
  const firstLine = output.split("\n")[0];
  const match = firstLine.match(/^worktree\s+(.+)$/);
  if (!match) {
    return execSync("git rev-parse --show-toplevel", {
      cwd: cwd ?? process.cwd(),
      encoding: "utf-8",
    }).trim();
  }
  return match[1];
}

/**
 * List all git worktrees by parsing `git worktree list --porcelain`.
 * Returns all worktrees including the main one.
 */
export function listWorktrees(cwd?: string): WorktreeInfo[] {
  const effectiveCwd = cwd ?? process.cwd();
  let output: string;
  try {
    output = execSync("git worktree list --porcelain", {
      cwd: effectiveCwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return [];
  }
  return parseWorktreeList(output)
    .filter((worktree) => worktree.isBare || existsSync(worktree.path))
    .map(withWorktreeCreatedAt);
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

export function createWorktree(name: string, cwd?: string): string {
  const mainRepo = findMainRepo(cwd);
  const targetPath = getWorktreeCreatePath(name, cwd);
  mkdirSync(dirname(targetPath), { recursive: true });
  execSync(`git worktree add "${targetPath}" -b "${name}"`, {
    cwd: mainRepo,
    encoding: "utf-8",
    stdio: "pipe",
  });
  return targetPath;
}
