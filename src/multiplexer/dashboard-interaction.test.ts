import { describe, expect, it, vi } from "vitest";

import { dashboardInteractionMethods } from "./dashboard-interaction.js";

describe("dashboardInteractionMethods", () => {
  it("blocks stepping into a removing worktree", () => {
    const host: any = {
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "worktrees",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeNavOrder: [undefined, "/repo/.aimux/worktrees/demo"],
        worktreeEntries: [],
      },
      dashboardWorktreeGroupsCache: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          removing: true,
          sessions: [],
          services: [],
        },
      ],
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      renderDashboard: vi.fn(),
      sessions: [],
      footerFlash: "",
      footerFlashTicks: 0,
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("\r"));

    expect(host.footerFlash).toBe("Worktree demo is removing");
    expect(host.footerFlashTicks).toBe(3);
    expect(host.renderDashboard).toHaveBeenCalledOnce();
    expect(host.dashboardState.level).toBe("worktrees");
  });

  it("blocks activating an entry inside a removing worktree", () => {
    const host: any = {
      dashboardState: {
        worktreeEntries: [{ kind: "session", id: "claude-1" }],
        sessionIndex: 0,
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
      },
      dashboardWorktreeGroupsCache: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          removing: true,
          sessions: [],
          services: [],
        },
      ],
      renderDashboard: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
      getDashboardServices: vi.fn(() => []),
      dashboardStateHasWorktrees: true,
    };

    dashboardInteractionMethods.activateSelectedDashboardWorktreeEntry.call(host);

    expect(host.footerFlash).toBe("Worktree demo is removing");
    expect(host.footerFlashTicks).toBe(3);
    expect(host.renderDashboard).toHaveBeenCalledOnce();
  });
});
