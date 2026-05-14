import { describe, expect, it, vi } from "vitest";

const { postToProjectService } = vi.hoisted(() => ({
  postToProjectService: vi.fn(async () => undefined),
}));

const { addDashboardOperationFailure } = vi.hoisted(() => ({
  addDashboardOperationFailure: vi.fn((input: any) => ({
    id: "failure-1",
    createdAt: "2026-05-01T00:00:00.000Z",
    ...input,
  })),
}));

vi.mock("./dashboard-control.js", () => ({
  postToProjectService,
}));

vi.mock("../worktree.js", () => ({
  getWorktreeCreatePath: (name: string) => `/repo/.aimux/worktrees/${name}`,
  isToolInternalWorktree: (worktree: any) =>
    worktree.name?.startsWith("agent-") && worktree.branch?.startsWith("worktree-agent-"),
  listWorktrees: () => [],
}));

vi.mock("../dashboard/operation-failures.js", () => ({
  addDashboardOperationFailure,
}));

import { beginWorktreeRemoval, handleWorktreeInputKey, handleWorktreeRemoveConfirmKey } from "./worktrees.js";

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
  it("creates a worktree through the project service without installing dashboard-local pending state", async () => {
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

    expect(postToProjectService).toHaveBeenCalledWith(
      host,
      "/worktrees/create",
      { name: "demo" },
      { timeoutMs: 180_000 },
    );
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true);
    expect(host.settleDashboardCreatePending).toHaveBeenCalledWith("worktree:/repo/.aimux/worktrees/demo");
    expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeUndefined();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("keeps failed worktree creates visible as durable dashboard failures", async () => {
    postToProjectService.mockRejectedValueOnce(new Error("branch already exists"));
    addDashboardOperationFailure.mockClear();
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      worktreeInputBuffer: "demo",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      dashboardPendingActions: pending,
      dashboardWorktreeGroupsCache: [],
      dashboardOperationFailuresCache: [],
      dashboardState: { worktreeNavOrder: [], focusedWorktreePath: undefined },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      renderDashboard: vi.fn(),
      refreshDashboardModelFromService: vi.fn(),
      settleDashboardCreatePending: vi.fn(),
      showDashboardError: vi.fn(),
    };

    handleWorktreeInputKey(host, Buffer.from("\r"));

    await vi.waitFor(() => expect(host.showDashboardError).toHaveBeenCalled());

    expect(addDashboardOperationFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: "worktree",
        operation: "create",
        worktreePath: "/repo/.aimux/worktrees/demo",
        message: "branch already exists",
      }),
    );
    expect(host.dashboardWorktreeGroupsCache[0]).toMatchObject({
      name: "demo",
      branch: "(failed)",
      path: "/repo/.aimux/worktrees/demo",
      operationFailure: expect.objectContaining({ message: "branch already exists" }),
    });
    expect(host.dashboardState.focusedWorktreePath).toBe("/repo/.aimux/worktrees/demo");
  });

  it("shows project-service worktree create pending after the async create is accepted", async () => {
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
            branch: "(creating)",
            path: "/repo/.aimux/worktrees/demo",
            sessions: [],
            services: [],
            pending: true,
            pendingAction: "creating",
          },
        ];
        return true;
      }),
      settleDashboardCreatePending: vi.fn(),
      showDashboardError: vi.fn(),
    };

    handleWorktreeInputKey(host, Buffer.from("\r"));
    await vi.waitFor(() => expect(host.settleDashboardCreatePending).toHaveBeenCalled());

    expect(host.dashboardWorktreeGroupsCache[0]).toMatchObject({
      name: "demo",
      pending: true,
      pendingAction: "creating",
    });
    expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeUndefined();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("places an optimistic worktree using dashboard created-at ordering", () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      worktreeInputBuffer: "newer",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      dashboardPendingActions: pending,
      dashboardWorktreeGroupsCache: [
        { name: "Main Checkout", branch: "master", path: undefined, sessions: [], services: [] },
        {
          name: "older",
          branch: "older",
          path: "/repo/.aimux/worktrees/older",
          createdAt: "2026-05-01T00:00:00.000Z",
          sessions: [],
          services: [],
        },
      ],
      dashboardState: { worktreeNavOrder: [], focusedWorktreePath: undefined },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      renderDashboard: vi.fn(),
      settleDashboardCreatePending: vi.fn(),
      showDashboardError: vi.fn(),
    };

    handleWorktreeInputKey(host, Buffer.from("\r"));

    expect(host.dashboardWorktreeGroupsCache.map((group: any) => group.name)).toEqual([
      "Main Checkout",
      "newer",
      "older",
    ]);
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

    await vi.waitFor(() => expect(host.footerFlash).toBe("Graveyarded: demo"));

    expect(postToProjectService).toHaveBeenCalledWith(host, "/worktrees/graveyard", { path }, { timeoutMs: 10_000 });
    expect(pending.state.get(`worktree:${path}`)).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("treats Enter as confirmation for worktree removal", () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    const path = "/repo/.aimux/worktrees/demo";
    const host: any = {
      mode: "dashboard",
      worktreeRemovalJob: null,
      pendingWorktreeRemovals: undefined,
      worktreeRemoveConfirm: { path, name: "demo" },
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
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
    };

    handleWorktreeRemoveConfirmKey(host, Buffer.from("\r"));

    expect(host.clearDashboardOverlay).toHaveBeenCalledOnce();
    expect(host.restoreDashboardAfterOverlayDismiss).not.toHaveBeenCalled();
    expect(postToProjectService).toHaveBeenCalledWith(host, "/worktrees/graveyard", { path }, { timeoutMs: 10_000 });
  });
});
