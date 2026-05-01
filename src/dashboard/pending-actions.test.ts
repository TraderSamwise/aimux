import { describe, expect, it } from "vitest";

import { DashboardPendingActions } from "./pending-actions.js";

describe("DashboardPendingActions", () => {
  it("synthesizes optimistic session rows for creating sessions that do not exist yet", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.set("claude-new", "creating", {
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
    pending.set("claude-1", "stopping", {
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

  it("keeps stopping service rows visible while waiting for offline state", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.set("service-1", "stopping", {
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
});
