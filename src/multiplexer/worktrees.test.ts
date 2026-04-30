import { describe, expect, it, vi } from "vitest";

const { postToProjectService } = vi.hoisted(() => ({
  postToProjectService: vi.fn(async () => undefined),
}));

vi.mock("./dashboard-control.js", () => ({
  postToProjectService,
}));

vi.mock("../worktree.js", () => ({
  getWorktreeCreatePath: (name: string) => `/repo/.aimux/worktrees/${name}`,
  listWorktrees: () => [],
}));

import { beginWorktreeRemoval, handleWorktreeInputKey } from "./worktrees.js";

function createPendingActionsStore() {
  const state = new Map<string, string | null>();
  return {
    state,
    set(key: string, value: string | null) {
      state.set(key, value);
    },
  };
}

describe("worktrees dashboard mutation protocol", () => {
  it("creates a worktree through the project service and settles pending state after the rendered group appears", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      worktreeInputBuffer: "demo",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      dashboardPendingActions: pending,
      dashboardWorktreeGroupsCache: [],
      dashboardState: { worktreeNavOrder: [], focusedWorktreePath: undefined },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      renderDashboard: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async () => {
        host.dashboardWorktreeGroupsCache = [
          {
            name: "demo",
            branch: "demo",
            path: "/repo/.aimux/worktrees/demo",
            sessions: [],
            services: [],
          },
        ];
        return true;
      }),
      settleDashboardCreatePending: vi.fn(),
      showDashboardError: vi.fn(),
    };

    handleWorktreeInputKey(host, Buffer.from("\r"));

    await vi.waitFor(() => expect(host.settleDashboardCreatePending).toHaveBeenCalled());

    expect(postToProjectService).toHaveBeenCalledWith(host, "/worktrees/create", { name: "demo" });
    expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("removes a worktree through the project service and settles after the rendered group disappears", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    const path = "/repo/.aimux/worktrees/demo";
    const host: any = {
      mode: "dashboard",
      worktreeRemovalJob: null,
      pendingWorktreeRemovals: undefined,
      dashboardPendingActions: pending,
      dashboardWorktreeGroupsCache: [{ name: "demo", branch: "demo", path, sessions: [], services: [] }],
      dashboardState: { worktreeNavOrder: [path], focusedWorktreePath: path },
      refreshLocalDashboardModel: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async () => {
        host.dashboardWorktreeGroupsCache = [];
        return true;
      }),
      renderDashboard: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
      showDashboardError: vi.fn(),
    };

    beginWorktreeRemoval(host, path, "demo", 0);

    await vi.waitFor(() => expect(host.footerFlash).toBe("Removed: demo"));

    expect(postToProjectService).toHaveBeenCalledWith(host, "/worktrees/remove", { path });
    expect(pending.state.get(`worktree:${path}`)).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });
});
