import { describe, expect, it, vi } from "vitest";

import { DashboardPendingActions, isBlockingPendingDashboardActionKind } from "./pending-actions.js";

describe("DashboardPendingActions", () => {
  it("recognizes every pending dashboard action as blocking", () => {
    expect(
      ["creating", "forking", "migrating", "starting", "stopping", "graveyarding", "renaming", "removing"].every(
        (kind) => isBlockingPendingDashboardActionKind(kind),
      ),
    ).toBe(true);
  });

  it("does not treat missing or unknown pending actions as blocking", () => {
    expect(isBlockingPendingDashboardActionKind(undefined)).toBe(false);
    expect(isBlockingPendingDashboardActionKind(null)).toBe(false);
    expect(isBlockingPendingDashboardActionKind("done")).toBe(false);
  });

  it("synthesizes optimistic session rows for creating sessions that do not exist yet", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setSessionAction("claude-new", "creating", {
      sessionSeed: {
        index: -1,
        id: "claude-new",
        command: "claude",
        label: "claude",
        status: "waiting",
        active: false,
        worktreePath: "/repo/.aimux/worktrees/demo",
      },
    });

    const sessions = pending.applyToSessions([]);

    expect(sessions).toEqual([
      expect.objectContaining({
        id: "claude-new",
        command: "claude",
        label: "claude",
        status: "waiting",
        worktreePath: "/repo/.aimux/worktrees/demo",
        pendingAction: "creating",
        optimistic: true,
      }),
    ]);
  });

  it("keeps stopping session rows visible while waiting for offline state", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setSessionAction("claude-1", "stopping", {
      sessionSeed: {
        index: -1,
        id: "claude-1",
        command: "claude",
        label: "claude",
        status: "running",
        active: false,
        worktreePath: "/repo/.aimux/worktrees/demo",
      },
    });

    const sessions = pending.applyToSessions([]);

    expect(sessions).toEqual([
      expect.objectContaining({
        id: "claude-1",
        status: "running",
        pendingAction: "stopping",
        optimistic: true,
      }),
    ]);
  });

  it("keeps migrating session rows visible while waiting for the new runtime", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setSessionAction("claude-1", "migrating", {
      sessionSeed: {
        index: -1,
        id: "claude-1",
        command: "claude",
        label: "claude",
        status: "running",
        active: false,
        worktreePath: "/repo/.aimux/worktrees/source",
      },
    });

    const sessions = pending.applyToSessions([]);

    expect(sessions).toEqual([
      expect.objectContaining({
        id: "claude-1",
        status: "running",
        pendingAction: "migrating",
        optimistic: true,
      }),
    ]);
  });

  it("keeps stopping service rows visible while waiting for offline state", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setServiceAction("service-1", "stopping", {
      serviceSeed: {
        id: "service-1",
        command: "shell",
        args: [],
        label: "shell",
        status: "running",
        active: false,
        worktreePath: "/repo/.aimux/worktrees/demo",
      },
    });

    const services = pending.applyToServices([]);

    expect(services).toEqual([
      expect.objectContaining({
        id: "service-1",
        status: "running",
        pendingAction: "stopping",
        optimistic: true,
      }),
    ]);
  });

  it("keeps create pending until the rendered model settles", async () => {
    vi.useFakeTimers();
    try {
      const pending = new DashboardPendingActions(() => {});
      let rendered = false;
      let settled = false;
      pending.setServiceAction("service-1", "creating", {
        serviceSeed: {
          id: "service-1",
          command: "shell",
          args: [],
          label: "shell",
          status: "running",
          active: false,
        },
      });

      pending.settleCreatePending(
        "service-1",
        () => {
          settled = true;
        },
        {
          isSettled: () => rendered,
          timeoutMs: 1_000,
        },
      );

      await vi.advanceTimersByTimeAsync(250);
      expect(pending.get("service-1")).toBe("creating");
      expect(settled).toBe(false);

      rendered = true;
      await vi.advanceTimersByTimeAsync(100);

      expect(pending.get("service-1")).toBeUndefined();
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies worktree pending actions from raw worktree paths", () => {
    const pending = new DashboardPendingActions(() => {});
    const worktree = {
      name: "demo",
      branch: "demo",
      path: "/repo/.aimux/worktrees/demo",
      status: "offline" as const,
      sessions: [],
      services: [],
    };

    pending.setWorktreeAction(worktree.path, "graveyarding");

    expect(pending.applyToWorktrees([worktree])).toEqual([
      expect.objectContaining({
        path: worktree.path,
        pending: true,
        pendingAction: "graveyarding",
        removing: true,
        optimistic: true,
      }),
    ]);

    pending.clearWorktreeAction(worktree.path);

    expect(pending.applyToWorktrees([worktree])).toEqual([worktree]);
  });

  it("increments version when a timed out action is removed", async () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const pending = new DashboardPendingActions(onChange);
      pending.setServiceAction("service-1", "creating", {
        timeoutMs: 1_000,
        serviceSeed: {
          id: "service-1",
          command: "shell",
          args: [],
          label: "shell",
          status: "running",
          active: false,
        },
      });
      const initialVersion = pending.getVersion();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(pending.get("service-1")).toBeUndefined();
      expect(pending.getVersion()).toBe(initialVersion + 1);
      expect(onChange).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not notify or increment version for unchanged visible pending state", () => {
    const onChange = vi.fn();
    const pending = new DashboardPendingActions(onChange);
    const serviceSeed = {
      id: "service-1",
      command: "shell",
      args: [],
      label: "shell",
      status: "running",
      active: false,
    };
    pending.setServiceAction("service-1", "creating", { serviceSeed });
    const version = pending.getVersion();
    onChange.mockClear();

    pending.setServiceAction("service-1", "creating", { serviceSeed });

    expect(pending.getVersion()).toBe(version);
    expect(onChange).not.toHaveBeenCalled();
  });
});
