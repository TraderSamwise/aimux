import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardUiStateStore } from "../dashboard/ui-state-store.js";
import { dashboardInteractionMethods } from "./dashboard-interaction.js";

const dashboardApiClientMock = vi.hoisted(() => ({
  mutateDashboardApi: vi.fn(),
}));

vi.mock("./dashboard-api-client.js", async () => {
  const actual = await vi.importActual<typeof import("./dashboard-api-client.js")>("./dashboard-api-client.js");
  dashboardApiClientMock.mutateDashboardApi.mockImplementation(actual.mutateDashboardApi);
  return {
    ...actual,
    mutateDashboardApi: dashboardApiClientMock.mutateDashboardApi,
  };
});

vi.mock("../team.js", async () => {
  const actual = await vi.importActual<typeof import("../team.js")>("../team.js");
  return {
    ...actual,
    loadTeamConfig: vi.fn(() => actual.getDefaultTeamConfig()),
  };
});

describe("dashboardInteractionMethods", () => {
  beforeEach(() => {
    dashboardApiClientMock.mutateDashboardApi.mockClear();
  });

  it("requests reviews through the project service", async () => {
    const host: any = {
      activeSession: { id: "codex-1", command: "codex" },
      sessionRoles: new Map([["codex-1", "coder"]]),
      sessionWorktreePaths: new Map([["codex-1", "/repo/.aimux/worktrees/demo"]]),
      postToProjectService: vi.fn(async () => ({ ok: true, task: { assignee: "reviewer" } })),
      renderDashboard: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
    };

    await dashboardInteractionMethods.handleReviewRequest.call(host);

    expect(host.postToProjectService).toHaveBeenCalledWith(
      "/tasks/assign",
      expect.objectContaining({
        from: "codex-1",
        assignee: "reviewer",
        description: "Review: Review codex agent's recent work",
        prompt: "Review codex agent's recent work",
        type: "review",
        worktreePath: "/repo/.aimux/worktrees/demo",
        assigner: "coder",
        reviewOf: "codex-1",
        iteration: 1,
      }),
    );
    expect(host.footerFlash).toBe("⧫ Review requested → reviewer");
    expect(host.renderDashboard).toHaveBeenCalledOnce();
  });

  it("captures review diffs from the project root for root sessions", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-review-root-"));
    try {
      execFileSync("git", ["init"], { cwd: repoRoot });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoRoot });
      writeFileSync(join(repoRoot, "demo.txt"), "before\n");
      execFileSync("git", ["add", "demo.txt"], { cwd: repoRoot });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: repoRoot });
      writeFileSync(join(repoRoot, "demo.txt"), "after\n");
      const host: any = {
        activeSession: { id: "codex-1", command: "codex" },
        projectRoot: repoRoot,
        sessionRoles: new Map([["codex-1", "coder"]]),
        sessionWorktreePaths: new Map(),
        postToProjectService: vi.fn(async () => ({ ok: true, task: { assignee: "reviewer" } })),
        renderDashboard: vi.fn(),
      };

      await dashboardInteractionMethods.handleReviewRequest.call(host);

      expect(host.postToProjectService).toHaveBeenCalledWith(
        "/tasks/assign",
        expect.objectContaining({
          diff: expect.stringContaining("+after"),
          worktreePath: undefined,
        }),
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not locally create services from the dashboard input path", () => {
    const host: any = {
      mode: "terminal",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      showDashboardError: vi.fn(),
      createService: vi.fn(),
      serviceInputBuffer: "yarn dev",
      dashboardState: {},
    };

    dashboardInteractionMethods.handleServiceInputKey.call(host, Buffer.from("\r"));

    expect(host.createService).not.toHaveBeenCalled();
    expect(host.showDashboardError).toHaveBeenCalledWith("Failed to create service", [
      "Service creation requires the project service.",
    ]);
  });

  it("accepts pasted service commands before submit in the same input chunk", () => {
    const host: any = {
      mode: "dashboard",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      showDashboardError: vi.fn(),
      createDashboardServiceWithFeedback: vi.fn(),
      renderServiceInput: vi.fn(),
      serviceInputBuffer: "",
      dashboardState: { focusedWorktreePath: "/repo/.aimux/worktrees/demo" },
    };

    dashboardInteractionMethods.handleServiceInputKey.call(host, Buffer.from("yarn dev\r"));

    expect(host.createDashboardServiceWithFeedback).toHaveBeenCalledWith("yarn dev", "/repo/.aimux/worktrees/demo");
  });

  it("handles fast dashboard navigation keys delivered in one input chunk", () => {
    const host: any = {
      mode: "dashboard",
      dashboardOverlayState: { kind: "none" },
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "sessions",
        worktreeEntries: [
          { kind: "session", id: "claude-1" },
          { kind: "service", id: "service-1" },
        ],
        sessionIndex: 1,
      },
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: dashboardInteractionMethods.handleDashboardQuickJumpDigit,
      activateSelectedDashboardWorktreeEntry: vi.fn(),
      renderDashboard: vi.fn(),
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("k\r"));

    expect(host.dashboardState.sessionIndex).toBe(0);
    expect(host.renderDashboard).toHaveBeenCalledOnce();
    expect(host.activateSelectedDashboardWorktreeEntry).toHaveBeenCalledOnce();
  });

  it("opens the visible session-level digit row without waiting for a second digit", () => {
    const sessions = [
      { id: "codex-1", command: "codex", status: "running", worktreePath: "/repo/.aimux/worktrees/demo" },
      { id: "codex-2", command: "codex", status: "running", worktreePath: "/repo/.aimux/worktrees/demo" },
    ];
    const services = [
      { id: "service-1", command: "shell", args: [], status: "running", worktreePath: "/repo/.aimux/worktrees/demo" },
    ];
    const host: any = {
      mode: "dashboard",
      dashboardOverlayState: { kind: "none" },
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "sessions",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeEntries: [],
        sessionIndex: 0,
      },
      dashboardSessionsCache: sessions,
      dashboardServicesCache: services,
      dashboardWorktreeGroupsCache: [{ name: "demo", path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      dashboardMainCheckoutInfoCache: { name: "Main Checkout", branch: "master" },
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: dashboardInteractionMethods.handleDashboardQuickJumpDigit,
      updateWorktreeSessions: vi.fn(function (this: any) {
        this.dashboardState.worktreeEntries = [
          { kind: "session", id: "codex-1" },
          { kind: "session", id: "codex-2" },
          { kind: "service", id: "service-1" },
        ];
      }),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
      activateSelectedDashboardWorktreeEntry: vi.fn(),
      clearDashboardQuickJump: dashboardInteractionMethods.clearDashboardQuickJump,
      focusDashboardQuickJumpEntry: dashboardInteractionMethods.focusDashboardQuickJumpEntry,
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("3\r"));

    expect(host.dashboardState.sessionIndex).toBe(2);
    expect(host.preferDashboardEntrySelection).toHaveBeenCalledWith(
      "service",
      "service-1",
      "/repo/.aimux/worktrees/demo",
    );
    expect(host.activateSelectedDashboardWorktreeEntry).toHaveBeenCalledOnce();
  });

  it("maps session-level digits to the rendered worktree entry order", () => {
    const host: any = {
      mode: "dashboard",
      dashboardOverlayState: { kind: "none" },
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "sessions",
        focusedWorktreePath: undefined,
        worktreeEntries: [
          { kind: "session", id: "stale-cache-first" },
          { kind: "session", id: "codex-2" },
          { kind: "session", id: "codex-3" },
          { kind: "session", id: "codex-visible" },
        ],
        sessionIndex: 0,
      },
      dashboardSessionsCache: [
        { id: "codex-visible", command: "codex", status: "running" },
        { id: "stale-cache-first", command: "codex", status: "running" },
      ],
      dashboardServicesCache: [],
      dashboardWorktreeGroupsCache: [],
      dashboardMainCheckoutInfoCache: { name: "Main Checkout", branch: "master" },
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: dashboardInteractionMethods.handleDashboardQuickJumpDigit,
      updateWorktreeSessions: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
      activateSelectedDashboardWorktreeEntry: vi.fn(),
      clearDashboardQuickJump: dashboardInteractionMethods.clearDashboardQuickJump,
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("4"));

    expect(host.dashboardState.sessionIndex).toBe(3);
    expect(host.preferDashboardEntrySelection).toHaveBeenCalledWith("session", "codex-visible", undefined);
    expect(host.activateSelectedDashboardWorktreeEntry).toHaveBeenCalledOnce();
  });

  it("uses digit keys for worktree focus at worktree level", () => {
    const host: any = {
      mode: "dashboard",
      dashboardOverlayState: { kind: "none" },
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "worktrees",
        focusedWorktreePath: undefined,
      },
      dashboardSessionsCache: [],
      dashboardServicesCache: [],
      dashboardWorktreeGroupsCache: [
        { name: "demo", branch: "feat/demo", path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] },
      ],
      dashboardMainCheckoutInfoCache: { name: "Main Checkout", branch: "master" },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: dashboardInteractionMethods.handleDashboardQuickJumpDigit,
      clearDashboardQuickJump: dashboardInteractionMethods.clearDashboardQuickJump,
      focusDashboardQuickJumpWorktree: dashboardInteractionMethods.focusDashboardQuickJumpWorktree,
      renderDashboard: vi.fn(),
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("2"));

    expect(host.dashboardState.focusedWorktreePath).toBe("/repo/.aimux/worktrees/demo");
    expect(host.dashboardState.level).toBe("worktrees");
    expect(host.renderDashboard).toHaveBeenCalledOnce();
  });

  it("uses lowercase l for dashboard step-in instead of library", () => {
    const host: any = {
      mode: "dashboard",
      dashboardOverlayState: { kind: "none" },
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "worktrees",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeNavOrder: ["/repo/.aimux/worktrees/demo"],
      },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", name: "demo" }],
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      updateWorktreeSessions: vi.fn(function (this: any) {
        this.dashboardState.worktreeEntries = [{ kind: "session", id: "codex-1" }];
      }),
      showLibrary: vi.fn(),
      renderDashboard: vi.fn(),
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("l"));

    expect(host.showLibrary).not.toHaveBeenCalled();
    expect(host.updateWorktreeSessions).toHaveBeenCalledOnce();
    expect(host.dashboardState.level).toBe("sessions");
  });

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

  it("queues stop instead of deleting an offline service that is still starting", () => {
    const service = {
      id: "service-1",
      status: "offline",
      pendingAction: "starting",
      label: "shell",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "sessions",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeEntries: [{ kind: "service", id: "service-1" }],
        worktreeSessions: [],
        sessionIndex: 0,
      },
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      getSelectedDashboardServiceForActions: vi.fn(() => service),
      stopDashboardServiceWithFeedback: vi.fn(),
      removeDashboardServiceWithFeedback: vi.fn(),
      getDashboardSessions: vi.fn(() => []),
      sessions: [],
      dashboardWorktreeGroupsCache: [],
      renderDashboard: vi.fn(),
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("x"));

    expect(host.stopDashboardServiceWithFeedback).toHaveBeenCalledWith(service);
    expect(host.removeDashboardServiceWithFeedback).not.toHaveBeenCalled();
  });

  it("queues stop instead of deleting a service whose activation is in flight", () => {
    const service = {
      id: "service-1",
      status: "offline",
      label: "shell",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "sessions",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeEntries: [{ kind: "service", id: "service-1" }],
        worktreeSessions: [],
        sessionIndex: 0,
      },
      dashboardActivatingServiceIds: new Set(["service-1"]),
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      getSelectedDashboardServiceForActions: vi.fn(() => service),
      stopDashboardServiceWithFeedback: vi.fn(),
      removeDashboardServiceWithFeedback: vi.fn(),
      getDashboardSessions: vi.fn(() => []),
      sessions: [],
      dashboardWorktreeGroupsCache: [],
      renderDashboard: vi.fn(),
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("x"));

    expect(host.stopDashboardServiceWithFeedback).toHaveBeenCalledWith(service);
    expect(host.removeDashboardServiceWithFeedback).not.toHaveBeenCalled();
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

  it("routes worktree row reorders through the dashboard API adapter", async () => {
    const host: any = {
      mode: "dashboard",
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "sessions",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeEntries: [
          { kind: "session", id: "codex-1" },
          { kind: "session", id: "claude-1" },
        ],
        sessionIndex: 0,
      },
      dashboardUiStateStore: {
        moveEntryWithinWorktree: vi.fn(() => true),
        orderWorktreeGroups: vi.fn((groups) => groups),
      },
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo" }],
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      updateWorktreeSessions: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
      postToProjectService: vi.fn(async () => ({ ok: true })),
      renderDashboard: vi.fn(),
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("\x1b[1;2B"));

    expect(host.dashboardUiStateStore.moveEntryWithinWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedId: "codex-1",
        direction: "down",
      }),
    );
    await vi.waitFor(() =>
      expect(host.postToProjectService).toHaveBeenCalledWith("/statusline/refresh", { force: true }),
    );
    expect(dashboardApiClientMock.mutateDashboardApi).toHaveBeenCalledWith(host, "/statusline/refresh", {
      force: true,
    });
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

  it("resumes exited agents in the non-dashboard fallback path", async () => {
    const entry = {
      id: "codex-1",
      status: "exited",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const offline = { ...entry, restoreState: "ready" };
    const host: any = {
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(async () => "missing"),
      offlineSessions: [offline],
      resumeOfflineSessionWithFeedback: vi.fn(async () => "settled"),
      sessions: [],
      noteLastUsedItem: vi.fn(),
      focusSession: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
    };

    await expect(dashboardInteractionMethods.activateDashboardEntry.call(host, entry)).resolves.toBe("opened");

    expect(host.resumeOfflineSessionWithFeedback).toHaveBeenCalledWith(offline);
    expect(host.focusSession).not.toHaveBeenCalled();
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

  it("resumes and refreshes an offline dashboard agent without opening it", async () => {
    const entry = {
      id: "codex-1",
      status: "offline",
      command: "codex",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      mode: "dashboard",
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(async () => "opened"),
      refreshDashboardModelFromService: vi.fn(async () => true),
      resumeOfflineSessionWithFeedback: vi.fn(async () => "settled"),
      getDashboardSessions: vi.fn(() => [{ ...entry, status: "running", tmuxWindowId: "@agent" }]),
      offlineSessions: [{ ...entry }],
      renderDashboard: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
    };

    await dashboardInteractionMethods.activateDashboardEntry.call(host, entry);

    expect(host.resumeOfflineSessionWithFeedback).toHaveBeenCalledWith(entry);
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true, undefined);
    expect(host.waitAndOpenLiveTmuxWindowForEntry).not.toHaveBeenCalled();
    expect(host.refreshLocalDashboardModel).not.toHaveBeenCalled();
    expect(host.renderDashboard).toHaveBeenCalledOnce();
  });

  it("does not resume a blocked offline dashboard agent", async () => {
    const entry = {
      id: "codex-1",
      status: "offline",
      command: "codex",
      label: "Codex",
      restoreState: "blocked",
      restoreBlockedReason: "missing exact resumable backend session id",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      mode: "dashboard",
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      resumeOfflineSessionWithFeedback: vi.fn(),
      refreshDashboardModelFromService: vi.fn(),
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
      renderDashboard: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
    };

    await expect(dashboardInteractionMethods.activateDashboardEntry.call(host, entry)).resolves.toBe("blocked");

    expect(host.resumeOfflineSessionWithFeedback).not.toHaveBeenCalled();
    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForEntry).not.toHaveBeenCalled();
    expect(host.footerFlash).toBe("Cannot restore Codex: missing exact resumable backend session id");
    expect(host.renderDashboard).toHaveBeenCalledOnce();
  });

  it("does not open or render an offline dashboard agent after newer input invalidates activation", async () => {
    const entry = {
      id: "codex-1",
      status: "offline",
      command: "codex",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(async () => "opened"),
      refreshDashboardModelFromService: vi.fn(async () => true),
      resumeOfflineSessionWithFeedback: vi.fn(async () => {
        host.mode = "session";
        host.dashboardInputEpoch = 1;
        return "settled";
      }),
      getDashboardSessions: vi.fn(() => [{ ...entry, status: "running", tmuxWindowId: "@agent" }]),
      offlineSessions: [{ ...entry }],
      renderDashboard: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
    };

    await expect(dashboardInteractionMethods.activateDashboardEntry.call(host, entry)).resolves.toBe("missing");

    expect(host.resumeOfflineSessionWithFeedback).toHaveBeenCalledWith(entry);
    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForEntry).not.toHaveBeenCalled();
    expect(host.renderDashboard).not.toHaveBeenCalled();
  });

  it("refreshes from the service after resuming an offline row", async () => {
    const entry = {
      id: "codex-1",
      status: "offline",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      mode: "dashboard",
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(async () => "error"),
      refreshDashboardModelFromService: vi.fn(async () => true),
      resumeOfflineSessionWithFeedback: vi.fn(async () => "settled"),
      getDashboardSessions: vi.fn(() => [entry]),
      offlineSessions: [{ ...entry }],
      renderDashboard: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
    };

    await dashboardInteractionMethods.activateDashboardEntry.call(host, entry);

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true, undefined);
    expect(host.waitAndOpenLiveTmuxWindowForEntry).not.toHaveBeenCalled();
    expect(host.renderDashboard).toHaveBeenCalledOnce();
  });

  it("returns pending for an offline dashboard agent that is still reconciling", async () => {
    const entry = {
      id: "codex-1",
      status: "offline",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      mode: "dashboard",
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(async () => "opened"),
      refreshDashboardModelFromService: vi.fn(async () => true),
      resumeOfflineSessionWithFeedback: vi.fn(async () => "pending"),
      getDashboardSessions: vi.fn(() => [entry]),
      offlineSessions: [{ ...entry }],
      renderDashboard: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
    };

    await expect(dashboardInteractionMethods.activateDashboardEntry.call(host, entry)).resolves.toBe("pending");

    expect(host.resumeOfflineSessionWithFeedback).toHaveBeenCalledWith(entry);
    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForEntry).not.toHaveBeenCalled();
    expect(host.renderDashboard).not.toHaveBeenCalled();
  });

  it("does not return pending for an offline dashboard agent after newer input invalidates activation", async () => {
    const entry = {
      id: "codex-1",
      status: "offline",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(async () => "opened"),
      refreshDashboardModelFromService: vi.fn(async () => true),
      resumeOfflineSessionWithFeedback: vi.fn(async () => {
        host.dashboardInputEpoch = 1;
        return "pending";
      }),
      getDashboardSessions: vi.fn(() => [entry]),
      offlineSessions: [{ ...entry }],
      renderDashboard: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
    };

    await expect(dashboardInteractionMethods.activateDashboardEntry.call(host, entry)).resolves.toBe("missing");

    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForEntry).not.toHaveBeenCalled();
    expect(host.renderDashboard).not.toHaveBeenCalled();
  });

  it("opens an offline service after the shared resume path settles", async () => {
    const service = {
      id: "service-1",
      status: "offline",
      label: "shell",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const services = [
      [service],
      [{ ...service, status: "offline", pendingAction: "starting" }],
      [{ ...service, status: "running", tmuxWindowId: "@service" }],
    ];
    let serviceIndex = 0;
    const host: any = {
      mode: "dashboard",
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      getDashboardServices: vi.fn(() => services[Math.min(serviceIndex, services.length - 1)]),
      openLiveTmuxWindowForService: vi.fn(),
      waitAndOpenLiveTmuxWindowForService: vi.fn(async () => "opened"),
      resumeOfflineServiceWithFeedback: vi.fn(async () => {
        serviceIndex = services.length - 1;
        return "settled";
      }),
      refreshDashboardModelFromService: vi.fn(async () => true),
      reapplyDashboardPendingActions: vi.fn(),
      renderDashboard: vi.fn(),
      showDashboardError: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
    };

    await expect(dashboardInteractionMethods.activateDashboardService.call(host, service)).resolves.toBe("opened");

    expect(host.resumeOfflineServiceWithFeedback).toHaveBeenCalledWith(service);
    expect(host.openLiveTmuxWindowForService).not.toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "service-1", tmuxWindowId: "@service" }),
      60_000,
    );
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true, undefined);
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("returns pending for an offline service that is still reconciling", async () => {
    const service = {
      id: "service-1",
      status: "offline",
      label: "shell",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      mode: "dashboard",
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      getDashboardServices: vi.fn(() => [service]),
      openLiveTmuxWindowForService: vi.fn(),
      waitAndOpenLiveTmuxWindowForService: vi.fn(async () => "opened"),
      resumeOfflineServiceWithFeedback: vi.fn(async () => "pending"),
      refreshDashboardModelFromService: vi.fn(async () => true),
      renderDashboard: vi.fn(),
      showDashboardError: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
    };

    await expect(dashboardInteractionMethods.activateDashboardService.call(host, service)).resolves.toBe("pending");

    expect(host.resumeOfflineServiceWithFeedback).toHaveBeenCalledWith(service);
    expect(host.waitAndOpenLiveTmuxWindowForService).not.toHaveBeenCalled();
    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("does not return pending for an offline service after newer input invalidates activation", async () => {
    const service = {
      id: "service-1",
      status: "offline",
      label: "shell",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      getDashboardServices: vi.fn(() => [service]),
      waitAndOpenLiveTmuxWindowForService: vi.fn(async () => "opened"),
      resumeOfflineServiceWithFeedback: vi.fn(async () => {
        host.dashboardInputEpoch = 1;
        return "pending";
      }),
      refreshDashboardModelFromService: vi.fn(async () => true),
      renderDashboard: vi.fn(),
      showDashboardError: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
    };

    await expect(dashboardInteractionMethods.activateDashboardService.call(host, service)).resolves.toBe("missing");

    expect(host.waitAndOpenLiveTmuxWindowForService).not.toHaveBeenCalled();
    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("refreshes and reports unavailable service when a running service open misses", async () => {
    const service = {
      id: "service-1",
      status: "running",
      label: "shell",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      mode: "dashboard",
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      openLiveTmuxWindowForService: vi.fn(),
      waitAndOpenLiveTmuxWindowForService: vi.fn(async () => "missing"),
      refreshDashboardModelFromService: vi.fn(async () => true),
      renderDashboard: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
    };

    await expect(dashboardInteractionMethods.activateDashboardService.call(host, service)).resolves.toBe("missing");

    expect(host.openLiveTmuxWindowForService).not.toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForService).toHaveBeenCalledWith(service);
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true, undefined);
    expect(host.footerFlash).toBe("Service shell is not available yet");
    expect(host.renderDashboard).toHaveBeenCalledOnce();
  });

  it("does not fall back to local focus when the dashboard control route misses", async () => {
    const entry = {
      id: "codex-1",
      status: "running",
      label: "Codex",
      command: "codex",
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const host: any = {
      mode: "dashboard",
      dashboardWorktreeGroupsCache: [{ path: "/repo/.aimux/worktrees/demo", sessions: [], services: [] }],
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(async () => "missing"),
      refreshDashboardModelFromService: vi.fn(async () => true),
      renderDashboard: vi.fn(),
      preferDashboardEntrySelection: vi.fn(),
      persistDashboardUiState: vi.fn(),
      offlineSessions: [],
      resumeOfflineSessionWithFeedback: vi.fn(),
      sessions: [{ id: "codex-1" }],
      noteLastUsedItem: vi.fn(),
      focusSession: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
    };

    await dashboardInteractionMethods.activateDashboardEntry.call(host, entry);

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true, undefined);
    expect(host.focusSession).not.toHaveBeenCalled();
    expect(host.noteLastUsedItem).not.toHaveBeenCalled();
    expect(host.resumeOfflineSessionWithFeedback).not.toHaveBeenCalled();
    expect(host.footerFlash).toBe("Agent Codex is not available yet");
    expect(host.renderDashboard).toHaveBeenCalledOnce();
  });

  it("dismisses failed worktree rows through the project service", async () => {
    const path = "/repo/.aimux/worktrees/demo";
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
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
    await vi.waitFor(() =>
      expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ lifecycle: expect.objectContaining({ mode: "dashboard", inputEpoch: undefined }) }),
      ),
    );

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

  it("does not render stale worktree failure dismissal completions after later input", async () => {
    let resolveClear!: () => void;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "worktrees",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeNavOrder: ["/repo/.aimux/worktrees/demo"],
        worktreeEntries: [],
      },
      dashboardWorktreeGroupsCache: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          sessions: [],
          services: [],
          operationFailure: { operation: "create", message: "branch exists" },
        },
      ],
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      postToProjectService: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveClear = resolve;
          }),
      ),
      refreshDashboardModelFromService: vi.fn(async () => true),
      renderDashboard: vi.fn(),
      showDashboardError: vi.fn(),
      sessions: [],
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("x"));
    expect(host.renderDashboard).toHaveBeenCalledOnce();
    host.dashboardInputEpoch = 1;
    resolveClear();
    await vi.waitFor(() => expect(host.refreshDashboardModelFromService).toHaveBeenCalledOnce());

    expect(host.renderDashboard).toHaveBeenCalledOnce();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("does not show stale orchestration completion after later input", async () => {
    let resolveSend!: () => void;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      postToProjectService: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSend = resolve;
          }),
      ),
      clearDashboardOverlay: vi.fn(),
      renderDashboard: vi.fn(),
      showDashboardError: vi.fn(),
    };
    const lifecycle = { mode: "dashboard" as const, inputEpoch: 0, requiresInputEpoch: true };

    const submit = dashboardInteractionMethods.submitDashboardOrchestrationAction.call(
      host,
      "handoff",
      { label: "codex-1", sessionId: "codex-1", worktreePath: "/repo" },
      "Take over this task",
      lifecycle,
    );
    await vi.waitFor(() => expect(host.postToProjectService).toHaveBeenCalledOnce());
    host.dashboardInputEpoch = 1;
    resolveSend();
    await submit;

    expect(host.footerFlash).toBeUndefined();
    expect(host.clearDashboardOverlay).not.toHaveBeenCalled();
    expect(host.renderDashboard).not.toHaveBeenCalled();
    expect(host.showDashboardError).not.toHaveBeenCalled();
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
      mode: "dashboard",
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
      openLiveTmuxWindowForService: vi.fn(),
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
    expect(host.openLiveTmuxWindowForService).not.toHaveBeenCalled();
    expect(host.waitAndOpenLiveTmuxWindowForService).toHaveBeenCalledWith(service);
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

  it("uses lowercase hjkl for worktree-level dashboard navigation before commands", () => {
    const host: any = {
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "worktrees",
        focusedWorktreePath: "/repo",
        worktreeNavOrder: ["/repo", "/repo/.aimux/worktrees/demo"],
        worktreeEntries: [],
        sessionIndex: 0,
      },
      dashboardWorktreeGroupsCache: [
        { path: "/repo", name: "main", sessions: [], services: [] },
        { path: "/repo/.aimux/worktrees/demo", name: "demo", sessions: [], services: [] },
      ],
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      updateWorktreeSessions: vi.fn(function (this: any) {
        this.dashboardState.worktreeEntries = [{ kind: "session", id: "codex-1" }];
        this.dashboardState.worktreeSessions = [{ id: "codex-1" }];
      }),
      showLibrary: vi.fn(),
      showOrchestrationRoutePicker: vi.fn(),
      renderDashboard: vi.fn(),
      sessions: [],
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("j"));
    expect(host.dashboardState.focusedWorktreePath).toBe("/repo/.aimux/worktrees/demo");

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("k"));
    expect(host.dashboardState.focusedWorktreePath).toBe("/repo");

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("h"));
    expect(host.showOrchestrationRoutePicker).not.toHaveBeenCalled();

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("l"));
    expect(host.updateWorktreeSessions).toHaveBeenCalledOnce();
    expect(host.dashboardState.level).toBe("sessions");
    expect(host.dashboardState.sessionIndex).toBe(0);
    expect(host.showLibrary).not.toHaveBeenCalled();
  });

  it("resets stale worktree focus before hjkl worktree navigation", () => {
    const host: any = {
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "worktrees",
        focusedWorktreePath: "/repo/.aimux/worktrees/deleted",
        worktreeNavOrder: ["/repo", "/repo/.aimux/worktrees/demo"],
        worktreeEntries: [],
        sessionIndex: 0,
      },
      dashboardWorktreeGroupsCache: [
        { path: "/repo", name: "main", sessions: [], services: [] },
        { path: "/repo/.aimux/worktrees/demo", name: "demo", sessions: [], services: [] },
      ],
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      renderDashboard: vi.fn(),
      sessions: [],
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("j"));
    expect(host.dashboardState.focusedWorktreePath).toBe("/repo");

    host.dashboardState.focusedWorktreePath = "/repo/.aimux/worktrees/deleted";
    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("k"));
    expect(host.dashboardState.focusedWorktreePath).toBe("/repo");
  });

  it("uses lowercase hjkl for session-level dashboard navigation before commands", () => {
    const host: any = {
      dashboardState: {
        hasWorktrees: () => true,
        quickJumpDigits: "",
        level: "sessions",
        focusedWorktreePath: "/repo/.aimux/worktrees/demo",
        worktreeEntries: [
          { kind: "session", id: "codex-1" },
          { kind: "session", id: "codex-2" },
        ],
        sessionIndex: 0,
      },
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      activateSelectedDashboardWorktreeEntry: vi.fn(),
      showLibrary: vi.fn(),
      showOrchestrationRoutePicker: vi.fn(),
      renderDashboard: vi.fn(),
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("j"));
    expect(host.dashboardState.sessionIndex).toBe(1);

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("k"));
    expect(host.dashboardState.sessionIndex).toBe(0);

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("l"));
    expect(host.activateSelectedDashboardWorktreeEntry).toHaveBeenCalledOnce();
    expect(host.showLibrary).not.toHaveBeenCalled();

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("h"));
    expect(host.dashboardState.level).toBe("worktrees");
    expect(host.showOrchestrationRoutePicker).not.toHaveBeenCalled();
  });

  it("uses lowercase l to focus flat dashboard entries", () => {
    const entry = { id: "claude-1", status: "offline" };
    const host: any = {
      dashboardState: { hasWorktrees: () => false, quickJumpDigits: "" },
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      getDashboardSessions: vi.fn(() => [entry]),
      activeIndex: 0,
      activateDashboardEntry: vi.fn(),
      showLibrary: vi.fn(),
      sessions: [],
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("l"));

    expect(host.activateDashboardEntry).toHaveBeenCalledWith(entry);
    expect(host.showLibrary).not.toHaveBeenCalled();
  });

  it("uses shifted L to open Library from the dashboard", () => {
    const host: any = {
      dashboardState: { hasWorktrees: () => false, quickJumpDigits: "" },
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      showLibrary: vi.fn(),
      getDashboardSessions: vi.fn(() => []),
      sessions: [],
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("L"));

    expect(host.showLibrary).toHaveBeenCalledOnce();
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

  it("handles shifted dashboard command keys from printable uppercase input", () => {
    const selected = { id: "codex-1", command: "codex", threadWaitingOnMeCount: 1 };
    const host: any = {
      dashboardState: {
        hasWorktrees: () => false,
        quickJumpDigits: "",
      },
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      handleDashboardQuickJumpDigit: vi.fn(() => false),
      showOrchestrationRoutePicker: vi.fn(),
      showLibrary: vi.fn(),
      showWorktreeList: vi.fn(),
      getSelectedDashboardSessionForActions: vi.fn(() => selected),
      openRelevantThreadForSession: vi.fn(),
    };

    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("H"));
    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("L"));
    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("T"));
    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("W"));
    dashboardInteractionMethods.handleDashboardKey.call(host, Buffer.from("R"));

    expect(host.showOrchestrationRoutePicker).toHaveBeenCalledWith("handoff");
    expect(host.showOrchestrationRoutePicker).toHaveBeenCalledWith("task");
    expect(host.showLibrary).toHaveBeenCalledOnce();
    expect(host.showWorktreeList).toHaveBeenCalledOnce();
    expect(host.openRelevantThreadForSession).toHaveBeenCalledWith("codex-1");
  });
});

function dashboardActionWaitStub(kind: "entry" | "service") {
  return vi.fn(async function (this: any, target: any) {
    return kind === "entry" ? this.openLiveTmuxWindowForEntry(target) : this.openLiveTmuxWindowForService(target);
  });
}
