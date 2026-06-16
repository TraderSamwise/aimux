import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Deterministic turn-state of an agent, read from its on-disk transcript.
 * "complete" = the agent finished its turn and is idle at the prompt;
 * "in_progress" = mid-turn (generating / tool call in flight);
 * "unknown" = the transcript didn't carry a recognizable signal.
 */
export type TurnState = "complete" | "in_progress" | "unknown";

export interface TranscriptProbe {
  turn: TurnState;
  size: number;
  mtimeMs: number;
}

// Claude appends trailing bookkeeping records (last-prompt, mode, ai-title, …)
// after `end_turn`, which can run to >100KB. Read a generous tail so the last
// `assistant` record is always in view, then scan backward to it.
const TAIL_BYTES = 256 * 1024;

/** Read up to the last `maxBytes` of a file as UTF-8. Null on any error.
 *  Pass `knownSize` to skip a redundant stat when the caller already has it. */
export function readFileTail(path: string, maxBytes = TAIL_BYTES, knownSize?: number): string | null {
  let fd: number | undefined;
  try {
    const size = knownSize ?? statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failures
      }
    }
  }
}

// Parse JSONL lines, tolerating a partial leading line (we may have started the
// read mid-file) and any non-JSON noise.
function parseJsonl(tail: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of tail.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object") out.push(value as Record<string, unknown>);
    } catch {
      // partial or non-JSON line — skip
    }
  }
  return out;
}

/**
 * Claude transcript: the last `assistant` record's `message.stop_reason` is the
 * turn signal — `end_turn` means the turn is done; `tool_use` means mid-turn.
 * Trailing non-assistant bookkeeping records after `end_turn` are ignored by
 * scanning backward to the last assistant entry.
 */
export function claudeTurnState(tail: string): TurnState {
  const records = parseJsonl(tail);
  // A user record appearing *after* the last assistant means a new turn has begun
  // (the agent is generating a reply, even if it hasn't written tokens yet).
  let sawUserAfterAssistant = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.type === "user") {
      sawUserAfterAssistant = true;
      continue;
    }
    if (record.type !== "assistant") continue;
    const message = record.message as { stop_reason?: unknown } | undefined;
    const stop = message?.stop_reason;
    // tool_use / pause_turn mean the model will keep going within this turn.
    if (stop === "tool_use" || stop === "pause_turn") return "in_progress";
    if (typeof stop !== "string") return "unknown";
    // Any other (terminal) stop_reason — end_turn, stop_sequence, max_tokens,
    // refusal, … — means the turn is done, unless a newer prompt already started
    // the next one.
    return sawUserAfterAssistant ? "in_progress" : "complete";
  }
  return "unknown";
}

// Codex event_msg payload types that mark a turn boundary (mirrors cmux's
// stale-turn detection).
const CODEX_COMPLETE = new Set(["task_complete", "turn_complete", "turn_aborted", "turn_failed"]);
const CODEX_IN_PROGRESS = new Set(["task_started", "turn_start", "turn_started"]);

/** Codex transcript: scan back to the last turn-boundary `event_msg`. */
export function codexTurnState(tail: string): TurnState {
  const records = parseJsonl(tail);
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.type !== "event_msg") continue;
    const payload = record.payload as { type?: unknown } | undefined;
    const type = typeof payload?.type === "string" ? payload.type : undefined;
    if (!type) continue;
    if (CODEX_COMPLETE.has(type)) return "complete";
    if (CODEX_IN_PROGRESS.has(type)) return "in_progress";
  }
  return "unknown";
}

export function turnStateFromTail(toolConfigKey: string, tail: string): TurnState {
  return toolConfigKey === "codex" ? codexTurnState(tail) : claudeTurnState(tail);
}

/** Stat + tail-read + parse a transcript into a turn-state probe. Null if unreadable. */
export function probeTranscript(toolConfigKey: string, path: string): TranscriptProbe | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  const tail = readFileTail(path, TAIL_BYTES, stat.size);
  if (tail === null) return null;
  return { turn: turnStateFromTail(toolConfigKey, tail), size: stat.size, mtimeMs: stat.mtimeMs };
}

function codexSessionsDir(): string {
  const override = process.env.CODEX_HOME?.trim();
  return join(override ? override : join(homedir(), ".codex"), "sessions");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Codex transcript files are nested by date and named with the session uuid
// (e.g. .../2026/06/16/rollout-<ts>-<uuid>.jsonl), so the tree is shallow. Cap
// recursion depth as a guard against a pathological/symlinked directory.
const CODEX_MAX_DEPTH = 6;

function findCodexFile(dir: string, backendSessionId: string, depth = 0): string | null {
  if (depth > CODEX_MAX_DEPTH) return null;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findCodexFile(path, backendSessionId, depth + 1);
      if (found) return found;
    } else if (entry.isFile() && entry.name.endsWith(`${backendSessionId}.jsonl`)) {
      return path;
    }
  }
  return null;
}

/** Locate a Codex session's transcript file by its backend session id. */
export function findCodexTranscriptPath(backendSessionId: string, sessionsDir = codexSessionsDir()): string | null {
  // Only scan for a UUID-shaped id; a non-UUID endsWith match could collide with
  // unrelated filenames during the recursive walk.
  if (!UUID_RE.test(backendSessionId)) return null;
  if (!existsSync(sessionsDir)) return null;
  return findCodexFile(sessionsDir, backendSessionId);
}
