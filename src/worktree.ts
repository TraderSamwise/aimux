import { execSync } from "node:child_process";
import { basename } from "node:path";

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  isBare: boolean;
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
        // "branch refs/heads/feat/foo" → "feat/foo"
        branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        isBare = true;
      } else if (line.startsWith("HEAD ") || line === "detached") {
        // detached HEAD — use short hash as name
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
 * Get the repository name from the main worktree.
 */
export function getRepoName(cwd?: string): string {
  return basename(findMainRepo(cwd));
}
