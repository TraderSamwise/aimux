import { beforeEach, describe, expect, it } from "vitest";
import { getTmuxExecMetrics, recordTmuxExec, resetTmuxExecMetrics, tmuxExecVerb } from "./exec-metrics.js";

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
  });
});
