import { describe, expect, it, vi } from "vitest";

import { DashboardUiStateStore } from "../dashboard/ui-state-store.js";
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

  it("explains instead of stepping into a creating worktree", () => {
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
          createdAt: new Date().toISOString(),
          pending: true,
          pendingAction: "creating",
          sessions: [],
          services: [],
        },
      ],
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      updateWorktreeSessions: vi.fn(),
      renderDashboard: vi.fn(),
      sessions: [],
      footerFlash: "",
      footerFlashTicks: 0,
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("\r"));

    expect(host.footerFlash).toMatch(/^Worktree demo is still creating/);
    expect(host.footerFlashTicks).toBe(3);
    expect(host.updateWorktreeSessions).not.toHaveBeenCalled();
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
      renderDashboard: vi.fn(),
    };

    await dashboardInteractionMethods.activateDashboardEntry.call(host, entry);

    expect(host.preferDashboardEntrySelection).not.toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForEntry).not.toHaveBeenCalled();
    expect(host.footerFlash).toBe("Agent codex-1 is stopping");
    expect(host.renderDashboard).toHaveBeenCalledOnce();
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
      renderDashboard: vi.fn(),
    };

    await dashboardInteractionMethods.activateDashboardService.call(host, service);

    expect(host.preferDashboardEntrySelection).not.toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForService).not.toHaveBeenCalled();
    expect(host.footerFlash).toBe("Service service-1 is stopping");
    expect(host.renderDashboard).toHaveBeenCalledOnce();
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
      renderDashboard: vi.fn(),
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("x"));

    expect(host.stopSessionToOfflineWithFeedback).not.toHaveBeenCalled();
    expect(host.graveyardSessionWithFeedback).not.toHaveBeenCalled();
    expect(host.footerFlash).toBe("Agent codex-1 is stopping");
    expect(host.renderDashboard).toHaveBeenCalledOnce();
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

  it("can open a teammate without changing dashboard selection", async () => {
    const entry = {
      id: "reviewer-1",
      status: "running",
      worktreePath: "/repo/.aimux/worktrees/demo",
      team: { teamId: "team-1", parentSessionId: "parent-1", role: "reviewer" },
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
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(async () => "opened"),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
    };

    await dashboardInteractionMethods.activateDashboardEntry.call(host, entry, { preserveDashboardSelection: true });

    expect(host.preferDashboardEntrySelection).not.toHaveBeenCalled();
    expect(host.persistDashboardUiState).not.toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForEntry).toHaveBeenCalledWith(entry);
  });

  it("refreshes from the service after opening an offline row that is already live", async () => {
    const entry = {
      id: "codex-1",
      status: "offline",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(async () => "opened"),
      refreshDashboardModelFromService: vi.fn(async () => true),
      renderDashboard: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
    };

    await dashboardInteractionMethods.activateDashboardEntry.call(host, entry);

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true);
    expect(host.refreshLocalDashboardModel).not.toHaveBeenCalled();
    expect(host.renderDashboard).toHaveBeenCalledOnce();
  });

  it("dismisses failed worktree rows through the project service", async () => {
    const path = "/repo/.aimux/worktrees/demo";
    const host: any = {
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "worktrees",
        focusedWorktreePath: path,
        worktreeNavOrder: [undefined, path],
        worktreeEntries: [],
      },
      dashboardWorktreeGroupsCache: [
        {
          name: "demo",
          path,
          sessions: [],
          services: [],
          operationFailure: { operation: "create", message: "boom" },
        },
      ],
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      postToProjectService: vi.fn(async () => ({ ok: true })),
      refreshDashboardModelFromService: vi.fn(async () => true),
      refreshLocalDashboardModel: vi.fn(),
      renderDashboard: vi.fn(),
      showDashboardError: vi.fn(),
      sessions: [],
      footerFlash: "",
      footerFlashTicks: 0,
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("x"));
    await vi.waitFor(() => expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true));

    expect(host.postToProjectService).toHaveBeenCalledWith("/operation-failures/clear", {
      targetKind: "worktree",
      operation: "create",
      worktreePath: path,
    });
    expect(host.refreshLocalDashboardModel).not.toHaveBeenCalled();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("opens a teammate picker only for selected agents with teammates", () => {
    const parent = { id: "parent-1", command: "claude", status: "running" };
    const host: any = {
      dashboardState: {
        hasWorktrees: () => false,
        level: "worktrees",
        worktreeEntries: [],
      },
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => [parent]),
      dashboardSessionsCache: [parent],
      dashboardTeammatesCache: [
        {
          id: "reviewer-1",
          command: "codex",
          status: "running",
          team: { teamId: "team-1", parentSessionId: "parent-1", role: "reviewer", order: 1 },
        },
      ],
      openDashboardOverlay: vi.fn(),
      renderTeammatePicker: vi.fn(),
    };

    dashboardInteractionMethods.showTeammatePicker.call(host);

    expect(host.teammatePickerState).toEqual({ parentSessionId: "parent-1", index: 0 });
    expect(host.openDashboardOverlay).toHaveBeenCalledWith("teammate-picker");
    expect(host.renderTeammatePicker).toHaveBeenCalledOnce();
  });

  it("maps teammate picker digits to rendered teammate order", () => {
    const parent = { id: "parent-1", command: "claude", status: "running" };
    const second = {
      id: "second",
      command: "claude",
      status: "running",
      team: { teamId: "team-1", parentSessionId: "parent-1", order: 2 },
    };
    const first = {
      id: "first",
      command: "codex",
      status: "running",
      team: { teamId: "team-1", parentSessionId: "parent-1", order: 1 },
    };
    const host: any = {
      teammatePickerState: { parentSessionId: "parent-1", index: 0 },
      dashboardState: {
        hasWorktrees: () => false,
        level: "worktrees",
        worktreeEntries: [],
      },
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => [parent]),
      dashboardSessionsCache: [parent],
      dashboardTeammatesCache: [second, first],
      clearDashboardOverlay: vi.fn(),
      activateDashboardEntry: vi.fn(),
    };

    dashboardInteractionMethods.handleTeammatePickerKey.call(host, Buffer.from("1"));

    expect(host.clearDashboardOverlay).toHaveBeenCalledOnce();
    expect(host.activateDashboardEntry).toHaveBeenCalledWith(expect.objectContaining({ id: "first" }), {
      preserveDashboardSelection: true,
    });
  });

  it("does not open teammate digits hidden behind the more indicator", () => {
    const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "rows", { configurable: true, value: 12 });
    try {
      const parent = { id: "parent-1", command: "claude", status: "running" };
      const teammates = Array.from({ length: 4 }, (_, index) => ({
        id: `teammate-${index + 1}`,
        command: "codex",
        status: "running",
        team: { teamId: "team-1", parentSessionId: "parent-1", order: index + 1 },
      }));
      const host: any = {
        teammatePickerState: { parentSessionId: "parent-1", index: 0 },
        dashboardState: {
          hasWorktrees: () => false,
          level: "worktrees",
          worktreeEntries: [],
        },
        activeIndex: 0,
        getDashboardSessions: vi.fn(() => [parent]),
        dashboardSessionsCache: [parent],
        dashboardTeammatesCache: teammates,
        clearDashboardOverlay: vi.fn(),
        activateDashboardEntry: vi.fn(),
      };

      dashboardInteractionMethods.handleTeammatePickerKey.call(host, Buffer.from("4"));

      expect(host.activateDashboardEntry).not.toHaveBeenCalled();
      expect(host.clearDashboardOverlay).not.toHaveBeenCalled();
    } finally {
      if (rowsDescriptor) {
        Object.defineProperty(process.stdout, "rows", rowsDescriptor);
      }
    }
  });

  it("closes a stale teammate picker instead of retargeting to another selected parent", () => {
    const selectedParent = { id: "other-parent", command: "claude", status: "running" };
    const host: any = {
      teammatePickerState: { parentSessionId: "missing-parent", index: 0 },
      dashboardState: {
        hasWorktrees: () => false,
        level: "worktrees",
        worktreeEntries: [],
      },
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => [selectedParent]),
      dashboardSessionsCache: [selectedParent],
      dashboardTeammatesCache: [
        {
          id: "wrong-teammate",
          command: "codex",
          status: "running",
          team: { teamId: "team-1", parentSessionId: "other-parent", order: 1 },
        },
      ],
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      activateDashboardEntry: vi.fn(),
    };

    dashboardInteractionMethods.handleTeammatePickerKey.call(host, Buffer.from("\r"));

    expect(host.teammatePickerState).toBeNull();
    expect(host.clearDashboardOverlay).toHaveBeenCalledOnce();
    expect(host.restoreDashboardAfterOverlayDismiss).toHaveBeenCalledOnce();
    expect(host.activateDashboardEntry).not.toHaveBeenCalled();
  });

  it("opens the visibly highlighted teammate when stored picker index is stale", () => {
    const parent = { id: "parent-1", command: "claude", status: "running" };
    const teammates = [
      {
        id: "first",
        command: "codex",
        status: "running",
        team: { teamId: "team-1", parentSessionId: "parent-1", order: 1 },
      },
      {
        id: "second",
        command: "claude",
        status: "running",
        team: { teamId: "team-1", parentSessionId: "parent-1", order: 2 },
      },
    ];
    const host: any = {
      teammatePickerState: { parentSessionId: "parent-1", index: 99 },
      dashboardState: {
        hasWorktrees: () => false,
        level: "worktrees",
        worktreeEntries: [],
      },
      activeIndex: 0,
      getDashboardSessions: vi.fn(() => [parent]),
      dashboardSessionsCache: [parent],
      dashboardTeammatesCache: teammates,
      clearDashboardOverlay: vi.fn(),
      activateDashboardEntry: vi.fn(),
    };

    dashboardInteractionMethods.handleTeammatePickerKey.call(host, Buffer.from("\r"));

    expect(host.activateDashboardEntry).toHaveBeenCalledWith(expect.objectContaining({ id: "second" }), {
      preserveDashboardSelection: true,
    });
  });

  it("submits dashboard handoffs to the handoff route", async () => {
    const host: any = {
      postToProjectService: vi.fn(async () => ({ ok: true })),
      clearDashboardOverlay: vi.fn(),
      footerFlash: "",
      renderDashboard: vi.fn(),
    };

    await dashboardInteractionMethods.submitDashboardOrchestrationAction.call(
      host,
      "handoff",
      { label: "codex-1", sessionId: "codex-1", worktreePath: "/repo" },
      "Take over this task",
    );

    expect(host.postToProjectService).toHaveBeenCalledWith("/handoff", {
      from: "user",
      to: ["codex-1"],
      assignee: undefined,
      tool: undefined,
      worktreePath: "/repo",
      body: "Take over this task",
    });
    expect(host.footerFlash).toBe("Sent handoff to codex-1");
  });

  it("submits dashboard tasks with route-compatible descriptions", async () => {
    const host: any = {
      postToProjectService: vi.fn(async () => ({ ok: true })),
      clearDashboardOverlay: vi.fn(),
      footerFlash: "",
      renderDashboard: vi.fn(),
    };

    await dashboardInteractionMethods.submitDashboardOrchestrationAction.call(
      host,
      "task",
      { label: "reviewer", assignee: "reviewer", tool: "codex", worktreePath: "/repo" },
      "Review this diff",
    );

    expect(host.postToProjectService).toHaveBeenCalledWith("/tasks/assign", {
      from: "user",
      to: undefined,
      assignee: "reviewer",
      tool: "codex",
      worktreePath: "/repo",
      description: "Review this diff",
    });
    expect(host.footerFlash).toBe("Assigned task to reviewer");
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

  it("refreshes stale worktree entries before activating selected agent rows", () => {
    const dashEntry = {
      id: "codex-new",
      status: "running",
      worktreePath: "/repo",
    };
    const host: any = {
      dashboardState: {
        worktreeEntries: [{ kind: "session", id: "codex-new" }],
        worktreeSessions: [],
        sessionIndex: 0,
        focusedWorktreePath: "/repo",
      },
      dashboardWorktreeGroupsCache: [
        {
          name: "Main Checkout",
          path: "/repo",
          removing: false,
          sessions: [],
          services: [],
        },
      ],
      updateWorktreeSessions: vi.fn(function (this: any) {
        this.dashboardState.worktreeSessions = [dashEntry];
        this.dashboardState.worktreeEntries = [{ kind: "session", id: "codex-new" }];
      }),
      activateDashboardEntry: vi.fn(),
      getDashboardServices: vi.fn(() => []),
    };

    dashboardInteractionMethods.activateSelectedDashboardWorktreeEntry.call(host);

    expect(host.updateWorktreeSessions).toHaveBeenCalledOnce();
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

  it("reorders selected agents within their worktree without mixing services", () => {
    const store = new DashboardUiStateStore();
    const sessions = [
      { id: "agent-a", worktreePath: "/repo/.aimux/worktrees/demo" },
      { id: "agent-b", worktreePath: "/repo/.aimux/worktrees/demo" },
    ];
    const services = [
      { id: "service-a", worktreePath: "/repo/.aimux/worktrees/demo" },
      { id: "service-b", worktreePath: "/repo/.aimux/worktrees/demo" },
    ];
    const host: any = {
      dashboardUiStateStore: store,
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "sessions",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeSessions: sessions,
        worktreeEntries: [
          { kind: "session", id: "agent-a" },
          { kind: "session", id: "agent-b" },
          { kind: "service", id: "service-a" },
          { kind: "service", id: "service-b" },
        ],
        sessionIndex: 0,
      },
      dashboardWorktreeGroupsCache: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          sessions,
          services,
        },
      ],
      updateWorktreeSessions: vi.fn(function (this: any) {
        const orderedSessions = store.orderSessionsForWorktree(sessions as any, "/repo/.aimux/worktrees/demo");
        const orderedServices = store.orderServicesForWorktree(services as any, "/repo/.aimux/worktrees/demo");
        this.dashboardState.worktreeSessions = orderedSessions;
        this.dashboardState.worktreeEntries = [
          ...orderedSessions.map((session: any) => ({ kind: "session", id: session.id }) as const),
          ...orderedServices.map((service: any) => ({ kind: "service", id: service.id }) as const),
        ];
      }),
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
      postToProjectService: vi.fn(async () => ({})),
      renderDashboard: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("\x1b[1;2B"));

    expect(host.dashboardState.worktreeEntries).toEqual([
      { kind: "session", id: "agent-b" },
      { kind: "session", id: "agent-a" },
      { kind: "service", id: "service-a" },
      { kind: "service", id: "service-b" },
    ]);
    expect(host.dashboardState.sessionIndex).toBe(1);
    expect(host.dashboardWorktreeGroupsCache[0]?.sessions.map((session: any) => session.id)).toEqual([
      "agent-b",
      "agent-a",
    ]);
    expect(host.dashboardWorktreeGroupsCache[0]?.services.map((service: any) => service.id)).toEqual([
      "service-a",
      "service-b",
    ]);
    expect(host.preferDashboardEntrySelection).toHaveBeenCalledWith(
      "session",
      "agent-a",
      "/repo/.aimux/worktrees/demo",
    );
    expect(host.persistDashboardUiState).toHaveBeenCalledOnce();
    expect(host.postToProjectService).toHaveBeenCalledWith("/statusline/refresh", { force: true });
    expect(host.renderDashboard).toHaveBeenCalledOnce();
  });
});

function dashboardActionWaitStub(kind: "entry" | "service") {
  return vi.fn(async function (this: any, target: any) {
    return kind === "entry" ? this.openLiveTmuxWindowForEntry(target) : this.openLiveTmuxWindowForService(target);
  });
}
