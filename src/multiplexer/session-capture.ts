import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";

import type { SessionCaptureConfig } from "../config.js";

const SESSION_CAPTURE_MAX_BYTES = 256_000;
const SESSION_CAPTURE_MTIME_SLOP_MS = 10_000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function expandSessionCaptureDir(template: string, date: Date, homeDir = homedir()): string {
  return template
    .replaceAll("{home}", homeDir)
    .replaceAll("{yyyy}", String(date.getFullYear()))
    .replaceAll("{mm}", pad2(date.getMonth() + 1))
    .replaceAll("{dd}", pad2(date.getDate()));
}

function captureDates(now: Date, lookbackDays: number): Date[] {
  const dates: Date[] = [];
  for (let i = 0; i <= Math.max(0, lookbackDays); i += 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    dates.push(date);
  }
  return dates;
}

function readSessionCaptureSample(path: string): string {
  const size = statSync(path).size;
  if (size <= SESSION_CAPTURE_MAX_BYTES * 2) return readFileSync(path, "utf8");

  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(SESSION_CAPTURE_MAX_BYTES);
    const tail = Buffer.alloc(SESSION_CAPTURE_MAX_BYTES);
    readSync(fd, head, 0, SESSION_CAPTURE_MAX_BYTES, 0);
    readSync(fd, tail, 0, SESSION_CAPTURE_MAX_BYTES, Math.max(0, size - SESSION_CAPTURE_MAX_BYTES));
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
  } finally {
    closeSync(fd);
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasExactAimuxSessionPreamble(text: string, sessionId: string): boolean {
  return new RegExp(`This is an aimux-managed session with session ID ${escapeRegex(sessionId)}(?![A-Za-z0-9_-])`).test(
    text,
  );
}

export function captureBackendSessionIdFromSessionFiles(
  capture: SessionCaptureConfig,
  sessionId: string,
  opts: { now?: Date; startedAtMs?: number; homeDir?: string; lookbackDays?: number } = {},
): string | undefined {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return undefined;

  const now = opts.now ?? new Date();
  const pattern = new RegExp(capture.pattern);
  const matches = new Set<string>();
  const seenDirs = new Set<string>();

  for (const date of captureDates(now, opts.lookbackDays ?? 0)) {
    const dir = expandSessionCaptureDir(capture.dir, date, opts.homeDir);
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    if (!existsSync(dir)) continue;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;

      const match = entry.name.match(pattern);
      const backendSessionId = match?.[1]?.trim();
      if (!backendSessionId) continue;

      const path = `${dir}/${entry.name}`;
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (opts.startedAtMs && stat.mtimeMs < opts.startedAtMs - SESSION_CAPTURE_MTIME_SLOP_MS) {
        continue;
      }

      try {
        if (hasExactAimuxSessionPreamble(readSessionCaptureSample(path), normalizedSessionId)) {
          matches.add(backendSessionId);
        }
      } catch {
        continue;
      }
    }
  }

  return matches.size === 1 ? [...matches][0] : undefined;
}

export function extractCodexBackendSessionIdFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "resume") {
      const next = args[i + 1]?.trim();
      if (next && !next.startsWith("-")) return next;
      continue;
    }
    if (arg === "--resume") {
      const next = args[i + 1]?.trim();
      if (next && !next.startsWith("-")) return next;
      continue;
    }
    if (arg.startsWith("--resume=")) {
      const value = arg.slice("--resume=".length).trim();
      if (value) return value;
    }
  }
  return undefined;
}
