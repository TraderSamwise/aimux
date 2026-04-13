import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getProjectStateDir, getProjectStateDirFor } from "../paths.js";

export function getTmuxStatuslineDirFor(projectRoot: string): string {
  return join(getProjectStateDirFor(projectRoot), "tmux-statusline");
}

export function getTmuxStatuslineDir(): string {
  return join(getProjectStateDir(), "tmux-statusline");
}

export function ensureTmuxStatuslineDir(projectRoot?: string): string {
  const dir = projectRoot ? getTmuxStatuslineDirFor(projectRoot) : getTmuxStatuslineDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function invalidateTmuxStatuslineArtifacts(projectRoot: string): void {
  const dir = getTmuxStatuslineDirFor(projectRoot);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith("top-") && !entry.startsWith("bottom-")) continue;
    try {
      unlinkSync(join(dir, entry));
    } catch {}
  }
}
