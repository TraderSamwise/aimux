import type { EventLoopDelay } from "./event-loop-metrics.js";
import type { TmuxExecMetrics } from "./tmux/exec-metrics.js";

/**
 * The invariant that says the daemon is still answerable.
 *
 * Every project service runs in this one process, so synchronous work is not a
 * performance detail — it is the latency floor under every handler in every
 * project, including the `/health` probe whose timeout decides whether clients
 * believe the daemon is alive. When that floor rose far enough, clients started
 * replacing a daemon that was merely busy.
 *
 * A predicate rather than a benchmark on purpose. Wall-clock assertions on shared
 * hardware are flaky, and a flaky gate gets deleted rather than fixed; this takes
 * a measured sample and judges it, so the same rule applies to a unit fixture and
 * to live output from `/diagnostics/loop`.
 */

/**
 * Measured 6.8-9.9% across two live samples. 2% keeps a real margin while still
 * failing loudly at anything like today's behaviour.
 */
export const MAX_SYNC_SHARE_PCT = 2;

/**
 * Measured p99 636-856ms. 250ms sits well above the measured p90 (62-82ms), so
 * ordinary load passes and sustained blocking does not.
 */
export const MAX_LOOP_DELAY_P99_MS = 250;

/**
 * Below these a sample proves nothing: a 200ms window containing one tmux call is
 * trivially "within budget", which is the reading most likely to be mistaken for
 * evidence. Report it as its own outcome rather than as a pass.
 */
export const MIN_WINDOW_MS = 10_000;
export const MIN_SYNC_CALLS = 20;

export type LoopBudgetReason =
  | "insufficient-sample"
  | "sync-share-over-budget"
  | "loop-delay-over-budget"
  | "not-monitoring";

export interface LoopBudgetInput {
  /** Wall time the sample covers — daemon uptime, or the reset-to-read interval. */
  windowMs: number;
  eventLoop: EventLoopDelay;
  tmuxExec: TmuxExecMetrics;
}

export interface LoopBudgetAssessment {
  withinBudget: boolean;
  /** Share of wall time this process spent unable to run anything else. */
  syncSharePct: number;
  loopDelayP99Ms: number;
  reasons: LoopBudgetReason[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function assessLoopBudget(input: LoopBudgetInput): LoopBudgetAssessment {
  const { windowMs, eventLoop, tmuxExec } = input;
  // Compared raw, reported rounded: rounding first lets 2.004% read as exactly at
  // the limit and pass.
  const rawSyncSharePct = windowMs > 0 ? (tmuxExec.sync.totalMs / windowMs) * 100 : 0;
  const reasons: LoopBudgetReason[] = [];

  if (windowMs < MIN_WINDOW_MS || tmuxExec.sync.count < MIN_SYNC_CALLS) {
    reasons.push("insufficient-sample");
  }
  if (!eventLoop.monitoring) reasons.push("not-monitoring");
  if (rawSyncSharePct > MAX_SYNC_SHARE_PCT) reasons.push("sync-share-over-budget");
  if (eventLoop.p99 > MAX_LOOP_DELAY_P99_MS) reasons.push("loop-delay-over-budget");

  return {
    withinBudget: reasons.length === 0,
    syncSharePct: round(rawSyncSharePct),
    loopDelayP99Ms: eventLoop.p99,
    reasons,
  };
}
