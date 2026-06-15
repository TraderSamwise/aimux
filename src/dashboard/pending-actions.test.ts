import { describe, expect, it, vi } from "vitest";

import { isBlockingPendingDashboardActionKind } from "../pending-actions.js";
import { DashboardPendingActions } from "./pending-actions.js";

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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T12:00:00.000Z"));
    try {
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
          pending: true,
          pendingAction: "creating",
          pendingStartedAt: "2026-05-09T12:00:00.000Z",
          optimistic: true,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not synthesize teammate session rows into normal session lists", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setSessionAction("codex-reviewer", "starting", {
      sessionSeed: {
        index: -1,
        id: "codex-reviewer",
        command: "codex",
        label: "reviewer",
        status: "offline",
        active: false,
        worktreePath: "/repo",
        team: { teamId: "team-claude-parent", parentSessionId: "claude-parent", role: "reviewer" },
      },
    });

    expect(pending.applyToSessions([])).toEqual([]);
    expect(pending.applyToSessions([], { includeTeammates: true })).toEqual([]);
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

    expect(sessions).toEqual([]);
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

    expect(sessions).toEqual([]);
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
        pending: true,
        pendingAction: "stopping",
        optimistic: true,
      }),
    ]);
  });

  it("projects existing service removals as pending", () => {
    const pending = new DashboardPendingActions(() => {});
    const service = {
      id: "service-1",
      command: "shell",
      args: [],
      label: "shell",
      status: "offline" as const,
      active: false,
      worktreePath: "/repo/.aimux/worktrees/demo",
    };

    pending.setServiceAction("service-1", "removing", { serviceSeed: service });

    expect(pending.applyToServices([service])).toEqual([
      expect.objectContaining({
        id: "service-1",
        pending: true,
        pendingAction: "removing",
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
        "service",
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
      expect(pending.getServiceAction("service-1")).toBe("creating");
      expect(settled).toBe(false);

      rendered = true;
      await vi.advanceTimersByTimeAsync(100);

      expect(pending.getServiceAction("service-1")).toBeUndefined();
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

  it("synthesizes optimistic worktree rows for creating worktrees that do not exist yet", () => {
    const pending = new DashboardPendingActions(() => {});
    const worktreeSeed = {
      name: "demo",
      branch: "demo",
      path: "/repo/.aimux/worktrees/demo",
      createdAt: "2026-05-01T00:00:00.000Z",
      status: "offline" as const,
      isBare: false,
      sessions: [],
      services: [],
    };

    pending.setWorktreeAction(worktreeSeed.path, "creating", { worktreeSeed });

    expect(pending.applyToWorktrees([])).toEqual([
      expect.objectContaining({
        path: worktreeSeed.path,
        pending: true,
        pendingAction: "creating",
        optimistic: true,
      }),
    ]);
  });

  it("projects existing worktree removals while synthesizing only missing creates", () => {
    const pending = new DashboardPendingActions(() => {});
    const removingWorktree = {
      name: "old",
      branch: "old",
      path: "/repo/.aimux/worktrees/old",
      status: "offline" as const,
      isBare: false,
      sessions: [],
      services: [],
    };
    const creatingWorktree = {
      name: "new",
      branch: "new",
      path: "/repo/.aimux/worktrees/new",
      createdAt: "2026-05-01T00:00:00.000Z",
      status: "offline" as const,
      isBare: false,
      sessions: [],
      services: [],
    };

    pending.setWorktreeAction(removingWorktree.path, "removing");
    pending.setWorktreeAction(creatingWorktree.path, "creating", { worktreeSeed: creatingWorktree });

    expect(pending.applyToWorktrees([removingWorktree])).toEqual([
      expect.objectContaining({
        path: removingWorktree.path,
        pending: true,
        pendingAction: "removing",
        removing: true,
        optimistic: true,
      }),
      expect.objectContaining({
        path: creatingWorktree.path,
        pending: true,
        pendingAction: "creating",
        optimistic: true,
      }),
    ]);
  });

  it("does not synthesize duplicate worktree rows when the real row exists", () => {
    const pending = new DashboardPendingActions(() => {});
    const worktreeSeed = {
      name: "demo",
      branch: "demo",
      path: "/repo/.aimux/worktrees/demo",
      createdAt: "2026-05-01T00:00:00.000Z",
      status: "offline" as const,
      isBare: false,
      sessions: [],
      services: [],
    };

    pending.setWorktreeAction(worktreeSeed.path, "creating", { worktreeSeed });

    const worktrees = pending.applyToWorktrees([{ ...worktreeSeed, branch: "real-branch" }]);

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toMatchObject({
      path: worktreeSeed.path,
      branch: "real-branch",
      pending: true,
      pendingAction: "creating",
      optimistic: true,
    });
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

      expect(pending.getServiceAction("service-1")).toBeUndefined();
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

  it("keeps session and service pending actions isolated for the same raw id", () => {
    const pending = new DashboardPendingActions(() => {});
    const sharedId = "shared-id";

    pending.setSessionAction(sharedId, "starting", {
      sessionSeed: {
        index: -1,
        id: sharedId,
        command: "claude",
        label: "claude",
        status: "offline",
        active: false,
      },
    });
    pending.setServiceAction(sharedId, "stopping", {
      serviceSeed: {
        id: sharedId,
        command: "shell",
        args: [],
        label: "shell",
        status: "running",
        active: false,
      },
    });

    expect(pending.getSessionAction(sharedId)).toBe("starting");
    expect(pending.getServiceAction(sharedId)).toBe("stopping");
    expect(pending.applyToSessions([])).toEqual([]);
    expect(pending.applyToServices([])).toEqual([
      expect.objectContaining({
        id: sharedId,
        pendingAction: "stopping",
        optimistic: true,
      }),
    ]);
  });

  it("does not let a session timeout clear a service action with the same raw id", async () => {
    vi.useFakeTimers();
    try {
      const pending = new DashboardPendingActions(() => {});
      const sharedId = "shared-id";
      pending.setSessionAction(sharedId, "starting", { timeoutMs: 1_000 });
      pending.setServiceAction(sharedId, "starting");

      await vi.advanceTimersByTimeAsync(1_000);

      expect(pending.getSessionAction(sharedId)).toBeUndefined();
      expect(pending.getServiceAction(sharedId)).toBe("starting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an older same-kind timeout clear a replaced action", async () => {
    vi.useFakeTimers();
    try {
      const pending = new DashboardPendingActions(() => {});
      pending.setServiceAction("service-1", "starting", { timeoutMs: 1_000 });

      await vi.advanceTimersByTimeAsync(500);
      pending.setServiceAction("service-1", "starting", { timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(500);

      expect(pending.getServiceAction("service-1")).toBe("starting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles only the requested pending target for matching raw ids", async () => {
    vi.useFakeTimers();
    try {
      const pending = new DashboardPendingActions(() => {});
      const sharedId = "shared-id";
      pending.setSessionAction(sharedId, "creating");
      pending.setServiceAction(sharedId, "creating");

      pending.settleCreatePending("service", sharedId, () => {}, {
        isSettled: () => true,
      });
      await vi.advanceTimersByTimeAsync(250);

      expect(pending.getSessionAction(sharedId)).toBe("creating");
      expect(pending.getServiceAction(sharedId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let stale settle callbacks clear newer pending actions", async () => {
    vi.useFakeTimers();
    try {
      const pending = new DashboardPendingActions(() => {});
      let settled = false;
      pending.setServiceAction("service-1", "creating");

      pending.settleCreatePending("service", "service-1", () => {
        settled = true;
      });
      pending.setServiceAction("service-1", "starting");

      await vi.advanceTimersByTimeAsync(250);

      expect(pending.getServiceAction("service-1")).toBe("starting");
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps worktree pending actions isolated from matching session and service ids", () => {
    const pending = new DashboardPendingActions(() => {});
    const id = "/repo/.aimux/worktrees/demo";
    const worktree = {
      name: "demo",
      branch: "demo",
      path: id,
      status: "offline" as const,
      isBare: false,
      sessions: [],
      services: [],
    };

    pending.setWorktreeAction(id, "removing");
    pending.setSessionAction(id, "starting");
    pending.setServiceAction(id, "starting");

    expect(pending.getWorktreeAction(id)).toBe("removing");
    expect(pending.getSessionAction(id)).toBe("starting");
    expect(pending.getServiceAction(id)).toBe("starting");
    expect(pending.applyToWorktrees([worktree])).toEqual([
      expect.objectContaining({
        path: id,
        pendingAction: "removing",
        removing: true,
        optimistic: true,
      }),
    ]);
  });

  it("applies main worktree pending actions only to the main checkout", () => {
    const pending = new DashboardPendingActions(() => {});
    const main = {
      name: "Main Checkout",
      branch: "master",
      path: undefined,
      status: "offline" as const,
      sessions: [],
      services: [],
    };
    const worktree = {
      name: "worktree:__main__",
      branch: "worktree:__main__",
      path: "worktree:__main__",
      status: "offline" as const,
      sessions: [],
      services: [],
    };

    pending.setWorktreeAction(undefined, "creating");

    expect(pending.getWorktreeAction(undefined)).toBe("creating");
    expect(pending.getWorktreeAction(worktree.path)).toBeUndefined();
    expect(pending.applyToWorktrees([main, worktree])).toEqual([
      expect.objectContaining({
        path: undefined,
        pendingAction: "creating",
        optimistic: true,
      }),
      worktree,
    ]);
  });
});
