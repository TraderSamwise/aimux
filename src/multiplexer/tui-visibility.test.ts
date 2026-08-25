import { describe, expect, it } from "vitest";
import {
  consumeDashboardTuiVisibilityWake,
  parseTmuxVisibility,
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
      }),
    ).toMatchObject({
      paneId: "%7",
      visible: true,
      reason: "query-failed",
    });
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
