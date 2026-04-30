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

  it("waits briefly for a live agent window to become enterable", async () => {
    const entry = {
      id: "codex-1",
      status: "running",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      dashboardWorktreeGroupsCache: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          removing: false,
          sessions: [],
          services: [],
        },
      ],
      dashboardPendingActions: new Map(),
      openLiveTmuxWindowForEntry: vi.fn().mockReturnValueOnce("missing").mockReturnValueOnce("opened"),
      waitAndOpenLiveTmuxWindowForEntry: dashboardActionWaitStub("entry"),
      takeOverFromDashEntryWithFeedback: vi.fn(),
      takeoffFromDashEntryWithFeedback: vi.fn(),
      resumeOfflineSessionWithFeedback: vi.fn(),
      sessions: [],
      noteLastUsedItem: vi.fn(),
      focusSession: vi.fn(),
    };

    await dashboardInteractionMethods.activateDashboardEntry.call(host, entry);

    expect(host.waitAndOpenLiveTmuxWindowForEntry).toHaveBeenCalledWith(entry);
  });

  it("routes selected worktree session activation through the unified entry path", () => {
    const dashEntry = {
      id: "codex-1",
      status: "offline",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      dashboardState: {
        worktreeEntries: [{ kind: "session", id: "codex-1" }],
        worktreeSessions: [dashEntry],
        sessionIndex: 0,
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
      },
      dashboardWorktreeGroupsCache: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          removing: false,
          sessions: [],
          services: [],
        },
      ],
      activateDashboardEntry: vi.fn(),
      getDashboardServices: vi.fn(() => []),
    };

    dashboardInteractionMethods.activateSelectedDashboardWorktreeEntry.call(host);

    expect(host.activateDashboardEntry).toHaveBeenCalledWith(dashEntry);
  });

  it("routes selected worktree service activation through the unified service path", () => {
    const service = {
      id: "service-1",
      status: "offline",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      dashboardState: {
        worktreeEntries: [{ kind: "service", id: "service-1" }],
        sessionIndex: 0,
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
      },
      dashboardWorktreeGroupsCache: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          removing: false,
          sessions: [],
          services: [],
        },
      ],
      activateDashboardService: vi.fn(),
      getDashboardServices: vi.fn(() => [service]),
    };

    dashboardInteractionMethods.activateSelectedDashboardWorktreeEntry.call(host);

    expect(host.activateDashboardService).toHaveBeenCalledWith(service);
  });

  it("uses the unified entry path for flat dashboard enter", () => {
    const entry = { id: "claude-1", status: "offline" };
    const host: any = {
      dashboardState: { hasWorktrees: () => false, quickJumpDigits: "" },
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      dashboardStateHasWorktrees: false,
      getDashboardSessions: vi.fn(() => [entry]),
      activeIndex: 0,
      activateDashboardEntry: vi.fn(),
      sessions: [],
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("\r"));

    expect(host.activateDashboardEntry).toHaveBeenCalledWith(entry);
  });
});

function dashboardActionWaitStub(kind: "entry" | "service") {
  return vi.fn(async function (this: any, target: any) {
    return kind === "entry" ? this.openLiveTmuxWindowForEntry(target) : this.openLiveTmuxWindowForService(target);
  });
}
