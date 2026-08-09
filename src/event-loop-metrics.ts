import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/**
 * How long a callback waits for its turn on this process's event loop.
 *
 * The single number that says whether the daemon is healthy. Every project
 * service runs in this one process, so loop delay is not a performance detail —
 * it is the latency floor under every HTTP handler in every project, including
 * the `/health` probe whose timeout decides whether clients think the daemon is
 * alive at all.
 *
 * The histogram is cheap (libuv samples it; nothing accumulates per request) and
 * does not by itself keep the process alive.
 */

let histogram: IntervalHistogram | null = null;

/** Idempotent: repeated calls keep one histogram rather than stacking samplers. */
export function startEventLoopMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
}

export function stopEventLoopMonitor(): void {
  if (!histogram) return;
  histogram.disable();
  histogram = null;
}

export interface EventLoopDelay {
  /** Milliseconds. */
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
  /** False when nothing has started the monitor, so zeros are not read as "healthy". */
  monitoring: boolean;
}

// monitorEventLoopDelay reports nanoseconds, and percentile() takes 0-100 rather
// than 0-1. Both are easy to get wrong in a way that still yields plausible
// numbers — off by a factor of a million, or reading the 0.99th percentile.
const NS_PER_MS = 1e6;

function toMs(ns: number): number {
  if (!Number.isFinite(ns)) return 0;
  return Math.round((ns / NS_PER_MS) * 100) / 100;
}

export function getEventLoopDelay(): EventLoopDelay {
  if (!histogram) {
    return { p50: 0, p90: 0, p99: 0, max: 0, mean: 0, monitoring: false };
  }
  return {
    p50: toMs(histogram.percentile(50)),
    p90: toMs(histogram.percentile(90)),
    p99: toMs(histogram.percentile(99)),
    max: toMs(histogram.max),
    mean: toMs(histogram.mean),
    monitoring: true,
  };
}
