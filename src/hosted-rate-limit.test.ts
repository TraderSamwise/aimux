import { describe, expect, it } from "vitest";

import { HostedRateLimiter } from "./hosted-rate-limit.js";

function limiter(options: { requestsPerMinute?: number; maxConcurrent?: number } = {}) {
  let now = 0;
  const instance = new HostedRateLimiter({
    requestsPerMinute: options.requestsPerMinute ?? 3,
    maxConcurrent: options.maxConcurrent ?? 2,
    now: () => now,
  });
  return { instance, advance: (ms: number) => (now += ms) };
}

describe("HostedRateLimiter", () => {
  it("allows up to the per-minute budget then refuses", () => {
    const { instance } = limiter({ requestsPerMinute: 3, maxConcurrent: 10 });
    for (let i = 0; i < 3; i += 1) {
      const slot = instance.acquire("prn_a");
      expect(slot.ok, `request ${i}`).toBe(true);
      if (slot.ok) slot.release();
    }
    expect(instance.acquire("prn_a")).toEqual({ ok: false, reason: "rate" });
  });

  it("refills over time", () => {
    const { instance, advance } = limiter({ requestsPerMinute: 60, maxConcurrent: 10 });
    for (let i = 0; i < 60; i += 1) {
      const slot = instance.acquire("prn_a");
      if (slot.ok) slot.release();
    }
    expect(instance.acquire("prn_a").ok).toBe(false);

    advance(1_000); // one token per second at 60/min
    const slot = instance.acquire("prn_a");
    expect(slot.ok).toBe(true);
    if (slot.ok) slot.release();
  });

  it("caps concurrency independently of the rate budget", () => {
    const { instance } = limiter({ requestsPerMinute: 100, maxConcurrent: 2 });
    const first = instance.acquire("prn_a");
    const second = instance.acquire("prn_a");
    expect(first.ok && second.ok).toBe(true);

    expect(instance.acquire("prn_a")).toEqual({ ok: false, reason: "concurrency" });

    if (first.ok) first.release();
    expect(instance.acquire("prn_a").ok).toBe(true);
  });

  it("keeps principals independent", () => {
    const { instance } = limiter({ requestsPerMinute: 1, maxConcurrent: 1 });
    const a = instance.acquire("prn_a");
    expect(a.ok).toBe(true);
    expect(instance.acquire("prn_a").ok).toBe(false);
    expect(instance.acquire("prn_b").ok).toBe(true);
  });

  it("ignores a double release", () => {
    const { instance } = limiter({ requestsPerMinute: 100, maxConcurrent: 1 });
    const slot = instance.acquire("prn_a");
    if (!slot.ok) throw new Error("expected a slot");
    slot.release();
    slot.release();

    // A double release must not create a second concurrency slot.
    expect(instance.acquire("prn_a").ok).toBe(true);
    expect(instance.acquire("prn_a")).toEqual({ ok: false, reason: "concurrency" });
  });

  it("prunes idle principals but keeps in-flight ones", () => {
    const { instance, advance } = limiter({ requestsPerMinute: 1, maxConcurrent: 2 });
    const held = instance.acquire("prn_busy");
    const done = instance.acquire("prn_idle");
    if (done.ok) done.release();

    advance(400_000);
    instance.prune();

    // Pruned: budget is fresh again. Retained: still out of tokens.
    expect(instance.acquire("prn_idle").ok).toBe(true);
    expect(held.ok).toBe(true);
  });
});
