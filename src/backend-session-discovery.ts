import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function claudeProjectsDir(): string {
  // Mirrors Claude Code's own config location, which honors CLAUDE_CONFIG_DIR.
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(override ? override : join(homedir(), ".claude"), "projects");
}

// Claude encodes a project directory by replacing "/" and "." in the cwd with
// "-", e.g. /Users/x/.aimux/wt -> -Users-x--aimux-wt.
function encodeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Best-effort recovery of a claude backend session id from its on-disk
 * transcript store, for a session whose durable backend id was lost (e.g. a
 * crash that killed the tmux pane before the id was captured). Returns the
 * uuid of the most recently active transcript in the session's worktree, or
 * null when the directory is absent or empty. Scoped to the exact cwd so it
 * cannot bind an agent from another worktree. When several transcripts share
 * one worktree the latest-activity tie-break picks the one live at the crash;
 * worst case it resumes a sibling session in that same worktree (read-only
 * history, recoverable), never an unrelated project.
 */
export function discoverClaudeBackendSessionId(cwd: string, projectsDir = claudeProjectsDir()): string | null {
  const dir = join(projectsDir, encodeClaudeProjectPath(cwd));
  if (!existsSync(dir)) return null;
  let best: { id: string; mtimeMs: number } | null = null;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const id = entry.slice(0, -".jsonl".length);
    if (!UUID_RE.test(id)) continue;
    try {
      const mtimeMs = statSync(join(dir, entry)).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) best = { id, mtimeMs };
    } catch {
      // Unreadable entry; skip.
    }
  }
  return best?.id ?? null;
}

/**
 * Recover a backend session id from the tool's own on-disk session store when
 * the durable topology record lost it. Only claude is supported today (codex
 * carries its id in launch args); returns null for anything else.
 */
export function discoverBackendSessionId(toolConfigKey: string | undefined, cwd: string | undefined): string | null {
  if (!cwd || !toolConfigKey) return null;
  if (toolConfigKey === "claude") return discoverClaudeBackendSessionId(cwd);
  return null;
}
