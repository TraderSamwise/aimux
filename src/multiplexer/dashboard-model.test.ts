import { describe, expect, it, vi } from "vitest";

import { DashboardPendingActions } from "../dashboard/pending-actions.js";
import {
  applyDashboardModel,
  buildDashboardWorktreeGroups,
  composeDashboardWorktreeGroups,
  withMetadataServicePending,
  withMetadataSessionPending,
} from "./dashboard-model.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

describe("metadata pending actions", () => {
  it("keeps session pending until the settle callback resolves", async () => {
    const pending = new DashboardPendingActions(() => {});
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
    };
    const settled = deferred<boolean>();

    const resultPromise = withMetadataSessionPending(
      host,
      "codex-1",
      "starting",
      () => ({ sessionId: "codex-1" }),
      undefined,
      () => settled.promise,
    );

    await Promise.resolve();
    await expect(resultPromise).resolves.toEqual({ sessionId: "codex-1" });
    expect(pending.getSessionAction("codex-1")).toBe("starting");

    settled.resolve(true);
    await nextTick();
    expect(pending.getSessionAction("codex-1")).toBeUndefined();
  });

  it("clears service pending and preserves the original work error", async () => {
    const pending = new DashboardPendingActions(() => {});
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
    };
    const settle = vi.fn();

    await expect(
      withMetadataServicePending(
        host,
        "service-1",
        "removing",
        () => {
          throw new Error("boom");
        },
        settle,
      ),
    ).rejects.toThrow("boom");

    expect(settle).not.toHaveBeenCalled();
    expect(pending.getServiceAction("service-1")).toBeUndefined();
  });

  it("clears pending even when a best-effort settle callback fails", async () => {
    const pending = new DashboardPendingActions(() => {});
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
      debug: vi.fn(),
    };

    await expect(
      withMetadataSessionPending(
        host,
        "claude-1",
        "creating",
        () => ({ sessionId: "claude-1" }),
        undefined,
        async () => {
          throw new Error("settle failed");
        },
      ),
    ).resolves.toEqual({ sessionId: "claude-1" });

    await nextTick();
    expect(pending.getSessionAction("claude-1")).toBeUndefined();
    expect(host.debug).toHaveBeenCalledWith(expect.stringContaining("settle failed"), "dashboard");
  });

  it("does not let an older session settle clear a newer pending action", async () => {
    const pending = new DashboardPendingActions(() => {});
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
    };
    const firstSettle = deferred<boolean>();
    const secondSettle = deferred<boolean>();

    await expect(
      withMetadataSessionPending(
        host,
        "codex-1",
        "starting",
        () => ({ sessionId: "codex-1", attempt: 1 }),
        undefined,
        () => firstSettle.promise,
      ),
    ).resolves.toEqual({ sessionId: "codex-1", attempt: 1 });

    await expect(
      withMetadataSessionPending(
        host,
        "codex-1",
        "starting",
        () => ({ sessionId: "codex-1", attempt: 2 }),
        undefined,
        () => secondSettle.promise,
      ),
    ).resolves.toEqual({ sessionId: "codex-1", attempt: 2 });

    firstSettle.resolve(true);
    await nextTick();
    expect(pending.getSessionAction("codex-1")).toBe("starting");

    secondSettle.resolve(true);
    await nextTick();
    expect(pending.getSessionAction("codex-1")).toBeUndefined();
  });

  it("does not let an older service settle clear a newer pending action", async () => {
    const pending = new DashboardPendingActions(() => {});
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
      dashboardServicesCache: [],
      services: [],
      offlineServices: [],
    };
    const firstSettle = deferred<boolean>();
    const secondSettle = deferred<boolean>();

    await expect(
      withMetadataServicePending(
        host,
        "service-1",
        "starting",
        () => ({ serviceId: "service-1", attempt: 1 }),
        () => firstSettle.promise,
      ),
    ).resolves.toEqual({ serviceId: "service-1", attempt: 1 });

    await expect(
      withMetadataServicePending(
        host,
        "service-1",
        "starting",
        () => ({ serviceId: "service-1", attempt: 2 }),
        () => secondSettle.promise,
      ),
    ).resolves.toEqual({ serviceId: "service-1", attempt: 2 });

    firstSettle.resolve(true);
    await nextTick();
    expect(pending.getServiceAction("service-1")).toBe("starting");

    secondSettle.resolve(true);
    await nextTick();
    expect(pending.getServiceAction("service-1")).toBeUndefined();
  });
});
