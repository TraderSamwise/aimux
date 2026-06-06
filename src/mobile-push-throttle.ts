export interface ThrottleInput {
  dedupeKey?: string;
  sessionId?: string;
  kind?: string;
  title?: string;
  body?: string;
}

const DEDUPE_TTL_MS = 60_000;
const SESSION_WINDOW_MS = 60_000;
const SESSION_LIMIT = 5;

/**
 * In-memory guard for outbound mobile pushes. Collapses identical alerts
 * re-emitted within a TTL window (chatty idle/needs_input polling) and caps the
 * push rate per session so one runaway agent cannot flood the device.
 */
export class MobilePushThrottle {
  private readonly lastByKey = new Map<string, number>();
  private readonly sessionHits = new Map<string, number[]>();

  constructor(
    private readonly dedupeTtlMs = DEDUPE_TTL_MS,
    private readonly sessionLimit = SESSION_LIMIT,
    private readonly sessionWindowMs = SESSION_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  allow(input: ThrottleInput): boolean {
    const ts = this.now();
    this.prune(ts);

    const key =
      input.dedupeKey?.trim() || [input.sessionId, input.kind, input.title, input.body].map((p) => p ?? "").join("|");
    const last = this.lastByKey.get(key);
    if (last !== undefined && ts - last < this.dedupeTtlMs) return false;

    const session = input.sessionId?.trim() || "_global";
    const hits = (this.sessionHits.get(session) ?? []).filter((t) => ts - t < this.sessionWindowMs);
    if (hits.length >= this.sessionLimit) {
      this.sessionHits.set(session, hits);
      return false;
    }

    hits.push(ts);
    this.sessionHits.set(session, hits);
    this.lastByKey.set(key, ts);
    return true;
  }

  private prune(ts: number): void {
    for (const [key, t] of this.lastByKey) {
      if (ts - t >= this.dedupeTtlMs) this.lastByKey.delete(key);
    }
    for (const [session, hits] of this.sessionHits) {
      const fresh = hits.filter((t) => ts - t < this.sessionWindowMs);
      if (fresh.length === 0) this.sessionHits.delete(session);
      else this.sessionHits.set(session, fresh);
    }
  }
}
