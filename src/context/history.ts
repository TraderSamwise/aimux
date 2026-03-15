import {
  existsSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { getAimuxDir } from "../config.js";

export interface HistoryTurn {
  ts: string;
  type: "prompt" | "response" | "git";
  content: string;
  files?: string[];
  diff?: string;
}

export function getHistoryDir(cwd?: string): string {
  return join(getAimuxDir(cwd), "history");
}

function historyPath(sessionId: string, cwd?: string): string {
  return join(getHistoryDir(cwd), `${sessionId}.jsonl`);
}

/**
 * Append a single turn to the session's JSONL history file.
 * Creates the history directory if it doesn't exist.
 */
export function appendTurn(sessionId: string, turn: HistoryTurn, cwd?: string): void {
  const dir = getHistoryDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(historyPath(sessionId, cwd), JSON.stringify(turn) + "\n");
}

/**
 * Read turns from a session's JSONL history file.
 *
 * Options:
 * - lastN: return only the last N turns
 * - since: filter to turns with ts >= since (ISO string comparison)
 * - maxBytes: max bytes to read from the file (default 100KB).
 *   When the file exceeds this, reads from the tail of the file.
 */
export function readHistory(
  sessionId: string,
  opts?: { lastN?: number; since?: string; maxBytes?: number },
  cwd?: string,
): HistoryTurn[] {
  const filePath = historyPath(sessionId, cwd);
  if (!existsSync(filePath)) return [];

  const maxBytes = opts?.maxBytes ?? 100 * 1024;

  let raw: string;
  try {
    const size = statSync(filePath).size;
    if (size <= maxBytes) {
      raw = readFileSync(filePath, "utf-8");
    } else {
      // Read from the tail of the file
      const buf = Buffer.alloc(maxBytes);
      const fd = openSync(filePath, "r");
      try {
        readSync(fd, buf, 0, maxBytes, size - maxBytes);
      } finally {
        closeSync(fd);
      }
      raw = buf.toString("utf-8");
      // Drop the first (likely partial) line
      const firstNewline = raw.indexOf("\n");
      if (firstNewline !== -1) {
        raw = raw.slice(firstNewline + 1);
      }
    }
  } catch {
    return [];
  }

  let turns: HistoryTurn[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      turns.push(JSON.parse(trimmed) as HistoryTurn);
    } catch {
      // Skip malformed lines
    }
  }

  if (opts?.since) {
    turns = turns.filter((t) => t.ts >= opts.since!);
  }

  if (opts?.lastN !== undefined && turns.length > opts.lastN) {
    turns = turns.slice(-opts.lastN);
  }

  return turns;
}

/**
 * List all session IDs that have history files.
 * Scans .aimux/history/ for .jsonl files and returns IDs (filename without extension).
 */
export function listSessionIds(cwd?: string): string[] {
  const dir = getHistoryDir(cwd);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

/**
 * Read history from multiple sessions, merge by timestamp.
 * lastN applies per-session (each session contributes at most lastN turns).
 */
export function readAllHistories(
  sessionIds: string[],
  opts?: { lastN?: number; since?: string; maxBytes?: number },
  cwd?: string,
): HistoryTurn[] {
  const all: HistoryTurn[] = [];
  for (const id of sessionIds) {
    all.push(...readHistory(id, opts, cwd));
  }
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return all;
}
