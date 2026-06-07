import { existsSync, readdirSync } from "node:fs";
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
 * uuid only when the worktree's transcript directory holds exactly one
 * candidate — an unambiguous match. If the directory is absent, empty, or
 * holds several transcripts (e.g. the main repo where many agents ran over
 * time), it refuses and returns null rather than guess the wrong session.
 * This preserves the "exact id only" safety of the original resume path.
 */
export function discoverClaudeBackendSessionId(cwd: string, projectsDir = claudeProjectsDir()): string | null {
  const dir = join(projectsDir, encodeClaudeProjectPath(cwd));
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const id = entry.slice(0, -".jsonl".length);
    if (UUID_RE.test(id)) ids.push(id);
  }
  return ids.length === 1 ? ids[0] : null;
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
