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
}

function emptyVerb(): TmuxExecVerbMetrics {
  return { count: 0, totalMs: 0, maxMs: 0 };
}

let sync = emptyVerb();
let asyncTotals = emptyVerb();
let syncByVerb = new Map<string, TmuxExecVerbMetrics>();

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
}

/** Snapshot; the returned objects are copies, so a reader cannot mutate the counters. */
export function getTmuxExecMetrics(): TmuxExecMetrics {
  const byVerb: Record<string, TmuxExecVerbMetrics> = {};
  // Heaviest first: the reason to read this is to find what to fix.
  const ordered = [...syncByVerb.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
  for (const [verb, metrics] of ordered) byVerb[verb] = { ...metrics };
  return { sync: { ...sync }, async: { ...asyncTotals }, syncByVerb: byVerb };
}

export function resetTmuxExecMetrics(): void {
  sync = emptyVerb();
  asyncTotals = emptyVerb();
  syncByVerb = new Map();
}
