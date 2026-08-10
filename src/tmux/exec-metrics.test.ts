import { runInThisContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import { getTmuxExecMetrics, recordTmuxExec, resetTmuxExecMetrics, tmuxExecVerb } from "./exec-metrics.js";
import { memoizedTmuxQuery, withTmuxQueryMemo } from "./query-memo.js";

beforeEach(() => {
  resetTmuxExecMetrics();
});

describe("tmuxExecVerb", () => {
  it("takes the subcommand, which is what the cost should be attributed to", () => {
    expect(tmuxExecVerb(["capture-pane", "-p", "-t", "@1"])).toBe("capture-pane");
  });

  it("buckets an unexpected shape rather than dropping the sample", () => {
    expect(tmuxExecVerb([])).toBe("(unknown)");
    expect(tmuxExecVerb(["   "])).toBe("(unknown)");
  });
});

describe("tmux exec metrics", () => {
  it("splits sync from async, because only sync occupies the loop", () => {
    recordTmuxExec(["capture-pane"], 10, "sync");
    recordTmuxExec(["capture-pane"], 90, "async");

    const metrics = getTmuxExecMetrics();
    expect(metrics.sync).toEqual({ count: 1, totalMs: 10, maxMs: 10 });
    expect(metrics.async).toEqual({ count: 1, totalMs: 90, maxMs: 90 });
    // An async call's elapsed time is not loop time, so it must not inflate the
    // per-verb blocking breakdown that decides what gets converted.
    expect(metrics.syncByVerb["capture-pane"]).toEqual({ count: 1, totalMs: 10, maxMs: 10 });
  });

  it("accumulates count, total and max per verb", () => {
    recordTmuxExec(["capture-pane"], 5, "sync");
    recordTmuxExec(["capture-pane"], 25, "sync");
    recordTmuxExec(["list-windows"], 3, "sync");

    const metrics = getTmuxExecMetrics();
    expect(metrics.syncByVerb["capture-pane"]).toEqual({ count: 2, totalMs: 30, maxMs: 25 });
    expect(metrics.syncByVerb["list-windows"]).toEqual({ count: 1, totalMs: 3, maxMs: 3 });
    expect(metrics.sync.count).toBe(3);
    expect(metrics.sync.totalMs).toBe(33);
  });

  it("orders verbs by total time, since the heaviest is the one to fix", () => {
    recordTmuxExec(["list-windows"], 1, "sync");
    recordTmuxExec(["capture-pane"], 40, "sync");
    recordTmuxExec(["display-message"], 12, "sync");

    expect(Object.keys(getTmuxExecMetrics().syncByVerb)).toEqual(["capture-pane", "display-message", "list-windows"]);
  });

  it("hands out copies, so a reader cannot corrupt the counters", () => {
    recordTmuxExec(["capture-pane"], 10, "sync");
    const first = getTmuxExecMetrics();
    first.sync.totalMs = 9999;
    first.syncByVerb["capture-pane"]!.count = 9999;

    const second = getTmuxExecMetrics();
    expect(second.sync.totalMs).toBe(10);
    expect(second.syncByVerb["capture-pane"]!.count).toBe(1);
  });

  it("resets to empty", () => {
    recordTmuxExec(["capture-pane"], 10, "sync");
    resetTmuxExecMetrics();

    const metrics = getTmuxExecMetrics();
    expect(metrics.sync).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
    expect(metrics.syncByVerb).toEqual({});
    expect(metrics.syncByCaller).toEqual({});
  });
});

describe("sync caller attribution", () => {
  function callerKeys(): string[] {
    return Object.keys(getTmuxExecMetrics().syncByCaller);
  }

  it("names the calling function, not the exec layer it passed through", () => {
    function pretendDashboardBuild(): void {
      recordTmuxExec(["list-windows"], 5, "sync");
    }
    pretendDashboardBuild();

    const keys = callerKeys();
    expect(keys).toHaveLength(1);
    // The innermost frame must be the caller's. `query-memo` and the manager sit
    // between the fork and every read-only caller, and keying on either would
    // file the entire volume under one meaningless entry.
    expect(keys[0]!.split(" < ")[0]).toBe("exec-metrics.test.pretendDashboardBuild");
    for (const layer of ["query-memo.", "runtime-manager.", "exec-metrics.record"]) {
      expect(keys[0]).not.toContain(layer);
    }
  });

  it("keeps several frames, so a shared helper is not the whole answer", () => {
    function sharedReader(): void {
      recordTmuxExec(["display-message"], 5, "sync");
    }
    function driverOne(): void {
      sharedReader();
    }
    function driverTwo(): void {
      sharedReader();
    }
    driverOne();
    driverTwo();

    // Same innermost frame, different drivers — one entry each, not one merged.
    expect(callerKeys()).toHaveLength(2);
    expect(callerKeys().some((key) => key.includes("driverOne"))).toBe(true);
    expect(callerKeys().some((key) => key.includes("driverTwo"))).toBe(true);
  });

  it("accumulates per caller and orders heaviest first", () => {
    function cheap(): void {
      recordTmuxExec(["list-windows"], 1, "sync");
    }
    function expensive(): void {
      recordTmuxExec(["capture-pane"], 30, "sync");
    }
    cheap();
    expensive();
    expensive();

    const byCaller = getTmuxExecMetrics().syncByCaller;
    const first = Object.keys(byCaller)[0]!;
    expect(first).toContain("expensive");
    expect(byCaller[first]).toEqual({ count: 2, totalMs: 60, maxMs: 30 });
  });

  it("does not attribute async calls, which do not occupy the loop", () => {
    recordTmuxExec(["capture-pane"], 90, "async");
    expect(callerKeys()).toEqual([]);
  });

  it("looks past the memo layer that sits under every read-only caller", () => {
    // The real stack for a read-only verb runs caller → query-memo → the exec.
    // Attributing to the memo would file the whole read volume under one entry,
    // which is the failure this attribution exists to avoid.
    function pretendListWindowsCaller(): void {
      withTmuxQueryMemo(() => {
        memoizedTmuxQuery("list-windows:@1", () => {
          recordTmuxExec(["list-windows"], 5, "sync");
          return "";
        });
      });
    }
    pretendListWindowsCaller();

    const key = callerKeys()[0]!;
    expect(key).not.toContain("query-memo");
    expect(key).toContain("pretendListWindowsCaller");
  });

  it("buckets overflow rather than growing without bound", () => {
    // Distinct keys come from distinct call sites, so synthesize many.
    // Each synthesized function needs its own filename to count as its own call
    // site. `new Function` reports no filename at all, so its frames are skipped
    // as unattributable and every caller would collapse into one key.
    const callers = Array.from({ length: 260 }, (_, index) =>
      runInThisContext("(record => function caller() { record(['list-windows'], 1, 'sync'); })", {
        filename: `synthetic-caller-${index}.js`,
      })(recordTmuxExec),
    );
    for (const caller of callers) caller();

    const byCaller = getTmuxExecMetrics().syncByCaller;
    // 200 named callers plus the one overflow bucket, never 260.
    expect(Object.keys(byCaller).length).toBeLessThanOrEqual(201);
    expect(byCaller["(other)"]).toBeDefined();
    expect(byCaller["(other)"]!.count).toBe(60);
    const total = Object.values(byCaller).reduce((sum, entry) => sum + entry.count, 0);
    // Nothing is dropped: an overflowing caller still shows up in the totals.
    expect(total).toBe(260);
  });

  it("restores stack formatting, so unrelated errors still read as strings", () => {
    const before = Error.stackTraceLimit;
    recordTmuxExec(["list-windows"], 1, "sync");

    expect(Error.stackTraceLimit).toBe(before);
    // A structured prepareStackTrace left installed would hand a CallSite array
    // to anything that reads `.stack` afterwards.
    expect(typeof new Error("after").stack).toBe("string");
  });
});
