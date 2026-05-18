import { describe, expect, it } from "vitest";

import { DashboardPendingActions } from "../dashboard/pending-actions.js";
import {
  applyDashboardModel,
  buildDashboardWorktreeGroups,
  composeDashboardWorktreeGroups,
} from "./dashboard-model.js";

describe("buildDashboardWorktreeGroups", () => {
  it("always includes main checkout as the first group", () => {
    const groups = buildDashboardWorktreeGroups(
      {},
      [
        {
          index: 0,
          id: "main-agent",
          command: "codex",
          status: "running",
          active: false,
        },
      ],
      [],
      [
        {
          name: "Main Checkout",
          path: "/repo",
          branch: "master",
          isBare: false,
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        {
          name: "feature-a",
          path: "/repo/.aimux/worktrees/feature-a",
          branch: "feature-a",
          isBare: false,
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ],
      "/repo",
    );

    expect(groups.map((group) => [group.path, group.name, group.branch])).toEqual([
      [undefined, "Main Checkout", "master"],
      ["/repo/.aimux/worktrees/feature-a", "feature-a", "feature-a"],
    ]);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["main-agent"]);
  });

  it("places optimistic creating sessions into the correct worktree group", () => {
    const groups = composeDashboardWorktreeGroups(
      [
        {
          name: "Main Checkout",
          branch: "master",
          path: undefined,
          status: "offline",
          sessions: [],
          services: [],
        },
        {
          name: "demo",
          branch: "demo",
          path: "/repo/.aimux/worktrees/demo",
          status: "offline",
          sessions: [],
          services: [],
        },
      ],
      [
        {
          index: -1,
          id: "claude-new",
          command: "claude",
          label: "claude",
          status: "waiting",
          active: false,
          worktreePath: "/repo/.aimux/worktrees/demo",
          pendingAction: "creating",
          optimistic: true,
        },
      ],
      [],
    );

    expect(groups[1]?.sessions.map((session) => session.id)).toEqual(["claude-new"]);
    expect(groups[1]?.status).toBe("active");
  });

  it("preserves worktree operation failure state in grouped rows", () => {
    const groups = buildDashboardWorktreeGroups(
      {},
      [],
      [],
      [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          branch: "(failed)",
          isBare: false,
          operationFailure: {
            id: "failure-1",
            targetKind: "worktree",
            operation: "create",
            title: 'Failed to create worktree "demo"',
            message: "branch already exists",
            worktreePath: "/repo/.aimux/worktrees/demo",
            worktreeName: "demo",
            createdAt: "2026-05-01T00:00:00.000Z",
          },
        },
      ],
      "/repo",
    );

    expect(groups[1]?.operationFailure?.message).toBe("branch already exists");
  });
});

describe("applyDashboardModel", () => {
  it("rebuilds derived caches when only pending actions change", () => {
    const pending = new DashboardPendingActions(() => {});
    const host: any = {
      dashboardPendingActions: pending,
      dashboardUiStateStore: {
        orderWorktreeGroups: (groups: unknown) => groups,
        markSelectionDirty: () => {},
      },
    };
    const mainCheckoutInfo = { name: "Main Checkout", branch: "master" };
    const worktreeGroups = [
      {
        name: "Main Checkout",
        branch: "master",
        path: undefined,
        status: "offline" as const,
        sessions: [],
        services: [],
      },
    ];

    pending.setServiceAction("service-new", "creating", {
      serviceSeed: {
        id: "service-new",
        command: "shell",
        args: [],
        label: "shell",
        status: "running",
        active: false,
      },
    });

    expect(applyDashboardModel(host, [], [], worktreeGroups, mainCheckoutInfo)).toBe(true);
    expect(host.dashboardServicesCache).toEqual([
      expect.objectContaining({ id: "service-new", pendingAction: "creating", optimistic: true }),
    ]);

    pending.clearServiceAction("service-new");

    expect(applyDashboardModel(host, [], [], worktreeGroups, mainCheckoutInfo)).toBe(true);
    expect(host.dashboardServicesCache).toEqual([]);
  });
});
