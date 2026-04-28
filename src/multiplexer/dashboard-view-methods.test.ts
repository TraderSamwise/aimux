import { describe, expect, it, vi } from "vitest";

import { dashboardViewMethods } from "./dashboard-view-methods.js";

describe("dashboardViewMethods.renderDashboard", () => {
  it("rebuilds focused worktree entries from the latest caches before rendering", () => {
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
        worktreeNavOrder: [],
        focusedWorktreePath: "/wt",
        level: "sessions",
        worktreeEntries: [{ kind: "session", id: "stale-offline" }],
        worktreeSessions: [{ id: "stale-offline", worktreePath: "/wt", status: "offline" }],
        sessionIndex: 0,
      },
      dashboardUiStateStore: {
        markSelectionDirty: vi.fn(),
      },
      restoreDashboardSelectionFromPreference: vi.fn(),
      updateWorktreeSessions: vi.fn(function (this: any) {
        this.dashboardState.worktreeSessions = this.dashboardSessionsCache;
        this.dashboardState.worktreeEntries = [{ kind: "session", id: "live-session" }];
      }),
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

    expect(host.updateWorktreeSessions).toHaveBeenCalledTimes(1);
    expect(dashboardUpdate).toHaveBeenCalledWith(
      host.dashboardSessionsCache,
      host.dashboardServicesCache,
      host.dashboardWorktreeGroupsCache,
      "/wt",
      "sessions",
      "live-session",
      undefined,
      "tmux",
      host.dashboardMainCheckoutInfoCache,
      undefined,
    );
  });
});
