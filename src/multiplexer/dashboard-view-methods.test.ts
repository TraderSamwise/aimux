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
      getViewportKey: vi.fn(() => "120x40"),
      dashboardModelVersion: 3,
      dashboardPendingActions: { getVersion: vi.fn(() => 7) },
      dashboardOverlayState: { version: 2 },
      dashboardState: { renderStateKey: vi.fn(() => "screen:dashboard|level:worktrees") },
      buildActiveDashboardOverlayOutput: vi.fn(() => "overlay-frame"),
    };

    dashboardStateMethods.writeFrame.call(host, "base-frame");

    expect(host.lastRenderedBaseFrame).toBe("base-frame");
    expect(host.lastRenderedFrame).toBe("base-frameoverlay-frame");
    expect(host.lastRenderedFrameKey).toBe("120x40|model:3|pending:7|overlay:2|ui:screen:dashboard|level:worktrees");
    expect(writes).toEqual(["\x1b[H\x1b[Jbase-frameoverlay-frame"]);
    stdoutWrite.mockRestore();
  });
});
