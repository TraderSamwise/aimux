import { afterEach, describe, expect, it } from "vitest";
import { getEventLoopDelay, startEventLoopMonitor, stopEventLoopMonitor } from "./event-loop-metrics.js";

afterEach(() => {
  stopEventLoopMonitor();
});

function busyFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* deliberately blocking the loop */
  }
}

describe("event loop delay", () => {
  it("reports not-monitoring rather than a healthy-looking zero", () => {
    // Zeros from a monitor nobody started read exactly like a idle loop, which is
    // the one reading that must never be mistaken for evidence.
    expect(getEventLoopDelay()).toEqual({
      p50: 0,
      p90: 0,
      p99: 0,
      max: 0,
      mean: 0,
      monitoring: false,
    });
  });

  it("is idempotent, so repeated starts do not stack samplers", () => {
    startEventLoopMonitor();
    startEventLoopMonitor();
    expect(getEventLoopDelay().monitoring).toBe(true);
  });

  it("reports milliseconds, not the nanoseconds the histogram stores", async () => {
    startEventLoopMonitor();
    // Block well past the 10ms resolution, then yield so the sampler records it.
    busyFor(120);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const delay = getEventLoopDelay();
    expect(delay.monitoring).toBe(true);
    // A nanosecond value would land in the 10^8 range here. The assertion is the
    // unit, not the timing: anything inside a plausible millisecond band proves
    // the 1e6 divisor and the 0-100 percentile scale are both right.
    expect(delay.max).toBeGreaterThan(1);
    expect(delay.max).toBeLessThan(60_000);
    expect(delay.p99).toBeLessThanOrEqual(delay.max);
    expect(delay.p50).toBeLessThanOrEqual(delay.p99);
    // Pins the 0-100 percentile scale, which the ordering above does not: read as
    // 0-1, percentile(0.99) returns near the minimum and this lands at ~0.
    expect(delay.p99).toBeGreaterThan(1);
  });

  it("stops cleanly and reports not-monitoring again", () => {
    startEventLoopMonitor();
    stopEventLoopMonitor();
    expect(getEventLoopDelay().monitoring).toBe(false);
  });
});
