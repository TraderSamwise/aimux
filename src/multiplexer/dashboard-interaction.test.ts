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

  it("blocks activating an entry inside a graveyarding worktree", () => {
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
          pendingAction: "graveyarding",
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

    expect(host.footerFlash).toBe("Worktree demo is graveyarding");
    expect(host.footerFlashTicks).toBe(3);
    expect(host.renderDashboard).toHaveBeenCalledOnce();
  });

  it("blocks activating entries with terminal pending actions", async () => {
    const entry = {
      id: "codex-1",
      status: "running",
      pendingAction: "stopping",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      dashboardWorktreeGroupsCache: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          sessions: [],
          services: [],
        },
      ],
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
    };

    await dashboardInteractionMethods.activateDashboardEntry.call(host, entry);

    expect(host.preferDashboardEntrySelection).not.toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForEntry).not.toHaveBeenCalled();
  });

  it("blocks activating services with terminal pending actions", async () => {
    const service = {
      id: "service-1",
      status: "running",
      pendingAction: "stopping",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      dashboardWorktreeGroupsCache: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          sessions: [],
          services: [],
        },
      ],
      waitAndOpenLiveTmuxWindowForService: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
    };

    await dashboardInteractionMethods.activateDashboardService.call(host, service);

    expect(host.preferDashboardEntrySelection).not.toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForService).not.toHaveBeenCalled();
  });

  it("does not stop or remove entries that are already pending", () => {
    const entry = {
      id: "codex-1",
      kind: "session",
      status: "running",
      pendingAction: "stopping",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "sessions",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeEntries: [{ kind: "session", id: "codex-1" }],
        worktreeSessions: [entry],
        sessionIndex: 0,
      },
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      getSelectedDashboardServiceForActions: vi.fn(() => null),
      getDashboardSessions: vi.fn(() => [entry]),
      sessions: [{ id: "codex-1" }],
      dashboardWorktreeGroupsCache: [],
      stopSessionToOfflineWithFeedback: vi.fn(),
      graveyardSessionWithFeedback: vi.fn(),
      isSessionRuntimeLive: vi.fn(() => true),
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("x"));

    expect(host.stopSessionToOfflineWithFeedback).not.toHaveBeenCalled();
    expect(host.graveyardSessionWithFeedback).not.toHaveBeenCalled();
  });

  it("stops a live dashboard agent row even when this process has no local runtime", () => {
    const entry = {
      id: "claude-1",
      kind: "session",
      command: "claude",
      status: "running",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      mode: "dashboard",
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "sessions",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeEntries: [{ kind: "session", id: "claude-1" }],
        worktreeSessions: [entry],
        sessionIndex: 0,
      },
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      getSelectedDashboardServiceForActions: vi.fn(() => null),
      getDashboardSessions: vi.fn(() => [entry]),
      sessions: [],
      dashboardWorktreeGroupsCache: [],
      stopSessionToOfflineWithFeedback: vi.fn(),
      graveyardSessionWithFeedback: vi.fn(),
      isSessionRuntimeLive: vi.fn(),
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("x"));

    expect(host.stopSessionToOfflineWithFeedback).toHaveBeenCalledOnce();
    expect(host.stopSessionToOfflineWithFeedback).toHaveBeenCalledWith(entry);
    expect(host.graveyardSessionWithFeedback).not.toHaveBeenCalled();
    expect(host.isSessionRuntimeLive).not.toHaveBeenCalled();
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
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
    };

    await dashboardInteractionMethods.activateDashboardEntry.call(host, entry);

    expect(host.preferDashboardEntrySelection).toHaveBeenCalledWith(
      "session",
      "codex-1",
      "/repo/.aimux/worktrees/demo",
    );
    expect(host.persistDashboardUiState).toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForEntry).toHaveBeenCalledWith(entry);
  });

  it("persists preferred service selection before opening a service", async () => {
    const service = {
      id: "service-1",
      status: "running",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      footerFlash: "",
      footerFlashTicks: 0,
      renderDashboard: vi.fn(),
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
      waitAndOpenLiveTmuxWindowForService: vi.fn(async () => "opened"),
      resumeOfflineServiceWithFeedback: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
    };

    await dashboardInteractionMethods.activateDashboardService.call(host, service);

    expect(host.preferDashboardEntrySelection).toHaveBeenCalledWith(
      "service",
      "service-1",
      "/repo/.aimux/worktrees/demo",
    );
    expect(host.persistDashboardUiState).toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForService).toHaveBeenCalledWith("service-1");
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
