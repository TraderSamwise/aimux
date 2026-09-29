import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The clock exists because relative labels are computed from Date.now(), and the
// agent list no longer re-renders on every poll. If it stops ticking, every
// "prompted just now" on screen freezes and nothing else notices.
describe("the recency clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The store holds module state, so each case needs its own copy.
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const load = () => import("./recency-clock");

  it("ticks fast enough to move a minute label", async () => {
    const { RECENCY_CLOCK_TICK_MS } = await load();
    expect(RECENCY_CLOCK_TICK_MS).toBeGreaterThan(0);
    expect(
      RECENCY_CLOCK_TICK_MS,
      "a tick slower than a minute leaves a label visibly stale",
    ).toBeLessThanOrEqual(60_000);
  });

  it("advances its snapshot and notifies subscribers", async () => {
    const { RECENCY_CLOCK_TICK_MS, recencyClockStore } = await load();
    let notifications = 0;
    const unsubscribe = recencyClockStore.subscribe(() => {
      notifications += 1;
    });
    const before = recencyClockStore.snapshot();

    vi.advanceTimersByTime(RECENCY_CLOCK_TICK_MS + 1);

    expect(notifications).toBe(1);
    expect(recencyClockStore.snapshot()).toBeGreaterThan(before);
    unsubscribe();
  });

  it("notifies every subscriber on one tick", async () => {
    const { RECENCY_CLOCK_TICK_MS, recencyClockStore } = await load();
    let first = 0;
    let second = 0;
    const stopFirst = recencyClockStore.subscribe(() => {
      first += 1;
    });
    const stopSecond = recencyClockStore.subscribe(() => {
      second += 1;
    });

    vi.advanceTimersByTime(RECENCY_CLOCK_TICK_MS + 1);

    expect([first, second]).toEqual([1, 1]);
    stopFirst();
    stopSecond();
  });

  it("stops ticking once the last subscriber leaves", async () => {
    const { RECENCY_CLOCK_TICK_MS, recencyClockStore } = await load();
    const unsubscribe = recencyClockStore.subscribe(() => {});
    vi.advanceTimersByTime(RECENCY_CLOCK_TICK_MS + 1);
    unsubscribe();

    const afterUnsubscribe = recencyClockStore.snapshot();
    vi.advanceTimersByTime(RECENCY_CLOCK_TICK_MS * 4);

    expect(
      recencyClockStore.snapshot(),
      "a timer left running keeps the app awake for nobody",
    ).toBe(afterUnsubscribe);
  });

  it("resumes for a later subscriber", async () => {
    const { RECENCY_CLOCK_TICK_MS, recencyClockStore } = await load();
    recencyClockStore.subscribe(() => {})();

    const unsubscribe = recencyClockStore.subscribe(() => {});
    const before = recencyClockStore.snapshot();
    vi.advanceTimersByTime(RECENCY_CLOCK_TICK_MS + 1);

    expect(recencyClockStore.snapshot()).toBeGreaterThan(before);
    unsubscribe();
  });
});
