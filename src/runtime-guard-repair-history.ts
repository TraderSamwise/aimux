import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { getGlobalAimuxDir } from "./paths.js";
import { atomicWriteFast } from "./atomic-write.js";

/**
 * How often the dashboard's runtime guard has repaired the control plane.
 *
 * On disk, and that is the whole point. The counter used to live on the
 * Multiplexer instance — but repairing the control plane reloads the dashboard,
 * which builds a new instance, so the count reset on every repair and the flap
 * limit could never be reached. A breaker whose state is destroyed by the thing
 * it is meant to break is not a breaker.
 *
 * Keyed by project: two projects repairing independently should not consume each
 * other's budget.
 */

function historyPath(): string {
  return pathResolve(getGlobalAimuxDir(), "state", "runtime-guard-repair-attempts.json");
}

type HistoryFile = Record<string, number[]>;

function readHistory(): HistoryFile {
  try {
    const parsed = JSON.parse(readFileSync(historyPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: HistoryFile = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      out[key] = value.filter((at): at is number => typeof at === "number" && Number.isFinite(at));
    }
    return out;
  } catch {
    // Unreadable history must not block a repair — the breaker exists to stop a
    // loop, not to become one more thing that can wedge recovery.
    return {};
  }
}

function writeHistory(history: HistoryFile): void {
  try {
    const path = historyPath();
    mkdirSync(dirname(path), { recursive: true });
    // Atomic: several dashboards can be repairing at once, and a torn read here
    // would silently hand a flapping project a fresh budget.
    atomicWriteFast(path, `${JSON.stringify(history)}\n`);
  } catch {}
}

function keyFor(projectRoot: string): string {
  return pathResolve(projectRoot);
}

/** Attempts inside the window, newest kept; also prunes the stored file. */
export function loadRuntimeGuardRepairAttempts(projectRoot: string, windowMs: number, now = Date.now()): number[] {
  const history = readHistory();
  const kept = (history[keyFor(projectRoot)] ?? []).filter((at) => now - at < windowMs);
  return kept;
}

export function recordRuntimeGuardRepairAttempt(projectRoot: string, windowMs: number, now = Date.now()): number[] {
  const history = readHistory();
  const key = keyFor(projectRoot);
  const kept = [...(history[key] ?? []).filter((at) => now - at < windowMs), now];
  history[key] = kept;
  // Drop other projects' expired entries too, so the file cannot grow forever.
  for (const [otherKey, attempts] of Object.entries(history)) {
    if (otherKey === key) continue;
    const alive = attempts.filter((at) => now - at < windowMs);
    if (alive.length === 0) delete history[otherKey];
    else history[otherKey] = alive;
  }
  writeHistory(history);
  return kept;
}

/** Called when a repair settles, so a healthy project starts from zero again. */
export function clearRuntimeGuardRepairAttempts(projectRoot: string): void {
  const history = readHistory();
  delete history[keyFor(projectRoot)];
  writeHistory(history);
}

/** Test seam: the file this module reads and writes. */
export function runtimeGuardRepairHistoryPath(): string {
  return join(getGlobalAimuxDir(), "state", "runtime-guard-repair-attempts.json");
}
