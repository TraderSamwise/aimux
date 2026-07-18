import { describe, expect, it, vi } from "vitest";

import { dashboardViewMethods } from "./dashboard-view-methods.js";
import { dashboardStateMethods } from "./dashboard-state-methods.js";

describe("dashboardViewMethods.renderDashboard", () => {
  it("renders from already-reconciled dashboard state without persisting", () => {
    const dashboardUpdate = vi.fn();
    const host: any = {
      dashboardRenderOptions: null,
      writeStatuslineFile: vi.fn(),
      getViewportSize: () => ({ cols: 120, rows: 40 }),
      dashboardSessionsCache: [
        {
          id: "live-session",
          worktreePath: "/wt",
          status: "running",
        },
      ],
      dashboardTeammatesCache: [
        {
          id: "reviewer",
          command: "codex",
          worktreePath: "/wt",
          status: "running",
          team: { teamId: "team-1", parentSessionId: "live-session", role: "reviewer" },
        },
        {
          id: "other-reviewer",
          command: "codex",
          worktreePath: "/wt",
          status: "running",
          team: { teamId: "team-2", parentSessionId: "other-session", role: "reviewer" },
        },
      ],
      dashboardServicesCache: [],
      dashboardWorktreeGroupsCache: [{ path: "/wt" }],
      dashboardMainCheckoutInfoCache: { name: "Main Checkout", branch: "master" },
      dashboardState: {
        worktreeNavOrder: ["/wt"],
        focusedWorktreePath: "/wt",
        level: "sessions",
        worktreeEntries: [{ kind: "session", id: "live-session" }],
        worktreeSessions: [{ id: "live-session", worktreePath: "/wt", status: "running" }],
        sessionIndex: 0,
      },
      dashboard: {
        update: dashboardUpdate,
        render: vi.fn(() => "frame"),
      },
      syncTuiNotificationContext: vi.fn(),
      writeFrame: vi.fn(),
      persistDashboardUiState: vi.fn(),
      dashboardBusyState: null,
      dashboardErrorState: null,
      renderDashboardBusyOverlay: vi.fn(),
      renderDashboardErrorOverlay: vi.fn(),
    };

    dashboardViewMethods.renderDashboard.call(host);

    expect(dashboardUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessions: host.dashboardSessionsCache,
        services: host.dashboardServicesCache,
        worktreeGroups: host.dashboardWorktreeGroupsCache,
        focusedWorktreePath: "/wt",
        navLevel: "sessions",
        selectedSessionId: "live-session",
        selectedServiceId: undefined,
        selectedTeammates: [expect.objectContaining({ id: "reviewer" })],
        runtimeLabel: "tmux",
        mainCheckout: host.dashboardMainCheckoutInfoCache,
      }),
    );
    expect(host.persistDashboardUiState).not.toHaveBeenCalled();
  });

  it("composes the active dashboard overlay through writeFrame instead of a second overlay write", () => {
    const host: any = {
      dashboardRenderOptions: null,
      writeStatuslineFile: vi.fn(),
      getViewportSize: () => ({ cols: 120, rows: 40 }),
      dashboardSessionsCache: [],
      dashboardServicesCache: [],
      dashboardWorktreeGroupsCache: [],
      dashboardMainCheckoutInfoCache: { name: "Main Checkout", branch: "master" },
      dashboardState: {
        focusedWorktreePath: undefined,
        level: "sessions",
        worktreeEntries: [],
        sessionIndex: 0,
      },
      dashboard: {
        update: vi.fn(),
        render: vi.fn(() => "base-frame"),
      },
      syncTuiNotificationContext: vi.fn(),
      writeFrame: vi.fn(),
      persistDashboardUiState: vi.fn(),
      dashboardBusyState: { title: "Busy", lines: [], spinnerFrame: 0, startedAt: Date.now() },
      dashboardErrorState: null,
    };

    dashboardViewMethods.renderDashboard.call(host);

    expect(host.writeFrame).toHaveBeenCalledTimes(1);
    expect(host.writeFrame).toHaveBeenCalledWith("base-frame");
  });

  it("writes a visible static error frame if dashboard rendering throws", () => {
    const host: any = {
      dashboardRenderOptions: null,
      writeStatuslineFile: vi.fn(),
      getViewportSize: () => ({ cols: 80, rows: 24 }),
      dashboardSessionsCache: [],
      dashboardTeammatesCache: [],
      dashboardServicesCache: [],
      dashboardWorktreeGroupsCache: [],
      dashboardMainCheckoutInfoCache: { name: "Main Checkout", branch: "master" },
      dashboardState: {
        focusedWorktreePath: undefined,
        level: "sessions",
        worktreeEntries: [],
        sessionIndex: 0,
      },
      dashboard: {
        update: vi.fn(),
        render: vi.fn(() => {
          throw new Error("render boom");
        }),
      },
      dashboardFeedback: {
        clearBusy: vi.fn(),
        errorState: null,
      },
      syncTuiNotificationContext: vi.fn(),
      writeFrame: vi.fn(),
    };

    dashboardViewMethods.renderDashboard.call(host);

    expect(host.writeFrame).toHaveBeenCalledWith(expect.stringContaining("Dashboard render failed"), true);
    expect(host.writeFrame).toHaveBeenCalledWith(expect.stringContaining("render boom"), true);
  });
});

describe("dashboardViewMethods.settleDashboardCreatePending", () => {
  it("settles a creating service when the rendered row has live runtime evidence", async () => {
    let isSettled: (() => Promise<boolean> | boolean) | undefined;
    const host: any = {
      startedInDashboard: true,
      mode: "dashboard",
      dashboardPendingActions: {
        settleCreatePending: vi.fn((_target, _itemId, _onSettled, opts) => {
          isSettled = opts.isSettled;
        }),
      },
      refreshDashboardModelFromService: vi.fn(async () => true),
      getDashboardServices: vi.fn(() => [
        {
          id: "service-1",
          status: "running",
          pendingAction: "creating",
          pid: 1234,
          foregroundCommand: "zsh",
        },
      ]),
      getDashboardSessions: vi.fn(() => []),
    };

    dashboardViewMethods.settleDashboardCreatePending.call(host, "service-1");

    expect(host.dashboardPendingActions.settleCreatePending).toHaveBeenCalledOnce();
    await expect(isSettled?.()).resolves.toBe(true);
  });

  it("does not settle a creating service that is only an optimistic placeholder", async () => {
    let isSettled: (() => Promise<boolean> | boolean) | undefined;
    const host: any = {
      startedInDashboard: true,
      mode: "dashboard",
      dashboardPendingActions: {
        settleCreatePending: vi.fn((_target, _itemId, _onSettled, opts) => {
          isSettled = opts.isSettled;
        }),
      },
      refreshDashboardModelFromService: vi.fn(async () => true),
      getDashboardServices: vi.fn(() => [
        {
          id: "service-1",
          status: "running",
          pendingAction: "creating",
        },
      ]),
      getDashboardSessions: vi.fn(() => []),
    };

    dashboardViewMethods.settleDashboardCreatePending.call(host, "service-1");

    await expect(isSettled?.()).resolves.toBe(false);
  });

  it("does not settle a creating agent from process output before an attach target exists", async () => {
    let isSettled: (() => Promise<boolean> | boolean) | undefined;
    const host: any = {
      startedInDashboard: true,
      mode: "dashboard",
      dashboardPendingActions: {
        settleCreatePending: vi.fn((_target, _itemId, _onSettled, opts) => {
          isSettled = opts.isSettled;
        }),
      },
      refreshDashboardModelFromService: vi.fn(async () => true),
      getDashboardServices: vi.fn(() => []),
      getDashboardSessions: vi.fn(() => [
        {
          id: "codex-1",
          status: "running",
          pendingAction: "creating",
          pid: 1234,
          foregroundCommand: "codex",
          previewLine: "OpenAI Codex update available",
        },
      ]),
    };

    dashboardViewMethods.settleDashboardCreatePending.call(host, "codex-1");

    await expect(isSettled?.()).resolves.toBe(false);
  });

  it("settles a creating agent once an attach target exists", async () => {
    let isSettled: (() => Promise<boolean> | boolean) | undefined;
    const host: any = {
      startedInDashboard: true,
      mode: "dashboard",
      dashboardPendingActions: {
        settleCreatePending: vi.fn((_target, _itemId, _onSettled, opts) => {
          isSettled = opts.isSettled;
        }),
      },
      refreshDashboardModelFromService: vi.fn(async () => true),
      getDashboardServices: vi.fn(() => []),
      getDashboardSessions: vi.fn(() => [
        {
          id: "codex-1",
          status: "running",
          pendingAction: "creating",
          tmuxWindowId: "@12",
        },
      ]),
    };

    dashboardViewMethods.settleDashboardCreatePending.call(host, "codex-1");

    await expect(isSettled?.()).resolves.toBe(true);
  });

  it("settles a creating worktree from the service-rendered worktree group", async () => {
    let isSettled: (() => Promise<boolean> | boolean) | undefined;
    const path = "/repo/.aimux/worktrees/demo";
    const host: any = {
      startedInDashboard: true,
      mode: "dashboard",
      dashboardPendingActions: {
        settleCreatePending: vi.fn((_target, _itemId, _onSettled, opts) => {
          isSettled = opts.isSettled;
        }),
      },
      refreshDashboardModelFromService: vi.fn(async () => true),
      listDesktopWorktrees: vi.fn(),
      dashboardWorktreeGroupsCache: [{ name: "demo", branch: "demo", path }],
      getDashboardServices: vi.fn(() => []),
      getDashboardSessions: vi.fn(() => []),
    };

    dashboardViewMethods.settleDashboardCreatePending.call(host, `worktree:${path}`);

    await expect(isSettled?.()).resolves.toBe(true);
    expect(host.listDesktopWorktrees).not.toHaveBeenCalled();
  });

  it("does not render create settlement callbacks after dashboard exit", async () => {
    let onSettled: (() => void) | undefined;
    let isSettled: (() => Promise<boolean> | boolean) | undefined;
    const host: any = {
      startedInDashboard: true,
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: {
        settleCreatePending: vi.fn((_target, _itemId, settled, opts) => {
          onSettled = settled;
          isSettled = opts.isSettled;
        }),
      },
      refreshDashboardModelFromService: vi.fn(async () => true),
      getDashboardServices: vi.fn(() => []),
      getDashboardSessions: vi.fn(() => []),
      renderDashboard: vi.fn(),
    };

    dashboardViewMethods.settleDashboardCreatePending.call(host, "codex-1", "session");
    host.mode = "session";
    host.dashboardInputEpoch = 1;

    await expect(isSettled?.()).resolves.toBe(true);
    onSettled?.();
    await Promise.resolve();

    expect(host.renderDashboard).not.toHaveBeenCalled();
  });

  it("renders create settlement callbacks after later dashboard input", async () => {
    let onSettled: (() => void) | undefined;
    let isSettled: (() => Promise<boolean> | boolean) | undefined;
    const host: any = {
      startedInDashboard: true,
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: {
        settleCreatePending: vi.fn((_target, _itemId, settled, opts) => {
          onSettled = settled;
          isSettled = opts.isSettled;
        }),
      },
      refreshDashboardModelFromService: vi.fn(async () => true),
      getDashboardServices: vi.fn(() => []),
      getDashboardSessions: vi.fn(() => [{ id: "codex-1", status: "running", tmuxWindowId: "@12" }]),
      isDashboardScreen: vi.fn((screen: string) => screen === "dashboard"),
      renderDashboard: vi.fn(),
    };

    dashboardViewMethods.settleDashboardCreatePending.call(host, "codex-1", "session");
    host.dashboardInputEpoch = 1;

    await expect(isSettled?.()).resolves.toBe(true);
    onSettled?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(host.renderDashboard).toHaveBeenCalledOnce();
  });

  it("does not treat later dashboard input as create settlement", async () => {
    let isSettled: (() => Promise<boolean> | boolean) | undefined;
    const host: any = {
      startedInDashboard: true,
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardPendingActions: {
        settleCreatePending: vi.fn((_target, _itemId, _onSettled, opts) => {
          isSettled = opts.isSettled;
        }),
      },
      refreshDashboardModelFromService: vi.fn(async () => true),
      getDashboardServices: vi.fn(() => []),
      getDashboardSessions: vi.fn(() => []),
    };

    dashboardViewMethods.settleDashboardCreatePending.call(host, "codex-1", "session");
    host.dashboardInputEpoch = 1;

    await expect(isSettled?.()).resolves.toBe(false);
  });
});

describe("dashboardStateMethods.reconcileDashboardRenderState", () => {
  it("rebuilds nav order, repairs focus, and restores selection before render", () => {
    const host: any = {
      dashboardSessionsCache: [
        {
          id: "live-session",
          worktreePath: "/wt",
          status: "running",
        },
      ],
      dashboardWorktreeGroupsCache: [{ path: "/wt" }],
      dashboardState: {
        worktreeNavOrder: [],
        focusedWorktreePath: "/missing",
        level: "sessions",
        worktreeEntries: [{ kind: "session", id: "stale-offline" }],
        worktreeSessions: [{ id: "stale-offline", worktreePath: "/wt", status: "offline" }],
        sessionIndex: 0,
      },
      dashboardUiStateStore: {
        markSelectionDirty: vi.fn(),
      },
      updateWorktreeSessions: vi.fn(function (this: any) {
        this.dashboardState.worktreeSessions = this.dashboardSessionsCache;
        this.dashboardState.worktreeEntries = [{ kind: "session", id: "live-session" }];
      }),
      restoreDashboardSelectionFromPreference: vi.fn(),
    };

    dashboardStateMethods.reconcileDashboardRenderState.call(host);

    expect(host.dashboardState.worktreeNavOrder).toEqual(["/wt"]);
    expect(host.dashboardState.focusedWorktreePath).toBeUndefined();
    expect(host.dashboardUiStateStore.markSelectionDirty).toHaveBeenCalledTimes(1);
    expect(host.updateWorktreeSessions).toHaveBeenCalledTimes(1);
    expect(host.restoreDashboardSelectionFromPreference).toHaveBeenCalledWith(host.dashboardSessionsCache, true);
  });
});

describe("dashboardStateMethods.writeFrame", () => {
  it("composes the current overlay output into the final dashboard frame", () => {
    const writes: string[] = [];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      writes.push(String(chunk));
      return true;
    });

    const host: any = {
      mode: "dashboard",
      lastRenderedFrame: null,
      lastRenderedBaseFrame: null,
      lastRenderedFrameKey: null,
      getViewportSize: vi.fn(() => ({ cols: 120, rows: 40 })),
      dashboardModelVersion: 3,
      dashboardPendingActions: { getVersion: vi.fn(() => 7) },
      dashboardOverlayState: { version: 2 },
      dashboardState: { renderStateKey: vi.fn(() => "screen:dashboard|level:worktrees") },
      buildActiveDashboardOverlayOutput: vi.fn(() => "overlay-frame"),
    };

    dashboardStateMethods.writeFrame.call(host, "base-frame");

    // The stored base stays raw; the composited frame dims it (faint) behind the overlay.
    expect(host.lastRenderedBaseFrame).toBe("base-frame");
    expect(host.lastRenderedFrame).toBe("\x1b[2;38;5;240mbase-frame\x1b[0moverlay-frame");
    expect(host.lastRenderedFrameKey).toBe("120x40|model:3|pending:7|overlay:2|ui:screen:dashboard|level:worktrees");
    expect(writes).toEqual(["\x1b[?25l\x1b[2J\x1b[H\x1b[2;38;5;240mbase-frame\x1b[0moverlay-frame"]);
    stdoutWrite.mockRestore();
  });
});
