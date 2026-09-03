import { describe, expect, it } from "vitest";
import { MobilePushThrottle } from "./mobile-push-throttle";

function clock(start = 0) {
  const ref = { t: start };
  return { now: () => ref.t, advance: (ms: number) => (ref.t += ms), ref };
}

describe("MobilePushThrottle", () => {
  it("collapses identical alerts re-emitted within the dedupe window", () => {
    const c = clock();
    const t = new MobilePushThrottle(60_000, 5, 60_000, c.now);
    const alert = { sessionId: "claude-1", kind: "needs_input", title: "needs input", body: "waiting" };

    expect(t.allow(alert)).toBe(true);
    expect(t.allow(alert)).toBe(false);
    c.advance(59_000);
    expect(t.allow(alert)).toBe(false);
    c.advance(2_000);
    expect(t.allow(alert)).toBe(true);
  });

  it("lets through alerts with differing content", () => {
    const c = clock();
    const t = new MobilePushThrottle(60_000, 5, 60_000, c.now);
    expect(t.allow({ sessionId: "claude-1", kind: "needs_input", title: "a" })).toBe(true);
    expect(t.allow({ sessionId: "claude-1", kind: "task_done", title: "b" })).toBe(true);
  });

  it("prefers an explicit dedupeKey over content", () => {
    const c = clock();
    const t = new MobilePushThrottle(60_000, 5, 60_000, c.now);
    expect(t.allow({ dedupeKey: "k1", sessionId: "claude-1", title: "first" })).toBe(true);
    expect(t.allow({ dedupeKey: "k1", sessionId: "claude-1", title: "different text" })).toBe(false);
  });

  it("caps the push rate per session", () => {
    const c = clock();
    const t = new MobilePushThrottle(0, 5, 60_000, c.now);
    let allowed = 0;
    for (let i = 0; i < 8; i++) {
      if (t.allow({ sessionId: "claude-1", kind: "notification", title: `m${i}` })) allowed++;
    }
    expect(allowed).toBe(5);
    c.advance(61_000);
    expect(t.allow({ sessionId: "claude-1", kind: "notification", title: "after-window" })).toBe(true);
  });

  it("rate-limits each session independently", () => {
    const c = clock();
    const t = new MobilePushThrottle(0, 1, 60_000, c.now);
    expect(t.allow({ sessionId: "a", title: "x" })).toBe(true);
    expect(t.allow({ sessionId: "a", title: "y" })).toBe(false);
    expect(t.allow({ sessionId: "b", title: "z" })).toBe(true);
  });
});
