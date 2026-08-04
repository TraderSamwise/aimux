import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

import { atomicWrite } from "./atomic-write.js";
import { log } from "./debug.js";
import { getHostedAuditPath, getHostedDir } from "./paths.js";

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
  promptText?: string;
  event?: string;
  detail?: string;
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

/**
 * Append one record. Callers must invoke this OFF the response path — it is
 * synchronous, and the daemon shares its event loop with every local project.
 */
export function appendHostedAudit(record: HostedAuditRecord): void {
  const path = getHostedAuditPath();
  try {
    mkdirSync(getHostedDir(), { recursive: true, mode: 0o700 });
    rotateIfNeeded(path);
    appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (error) {
    // An audit failure must never fail the request it describes; it is loud in
    // the daemon log instead.
    log.warn("hosted audit append failed", "hosted", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Drop records older than the retention window.
 *
 * Rotated files go by mtime, but the live file is rewritten record by record —
 * a low-traffic deployment never reaches the rotation threshold, and dropping
 * only rotations would mean prompt text (which contains whatever a person
 * typed about their business) is kept forever while retention claims otherwise.
 */
export function pruneHostedAudit(retentionDays: number, now = Date.now()): void {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const path = getHostedAuditPath();

  for (let index = MAX_FILES; index >= 1; index -= 1) {
    const rotated = `${path}.${index}`;
    try {
      if (existsSync(rotated) && statSync(rotated).mtimeMs < cutoff) rmSync(rotated, { force: true });
    } catch {
      // Best effort: a file we cannot stat is a file we leave alone.
    }
  }

  try {
    if (!existsSync(path)) return;
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    const kept = lines.filter((line) => {
      try {
        const ts = Date.parse((JSON.parse(line) as HostedAuditRecord).ts);
        return !Number.isFinite(ts) || ts >= cutoff;
      } catch {
        // An unparseable line is evidence of something; keep it.
        return true;
      }
    });
    if (kept.length === lines.length) return;
    atomicWrite(path, kept.length ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
  } catch (error) {
    log.warn("hosted audit prune failed", "hosted", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
