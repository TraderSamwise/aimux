import { describe, expect, it } from "vitest";
import {
  consumeDashboardTuiVisibilityWake,
  findTmuxPaneForProcess,
  parseTmuxVisibility,
  parseProcessParents,
  parseTmuxPaneRows,
  readDashboardTuiVisibilityForHost,
  readTmuxTuiVisibility,
} from "./tui-visibility.js";

describe("parseTmuxVisibility", () => {
  it("marks an attached active window as visible", () => {
    expect(parseTmuxVisibility("1\t1\n", "%1")).toEqual({
      paneId: "%1",
      attached: true,
      activeWindow: true,
      visible: true,
      reason: "visible",
    });
  });

  it("marks an attached inactive window as hidden", () => {
    expect(parseTmuxVisibility("1\t0\n", "%1")).toMatchObject({
      paneId: "%1",
      attached: true,
      activeWindow: false,
      visible: false,
      reason: "hidden",
    });
  });

  it("marks a detached dashboard as not visible", () => {
    expect(parseTmuxVisibility("0\t1\n", "%1")).toMatchObject({
      attached: false,
      activeWindow: true,
      visible: false,
      reason: "detached",
    });
  });

  it("fails open on malformed tmux output", () => {
    expect(parseTmuxVisibility("bad", "%1")).toMatchObject({
      paneId: "%1",
      attached: true,
      activeWindow: true,
      visible: true,
      reason: "query-failed",
    });
  });
});

describe("readTmuxTuiVisibility", () => {
  it("assumes visible outside tmux", () => {
    expect(readTmuxTuiVisibility({ env: {} })).toMatchObject({
      visible: true,
      reason: "not-tmux",
    });
  });

  it("queries the current pane from TMUX_PANE", () => {
    const visibility = readTmuxTuiVisibility({
      env: { TMUX_PANE: "%7" },
      query: (paneId) => {
        expect(paneId).toBe("%7");
        return "2\t1\n";
      },
      listPanes: () => {
        throw new Error("not needed");
      },
    });

    expect(visibility).toMatchObject({
      paneId: "%7",
      visible: true,
      reason: "visible",
    });
  });

  it("fails open when the tmux query throws", () => {
    expect(
      readTmuxTuiVisibility({
        env: { TMUX_PANE: "%7" },
        query: () => {
          throw new Error("tmux unavailable");
        },
        listPanes: () => {
          throw new Error("tmux unavailable");
        },
      }),
    ).toMatchObject({
      paneId: "%7",
      visible: true,
      reason: "query-failed",
    });
  });

  it("recovers from a stale TMUX_PANE by resolving the live pane from the process tree", () => {
    expect(
      readTmuxTuiVisibility({
        env: { TMUX_PANE: "%stale" },
        pid: 300,
        query: () => "",
        listPanes: () => "%live\t200\t1\t0\n%other\t400\t1\t1\n",
        listProcesses: () => "300 250\n250 200\n200 1\n",
      }),
    ).toMatchObject({
      paneId: "%live",
      visible: false,
      reason: "hidden",
    });
  });

  it("prefers process-tree visibility when a stale TMUX_PANE still points at a valid pane", () => {
    expect(
      readTmuxTuiVisibility({
        env: { TMUX_PANE: "%stale" },
        pid: 300,
        query: () => "1\t1\n",
        listPanes: () => "%stale\t100\t1\t1\n%live\t200\t1\t0\n",
        listProcesses: () => "300 250\n250 200\n200 1\n100 1\n",
      }),
    ).toMatchObject({
      paneId: "%live",
      visible: false,
      reason: "hidden",
    });
  });

  it("uses a valid direct pane query when process-tree resolution cannot match a pane", () => {
    expect(
      readTmuxTuiVisibility({
        env: { TMUX_PANE: "%current" },
        pid: 300,
        query: () => "1\t1\n",
        listPanes: () => "%current\t100\t1\t1\n",
        listProcesses: () => "300 250\n250 1\n100 1\n",
      }),
    ).toMatchObject({
      paneId: "%current",
      visible: true,
      reason: "visible",
    });
  });

  it("fails open when process-tree resolution cannot match the current pane", () => {
    expect(
      readTmuxTuiVisibility({
        env: { TMUX_PANE: "%current" },
        pid: 300,
        query: () => {
          throw new Error("tmux race");
        },
        listPanes: () => "%current\t100\t1\t1\n",
        listProcesses: () => "300 250\n250 1\n100 1\n",
      }),
    ).toMatchObject({
      paneId: "%current",
      visible: true,
      reason: "query-failed",
    });
  });

  it("treats stale dashboard processes outside live tmux panes as detached", () => {
    expect(
      readTmuxTuiVisibility({
        env: { TMUX_PANE: "%stale" },
        pid: 300,
        query: () => {
          throw new Error("pane missing");
        },
        listPanes: () => "%live\t200\t1\t1\n",
        listProcesses: () => "300 250\n250 1\n200 1\n",
      }),
    ).toMatchObject({
      paneId: "%stale",
      visible: false,
      reason: "detached",
    });
  });
});

describe("tmux pane process resolution", () => {
  it("parses tmux pane rows", () => {
    expect(parseTmuxPaneRows("%1\t123\t1\t0\nbad\n%2\t456\t0\t1\n")).toEqual([
      { paneId: "%1", panePid: 123, attachedRaw: "1", activeWindowRaw: "0" },
      { paneId: "%2", panePid: 456, attachedRaw: "0", activeWindowRaw: "1" },
    ]);
  });

  it("finds the pane whose process tree owns the dashboard process", () => {
    const panes = parseTmuxPaneRows("%1\t100\t1\t0\n%2\t500\t1\t1\n");
    const parents = parseProcessParents("250 200\n200 100\n100 1\n500 1\n");

    expect(findTmuxPaneForProcess(panes, parents, 250)).toMatchObject({ paneId: "%1" });
  });
});

describe("readDashboardTuiVisibilityForHost", () => {
  it("does not query tmux for non-dashboard hosts", () => {
    const query = () => {
      throw new Error("should not query");
    };

    expect(readDashboardTuiVisibilityForHost({ startedInDashboard: false }, { readVisibility: query })).toMatchObject({
      visible: true,
      reason: "not-tmux",
    });
  });

  it("caches visibility briefly", () => {
    let calls = 0;
    const host: any = { startedInDashboard: true };
    const readVisibility = () => {
      calls += 1;
      return parseTmuxVisibility("1\t0", "%1");
    };

    readDashboardTuiVisibilityForHost(host, { now: 1000, readVisibility });
    readDashboardTuiVisibilityForHost(host, { now: 1100, readVisibility });

    expect(calls).toBe(1);
  });

  it("records a wake transition when a hidden dashboard becomes visible", () => {
    const host: any = {
      startedInDashboard: true,
      dashboardTuiVisibility: parseTmuxVisibility("1\t0", "%1"),
      dashboardTuiVisibilityCheckedAt: 1000,
    };

    readDashboardTuiVisibilityForHost(host, {
      force: true,
      now: 2000,
      readVisibility: () => parseTmuxVisibility("1\t1", "%1"),
    });

    expect(host.dashboardTuiVisibility.visible).toBe(true);
    expect(consumeDashboardTuiVisibilityWake(host)).toBe(true);
    expect(consumeDashboardTuiVisibilityWake(host)).toBe(false);
  });
});
