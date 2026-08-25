import { describe, expect, it } from "vitest";
import {
  dashboardBuildOf,
  isDashboardProcessArgs,
  selectOrphanedDashboards,
  selectStaleDashboards,
  type DashboardProcess,
} from "./dashboard-orphans.js";

const dashboard = (pid: number, build: string): DashboardProcess => ({
  pid,
  args: `/Users/sam/.volta/bin/node /Users/sam/.aimux/native/${build}/dist/launcher-bin.js --tmux-dashboard-internal`,
});

describe("dashboardBuildOf", () => {
  it("reads the install directory out of argv", () => {
    expect(dashboardBuildOf(dashboard(1, "local-490049e4").args)).toBe("local-490049e4");
  });

  it("returns nothing when the path is not a native install", () => {
    expect(dashboardBuildOf("node /usr/local/bin/aimux --tmux-dashboard-internal")).toBeNull();
  });
});

describe("isDashboardProcessArgs", () => {
  it("matches only the internal dashboard entrypoint", () => {
    expect(isDashboardProcessArgs(dashboard(1, "local-a").args)).toBe(true);
    expect(isDashboardProcessArgs("node launcher-bin.js daemon run")).toBe(false);
  });
});

describe("selectStaleDashboards", () => {
  const current = "local-490049e4";

  it("selects dashboards from builds that are no longer installed", () => {
    const stale = selectStaleDashboards(
      [dashboard(1, "local-94088499"), dashboard(2, "local-06ce8ffe"), dashboard(3, current)],
      current,
    );
    expect(stale.map((entry) => entry.pid)).toEqual([1, 2]);
  });

  it("never selects the current build, however many are running", () => {
    // Several dashboards on the installed build are legitimate — one per tmux
    // client — and killing those takes the live dashboard down with them.
    const stale = selectStaleDashboards([dashboard(1, current), dashboard(2, current), dashboard(3, current)], current);
    expect(stale).toEqual([]);
  });

  it("never selects a process whose build cannot be read, since unknown is not evidence", () => {
    const unknown = { pid: 9, args: "node /usr/local/bin/aimux --tmux-dashboard-internal" };
    expect(selectStaleDashboards([unknown], current)).toEqual([]);
  });

  it("ignores processes that are not dashboards at all", () => {
    const daemon = {
      pid: 5,
      args: `node /Users/sam/.aimux/native/local-old/dist/launcher-bin.js daemon run`,
    };
    expect(selectStaleDashboards([daemon], current)).toEqual([]);
  });

  it("never selects itself", () => {
    const self = dashboard(42, "local-old");
    expect(selectStaleDashboards([self], current, 42)).toEqual([]);
  });

  it("does nothing when the current build is unknown, rather than killing everything", () => {
    // An empty current build would otherwise make every dashboard stale.
    expect(selectStaleDashboards([dashboard(1, "local-a"), dashboard(2, "local-b")], "")).toEqual([]);
  });

  it("matches the real fleet that caused this", () => {
    // 16 builds ran at once; only the two on the installed build should survive.
    const builds = [
      "local-94088499",
      "local-06ce8ffe",
      "local-4175298b",
      "local-30e6a58c",
      "local-d04d3ef0",
      "local-589acac9",
      "local-c9064baa",
      "local-0613c57a",
    ];
    const fleet = builds.map((build, index) => dashboard(index + 1, build));
    fleet.push(dashboard(100, current), dashboard(101, current));

    const stale = selectStaleDashboards(fleet, current);
    expect(stale).toHaveLength(builds.length);
    expect(stale.some((entry) => entry.pid === 100 || entry.pid === 101)).toBe(false);
  });
});

describe("selectOrphanedDashboards", () => {
  const dash = (pid: number) => ({
    pid,
    args: `/Users/sam/.aimux/native/local-a/dist/launcher-bin.js --tmux-dashboard-internal`,
  });

  it("selects a dashboard whose shell was reparented to init", () => {
    const parents = new Map([
      [1, 0],
      [10, 110],
      [110, 1],
    ]);
    expect(selectOrphanedDashboards([dash(10)], parents, 999).map((e) => e.pid)).toEqual([10]);
  });

  it("leaves a dashboard whose shell still descends from tmux", () => {
    const parents = new Map([
      [10, 110],
      [110, 900],
      [900, 1],
    ]);
    expect(selectOrphanedDashboards([dash(10)], parents, 999)).toEqual([]);
  });

  it("selects a dashboard whose shell is no longer a live tmux pane", () => {
    const parents = new Map([
      [10, 110],
      [110, 900],
      [20, 120],
      [120, 900],
      [900, 1],
    ]);
    expect(selectOrphanedDashboards([dash(10), dash(20)], parents, 999, new Set([120])).map((e) => e.pid)).toEqual([
      10,
    ]);
  });

  it("leaves a dashboard whose shell is still a live tmux pane", () => {
    const parents = new Map([
      [10, 110],
      [110, 900],
      [900, 1],
    ]);
    expect(selectOrphanedDashboards([dash(10)], parents, 999, new Set([110]))).toEqual([]);
  });

  it("treats an unknown parent as unknown, not orphaned", () => {
    expect(selectOrphanedDashboards([dash(10)], new Map(), 999)).toEqual([]);
  });

  it("never selects itself", () => {
    const parents = new Map([
      [10, 110],
      [110, 1],
    ]);
    expect(selectOrphanedDashboards([dash(10)], parents, 10)).toEqual([]);
  });

  it("ignores processes that are not dashboards", () => {
    const daemon = { pid: 10, args: "/Users/sam/.aimux/native/local-a/dist/launcher-bin.js daemon run" };
    const parents = new Map([
      [10, 110],
      [110, 1],
    ]);
    expect(selectOrphanedDashboards([daemon], parents, 999)).toEqual([]);
  });
});
