import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

import { atomicWrite } from "./atomic-write.js";
import { log } from "./debug.js";
import { withHostedLock } from "./hosted-lock.js";
import { getHostedAuditPath, getHostedAuditPromptsPath, getHostedDir } from "./paths.js";

/**
 * The hosted audit log: one JSONL record per request, append-only.
 *
 * This is the record of who said what to which session, and it is ours rather
 * than the tool's — a single signed-in Codex account cannot tell operators
 * apart, so this file is the only place that can.
 *
 * Prompt text is sensitive by construction (it will contain whatever a person
 * typed about their business), so keeping it is a deliberate, configurable
 * choice; the hash is always kept so records stay correlatable when it is off.
 * Bodies live in their OWN file: rotation is size-driven, so a shared file lets
 * anyone who can authenticate push every other operator's history out of it.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5;

export interface HostedAuditRecord {
  ts: string;
  principalId: string;
  label: string;
  method: string;
  path: string;
  sessionId: string | null;
  status: number;
  requestBytes: number;
  responseBytes: number;
  promptHash?: string;
  /** Joins this record to its body in the prompts file, when one was kept. */
  promptRef?: string;
  event?: string;
  detail?: string;
}

export interface HostedPromptRecord {
  ts: string;
  promptRef: string;
  principalId: string;
  promptHash: string;
  promptText: string;
  /** Set when the body was longer than the retained prefix. */
  truncated?: boolean;
}

export function hashPrompt(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function rotateIfNeeded(path: string): void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < MAX_BYTES) return;

  try {
    rmSync(`${path}.${MAX_FILES}`, { force: true });
    for (let index = MAX_FILES - 1; index >= 1; index -= 1) {
      const from = `${path}.${index}`;
      if (existsSync(from)) renameSync(from, `${path}.${index + 1}`);
    }
    renameSync(path, `${path}.1`);
  } catch (error) {
    log.warn("hosted audit rotation failed", "hosted", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Records that arrived while the file was locked, merged back by the prune. */
function pendingPathFor(path: string): string {
  return `${path}.pending`;
}

function appendJsonl(path: string, record: unknown): void {
  try {
    mkdirSync(getHostedDir(), { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(record)}\n`;
    const write = () => {
      rotateIfNeeded(path);
      appendFileSync(path, line, { mode: 0o600 });
    };
    // Non-blocking: the wait is a synchronous Atomics.wait, and this is reached
    // from the request path. When the lock is held, the record goes to a sidecar
    // the prune merges under the lock rather than into the file it is rewriting
    // — appending there is what loses records.
    if (withHostedLock(path, write, { wait: false }) === null) {
      // Deliberately NOT rotated. Rotation renames to `.N`, and nothing reads a
      // rotated sidecar back — those records would leave every tail and never
      // be pruned, which for prompt bodies means outliving `retentionDays`.
      // Growth is bounded instead by the lock itself: it is stolen after 30s
      // stale, so a prune can never be locked out for longer than that.
      appendFileSync(pendingPathFor(path), line, { mode: 0o600 });
    }
  } catch (error) {
    // An audit failure must never fail the request it describes; it is loud in
    // the daemon log instead.
    log.warn("hosted audit append failed", "hosted", {
      error: error instanceof Error ? error.message : String(error),
      path,
    });
  }
}

/**
 * Append one record. Callers must invoke this OFF the response path — it is
 * synchronous, and the daemon shares its event loop with every local project.
 */
export function appendHostedAudit(record: HostedAuditRecord): void {
  appendJsonl(getHostedAuditPath(), record);
}

/**
 * Append one prompt body, in the separate file bodies live in.
 *
 * Callers must already have decided the body is worth keeping — this does not
 * consult `auditPromptBodies`.
 */
export function appendHostedPrompt(record: HostedPromptRecord): void {
  appendJsonl(getHostedAuditPromptsPath(), record);
}

/** `limit` slices before parsing — the live file runs to megabytes. */
function readJsonl<T>(path: string, limit?: number): T[] {
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    return (limit === undefined ? lines : lines.slice(-limit)).flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function byTimestamp(a: { ts: string }, b: { ts: string }): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
}

/**
 * The most recent records, newest last.
 *
 * Unparseable lines are skipped rather than reported: the daemon appends to
 * this file while we read it, so a torn trailing line is expected rather than
 * evidence of corruption. The pending sidecar is included so a record written
 * during a prune is visible before the next one merges it.
 */
export function tailHostedAudit(count: number): HostedAuditRecord[] {
  const path = getHostedAuditPath();
  return [...readJsonl<HostedAuditRecord>(path, count), ...readJsonl<HostedAuditRecord>(pendingPathFor(path), count)]
    .sort(byTimestamp)
    .slice(-count);
}

/** Prompt bodies for the given refs, keyed by ref. */
export function tailHostedPrompts(refs: Iterable<string>): Map<string, HostedPromptRecord> {
  const wanted = new Set(refs);
  if (!wanted.size) return new Map();
  const path = getHostedAuditPromptsPath();
  const found = new Map<string, HostedPromptRecord>();
  for (const record of [
    ...readJsonl<HostedPromptRecord>(path),
    ...readJsonl<HostedPromptRecord>(pendingPathFor(path)),
  ]) {
    if (wanted.has(record.promptRef)) found.set(record.promptRef, record);
  }
  return found;
}

/**
 * Drop records older than the retention window, in both files.
 *
 * Rotated files go by mtime, but the live file is rewritten record by record —
 * a low-traffic deployment never reaches the rotation threshold, and dropping
 * only rotations would mean prompt text (which contains whatever a person
 * typed about their business) is kept forever while retention claims otherwise.
 */
export function pruneHostedAudit(retentionDays: number, now = Date.now()): void {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  for (const path of [getHostedAuditPath(), getHostedAuditPromptsPath()]) {
    withHostedLock(path, () => pruneUnlocked(path, cutoff), { wait: false });
  }
}

/**
 * Stage the pending sidecar for folding back into the live file.
 *
 * Renamed before reading so an append landing concurrently creates a fresh
 * sidecar rather than writing into the file being consumed. The staged file is
 * NOT deleted here — only after the merged content is safely written, so a
 * crash or a failed write leaves the records on disk instead of destroying
 * them. A staged file that already exists is exactly that case: fold it in and
 * leave `pending` for the next round rather than clobbering the survivor.
 */
function stagePending(path: string): { staged: string; lines: string[] } | null {
  const pending = pendingPathFor(path);
  const staged = `${pending}.merging`;
  try {
    if (!existsSync(staged)) {
      if (!existsSync(pending)) return null;
      renameSync(pending, staged);
    }
    return { staged, lines: readFileSync(staged, "utf-8").split("\n").filter(Boolean) };
  } catch {
    return null;
  }
}

function pruneUnlocked(path: string, cutoff: number): void {
  for (let index = MAX_FILES; index >= 1; index -= 1) {
    const rotated = `${path}.${index}`;
    try {
      if (existsSync(rotated) && statSync(rotated).mtimeMs < cutoff) rmSync(rotated, { force: true });
    } catch {
      // Best effort: a file we cannot stat is a file we leave alone.
    }
  }

  const staged = stagePending(path);
  try {
    if (!existsSync(path) && !staged) return;
    const live = existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter(Boolean) : [];
    const lines = [...live, ...(staged?.lines ?? [])];
    const kept = lines.filter((line) => {
      try {
        const ts = Date.parse((JSON.parse(line) as HostedAuditRecord).ts);
        return !Number.isFinite(ts) || ts >= cutoff;
      } catch {
        // An unparseable line is evidence of something; keep it.
        return true;
      }
    });
    if (kept.length !== live.length || staged) {
      atomicWrite(path, kept.length ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
    }
    // Only now: until the merged content is on disk the staged copy is the sole
    // holder of these records, so deleting it earlier is how they get lost.
    // A crash between the write and this line re-merges the same lines next
    // round, duplicating them — chosen deliberately over losing them.
    if (staged) rmSync(staged.staged, { force: true });
  } catch (error) {
    log.warn("hosted audit prune failed", "hosted", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
