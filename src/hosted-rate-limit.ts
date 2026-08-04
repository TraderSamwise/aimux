/**
 * Per-principal request limiting for the hosted listener.
 *
 * Two separate ceilings, because they fail differently: a token bucket bounds
 * how much work one principal can ask for over time, and a concurrency counter
 * bounds how much it can have in flight at once. Neither is a security control
 * on its own — they exist so one misbehaving client cannot starve the others.
 */

export interface HostedRateLimitOptions {
  requestsPerMinute: number;
  maxConcurrent: number;
  /** Injectable so tests do not depend on wall-clock timing. */
  now?: () => number;
}

export type HostedLimitOutcome = { ok: true; release: () => void } | { ok: false; reason: "rate" | "concurrency" };

interface Bucket {
  tokens: number;
  updatedAt: number;
  inFlight: number;
}

export class HostedRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(private readonly options: HostedRateLimitOptions) {
    this.now = options.now ?? Date.now;
  }

  private bucketFor(key: string): Bucket {
    const existing = this.buckets.get(key);
    if (existing) return existing;
    const fresh: Bucket = { tokens: this.options.requestsPerMinute, updatedAt: this.now(), inFlight: 0 };
    this.buckets.set(key, fresh);
    return fresh;
  }

  private refill(bucket: Bucket): void {
    const now = this.now();
    const elapsed = Math.max(0, now - bucket.updatedAt);
    const refilled = (elapsed / 60_000) * this.options.requestsPerMinute;
    bucket.tokens = Math.min(this.options.requestsPerMinute, bucket.tokens + refilled);
    bucket.updatedAt = now;
  }

  /**
   * Take one slot, returning a release for the concurrency half. Callers must
   * invoke `release` in a `finally` — a leaked slot permanently narrows the
   * principal's concurrency until the daemon restarts.
   */
  acquire(key: string): HostedLimitOutcome {
    const bucket = this.bucketFor(key);
    this.refill(bucket);

    if (bucket.inFlight >= this.options.maxConcurrent) return { ok: false, reason: "concurrency" };
    if (bucket.tokens < 1) return { ok: false, reason: "rate" };

    bucket.tokens -= 1;
    bucket.inFlight += 1;

    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        bucket.inFlight = Math.max(0, bucket.inFlight - 1);
      },
    };
  }

  /** Drop idle buckets so a long-lived daemon does not accumulate principals. */
  prune(idleMs = 300_000): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.inFlight === 0 && now - bucket.updatedAt > idleMs) this.buckets.delete(key);
    }
  }
}
