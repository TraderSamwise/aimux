/**
 * How much wall time this process spends inside tmux, split by verb.
 *
 * The daemon hosts every project service in-process, and the default tmux exec is
 * `execFileSync` — so a tmux call is not merely slow for its caller, it is dead
 * time for every other project's HTTP handler. Counting it is what turns "the
 * daemon feels slow" into a number attributable to a specific command.
 *
 * Deliberately module-level rather than injected: the point is to catch tmux
 * calls wherever they are made, including from code that never sees a metrics
 * object. Cost is one `performance.now()` pair and a map lookup per call.
 *
 * Blind spots, which the diagnostics payload names rather than hides:
 * `expose.ts` shells out to tmux directly (it runs in the popup process, not
 * here), and the Exposé hot-snapshot worker runs in a worker thread with its own
 * module registry — its tmux time is invisible to these counters and, more to the
 * point, is not on this event loop at all.
 */

import { basename } from "node:path";
import { isMainThread } from "node:worker_threads";

export type TmuxExecMode = "sync" | "async";

export interface TmuxExecVerbMetrics {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface TmuxExecMetrics {
  /** Blocking calls only — the ones that occupy the event loop. */
  sync: TmuxExecVerbMetrics;
  async: TmuxExecVerbMetrics;
  /** Per tmux subcommand (`capture-pane`, `list-windows`, …), sync calls only. */
  syncByVerb: Record<string, TmuxExecVerbMetrics>;
  /**
   * Per calling code path, sync calls only. Which verb is expensive says what to
   * batch; which caller issues it says what to stop calling. Two rounds of this
   * work were spent guessing the second from the first and getting it wrong.
   */
  syncByCaller: Record<string, TmuxExecVerbMetrics>;
}

function emptyVerb(): TmuxExecVerbMetrics {
  return { count: 0, totalMs: 0, maxMs: 0 };
}

let sync = emptyVerb();
let asyncTotals = emptyVerb();
let syncByVerb = new Map<string, TmuxExecVerbMetrics>();
let syncByCaller = new Map<string, TmuxExecVerbMetrics>();

/**
 * The exec layer itself. Every sync call passes through these on its way out, and
 * `query-memo` in particular sits between the fork and every read-only caller —
 * keying on it would file the entire volume under one meaningless line.
 */
const EXEC_LAYER_MODULES = new Set(["exec-metrics", "runtime-manager", "query-memo"]);

/**
 * Enough frames to name a driver rather than a shared helper. Five rather than
 * three because inline `map`/arrow callbacks land as `<anon>` and spend slots
 * without naming anything — at three, every snapshot-driven fork attributed to
 * the same builder and the actual driver stayed invisible.
 */
const CALLER_FRAMES = 5;
const CALLER_STACK_DEPTH = 24;

/** A runaway caller cannot grow this without bound; the overflow stays visible. */
const MAX_CALLER_KEYS = 200;
const UNKNOWN_CALLER = "(unknown)";
const OVERFLOW_CALLER = "(other)";

/**
 * Keyed by module and function, never by line: release builds ship without
 * sourcemaps, so a `dist` line number names nothing a reader can find.
 */
function frameLabel(site: NodeJS.CallSite): string | null {
  const file = site.getFileName();
  if (!file) return null;
  const module = basename(file).replace(/\.[cm]?[jt]s$/, "");
  if (EXEC_LAYER_MODULES.has(module)) return null;
  const fn = site.getFunctionName() ?? site.getMethodName();
  return `${module}.${fn ?? "<anon>"}`;
}

/**
 * Measured 6.5µs per recorded call against a ~5.6ms fork — 0.1%. Structured
 * rather than formatted: reading `.stack` as a string costs several times more,
 * and the string would be parsed back apart here anyway.
 */
function captureSyncCaller(): string {
  const previousLimit = Error.stackTraceLimit;
  const previousPrepare = Error.prepareStackTrace;
  Error.stackTraceLimit = CALLER_STACK_DEPTH;
  Error.prepareStackTrace = (_error, sites) => sites;
  try {
    const holder: { stack?: unknown } = {};
    Error.captureStackTrace(holder, captureSyncCaller);
    const sites = holder.stack;
    if (!Array.isArray(sites)) return UNKNOWN_CALLER;
    const labels: string[] = [];
    for (const site of sites as NodeJS.CallSite[]) {
      const label = frameLabel(site);
      if (label) labels.push(label);
      if (labels.length === CALLER_FRAMES) break;
    }
    return labels.length > 0 ? labels.join(" < ") : UNKNOWN_CALLER;
  } catch {
    return UNKNOWN_CALLER;
  } finally {
    // Restored even on throw: leaving a structured prepareStackTrace installed
    // would hand CallSite arrays to unrelated code reading `.stack`.
    Error.stackTraceLimit = previousLimit;
    Error.prepareStackTrace = previousPrepare;
  }
}

function accumulate(target: TmuxExecVerbMetrics, ms: number): void {
  target.count += 1;
  target.totalMs += ms;
  if (ms > target.maxMs) target.maxMs = ms;
}

/**
 * `args[0]` is the tmux subcommand. Anything else is bucketed rather than
 * dropped, so an unexpected shape shows up as a row instead of vanishing.
 */
export function tmuxExecVerb(args: readonly string[]): string {
  const verb = args[0];
  return typeof verb === "string" && verb.trim() ? verb.trim() : "(unknown)";
}

export function recordTmuxExec(args: readonly string[], ms: number, mode: TmuxExecMode): void {
  if (mode === "async") {
    accumulate(asyncTotals, ms);
    return;
  }
  accumulate(sync, ms);
  const verb = tmuxExecVerb(args);
  let bucket = syncByVerb.get(verb);
  if (!bucket) {
    bucket = emptyVerb();
    syncByVerb.set(verb, bucket);
  }
  accumulate(bucket, ms);
  recordSyncCaller(ms);
}

/**
 * Only on the main thread. A worker builds its own manager against its own copy
 * of this module, and nothing reads those counters — the capture would be work
 * spent on a number no one can see.
 */
function recordSyncCaller(ms: number): void {
  if (!isMainThread) return;
  let key = captureSyncCaller();
  let bucket = syncByCaller.get(key);
  if (!bucket) {
    if (syncByCaller.size >= MAX_CALLER_KEYS) key = OVERFLOW_CALLER;
    bucket = syncByCaller.get(key);
    if (!bucket) {
      bucket = emptyVerb();
      syncByCaller.set(key, bucket);
    }
  }
  accumulate(bucket, ms);
}

/** Heaviest first: the reason to read either of these is to find what to fix. */
function heaviestFirst(entries: Map<string, TmuxExecVerbMetrics>): Record<string, TmuxExecVerbMetrics> {
  const out: Record<string, TmuxExecVerbMetrics> = {};
  for (const [key, metrics] of [...entries.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)) {
    out[key] = { ...metrics };
  }
  return out;
}

/** Snapshot; the returned objects are copies, so a reader cannot mutate the counters. */
export function getTmuxExecMetrics(): TmuxExecMetrics {
  return {
    sync: { ...sync },
    async: { ...asyncTotals },
    syncByVerb: heaviestFirst(syncByVerb),
    syncByCaller: heaviestFirst(syncByCaller),
  };
}

export function resetTmuxExecMetrics(): void {
  sync = emptyVerb();
  asyncTotals = emptyVerb();
  syncByVerb = new Map();
  syncByCaller = new Map();
}
