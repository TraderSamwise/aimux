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
});
