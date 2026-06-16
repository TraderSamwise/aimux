import { closeSync, existsSync, openSync, readSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FIRST_LINE_BYTES = 1024 * 1024;

function claudeProjectsDir(): string {
  // Mirrors Claude Code's own config location, which honors CLAUDE_CONFIG_DIR.
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(override ? override : join(homedir(), ".claude"), "projects");
}

function codexSessionsDir(): string {
  const override = process.env.CODEX_HOME?.trim();
  return join(override ? override : join(homedir(), ".codex"), "sessions");
}

// Claude encodes a project directory by replacing "/" and "." in the cwd with
// "-", e.g. /Users/x/.aimux/wt -> -Users-x--aimux-wt.
function encodeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** The on-disk Claude transcript path for a session's cwd + backend id. Single
 *  source of truth for the encoding so derivation can't drift across modules. */
export function claudeTranscriptPath(cwd: string, backendSessionId: string): string {
  return join(claudeProjectsDir(), encodeClaudeProjectPath(cwd), `${backendSessionId}.jsonl`);
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

function readFirstLine(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(16 * 1024);
    let position = 0;
    while (position < MAX_FIRST_LINE_BYTES) {
      const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, MAX_FIRST_LINE_BYTES - position), position);
      if (bytesRead <= 0) break;
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      const newlineIndex = chunk.indexOf(0x0a);
      if (newlineIndex >= 0) {
        chunks.push(chunk.subarray(0, newlineIndex));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(chunk);
      position += bytesRead;
    }
    if (chunks.length === 0 || position >= MAX_FIRST_LINE_BYTES) return null;
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failures in best-effort discovery
      }
    }
  }
}

function collectCodexSessionIdsForCwd(dir: string, cwd: string, ids: Set<string>): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCodexSessionIdsForCwd(path, cwd, ids);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

    const line = readFirstLine(path);
    if (!line) continue;
    try {
      const record = JSON.parse(line) as {
        type?: string;
        payload?: { id?: unknown; cwd?: unknown };
      };
      const id = record.payload?.id;
      const sessionCwd = record.payload?.cwd;
      if (record.type === "session_meta" && typeof id === "string" && UUID_RE.test(id) && sessionCwd === cwd) {
        ids.add(id);
      }
    } catch {
      // Ignore malformed or non-Codex jsonl records.
    }
  }
}

/**
 * Best-effort recovery of a codex backend session id from Codex's local
 * session transcripts. Returns an id only when exactly one transcript advertises
 * the target cwd, preserving targeted restore's no-guessing invariant.
 */
export function discoverCodexBackendSessionId(cwd: string, sessionsDir = codexSessionsDir()): string | null {
  if (!existsSync(sessionsDir)) return null;
  const ids = new Set<string>();
  collectCodexSessionIdsForCwd(sessionsDir, cwd, ids);
  return ids.size === 1 ? [...ids][0] : null;
}

/**
 * Recover a backend session id from the tool's own on-disk session store when
 * the durable topology record lost it. Returns null unless the tool-specific
 * store has exactly one unambiguous candidate for the session cwd.
 */
export function discoverBackendSessionId(toolConfigKey: string | undefined, cwd: string | undefined): string | null {
  if (!cwd || !toolConfigKey) return null;
  if (toolConfigKey === "claude") return discoverClaudeBackendSessionId(cwd);
  if (toolConfigKey === "codex") return discoverCodexBackendSessionId(cwd);
  return null;
}
