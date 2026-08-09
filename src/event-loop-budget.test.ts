import { describe, expect, it } from "vitest";
import {
  assessLoopBudget,
  MAX_LOOP_DELAY_P99_MS,
  MAX_SYNC_SHARE_PCT,
  MIN_SYNC_CALLS,
  MIN_WINDOW_MS,
  type LoopBudgetInput,
} from "./event-loop-budget.js";

const healthy = (over: Partial<LoopBudgetInput> = {}): LoopBudgetInput => ({
  windowMs: 60_000,
  eventLoop: { p50: 5, p90: 20, p99: 40, max: 120, mean: 8, monitoring: true },
  tmuxExec: {
    sync: { count: 200, totalMs: 300, maxMs: 12 },
    async: { count: 500, totalMs: 4_000, maxMs: 60 },
    syncByVerb: { "list-windows": { count: 200, totalMs: 300, maxMs: 12 } },
  },
  ...over,
});

describe("assessLoopBudget", () => {
  it("passes a daemon that stays answerable", () => {
    const assessment = assessLoopBudget(healthy());
    expect(assessment.withinBudget).toBe(true);
    expect(assessment.reasons).toEqual([]);
    expect(assessment.syncSharePct).toBe(0.5);
  });

  it("fails the real 66.8s sample this gate was written against", () => {
    // Live capture from /diagnostics/loop, committed in b81552c7. A gate that
    // passes the behaviour it exists to prevent is decoration, so this fixture is
    // the proof it has teeth.
    const assessment = assessLoopBudget({
      windowMs: 66_800,
      eventLoop: { p50: 41.22, p90: 81.92, p99: 856.16, max: 3527.41, mean: 0, monitoring: true },
      tmuxExec: {
        sync: { count: 759, totalMs: 6582, maxMs: 21 },
        async: { count: 0, totalMs: 0, maxMs: 0 },
        syncByVerb: { "list-windows": { count: 315, totalMs: 2837, maxMs: 12 } },
      },
    });

    expect(assessment.withinBudget).toBe(false);
    expect(assessment.syncSharePct).toBeCloseTo(9.85, 1);
    expect(assessment.reasons).toContain("sync-share-over-budget");
    expect(assessment.reasons).toContain("loop-delay-over-budget");
  });

  it("reports a too-small sample as its own outcome, never as a pass", () => {
    // A 200ms window with one call is trivially under budget — the reading most
    // likely to be mistaken for evidence that something got fixed.
    const brief = assessLoopBudget(
      healthy({
        windowMs: 200,
        tmuxExec: {
          sync: { count: 1, totalMs: 1, maxMs: 1 },
          async: { count: 0, totalMs: 0, maxMs: 0 },
          syncByVerb: {},
        },
      }),
    );
    expect(brief.withinBudget).toBe(false);
    expect(brief.reasons).toEqual(["insufficient-sample"]);
  });

  it("treats an unstarted monitor as unknown rather than healthy", () => {
    const assessment = assessLoopBudget(
      healthy({
        eventLoop: { p50: 0, p90: 0, p99: 0, max: 0, mean: 0, monitoring: false },
      }),
    );
    expect(assessment.withinBudget).toBe(false);
    expect(assessment.reasons).toEqual(["not-monitoring"]);
  });

  it("puts the boundary on the stated side of each threshold", () => {
    const atSyncLimit = assessLoopBudget(
      healthy({
        windowMs: 100_000,
        tmuxExec: {
          sync: { count: 100, totalMs: MAX_SYNC_SHARE_PCT * 1_000, maxMs: 5 },
          async: { count: 0, totalMs: 0, maxMs: 0 },
          syncByVerb: {},
        },
      }),
    );
    expect(atSyncLimit.syncSharePct).toBe(MAX_SYNC_SHARE_PCT);
    expect(atSyncLimit.withinBudget).toBe(true);

    const atDelayLimit = assessLoopBudget(
      healthy({
        eventLoop: { p50: 5, p90: 20, p99: MAX_LOOP_DELAY_P99_MS, max: 300, mean: 8, monitoring: true },
      }),
    );
    expect(atDelayLimit.withinBudget).toBe(true);
  });

  it("compares the raw share, not the rounded one", () => {
    // 2.004% rounds to 2.0 and would read as exactly at the limit.
    const assessment = assessLoopBudget({
      windowMs: 100_000,
      eventLoop: { p50: 1, p90: 2, p99: 3, max: 4, mean: 1, monitoring: true },
      tmuxExec: {
        sync: { count: 100, totalMs: 2_004, maxMs: 5 },
        async: { count: 0, totalMs: 0, maxMs: 0 },
        syncByVerb: {},
      },
    });
    expect(assessment.syncSharePct).toBe(2);
    expect(assessment.reasons).toEqual(["sync-share-over-budget"]);
  });

  it("names every reason it failed, not just the first", () => {
    const assessment = assessLoopBudget({
      windowMs: MIN_WINDOW_MS - 1,
      eventLoop: { p50: 0, p90: 0, p99: 9_999, max: 9_999, mean: 0, monitoring: false },
      tmuxExec: {
        sync: { count: MIN_SYNC_CALLS - 1, totalMs: 9_000, maxMs: 900 },
        async: { count: 0, totalMs: 0, maxMs: 0 },
        syncByVerb: {},
      },
    });
    expect(assessment.reasons).toEqual([
      "insufficient-sample",
      "not-monitoring",
      "sync-share-over-budget",
      "loop-delay-over-budget",
    ]);
  });
});
