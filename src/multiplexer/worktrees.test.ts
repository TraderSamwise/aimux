import { describe, expect, it, vi } from "vitest";

const { postToProjectService } = vi.hoisted(() => ({
  postToProjectService: vi.fn(async () => undefined),
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

import { beginWorktreeRemoval, handleWorktreeInputKey, handleWorktreeRemoveConfirmKey } from "./worktrees.js";

function createPendingActionsStore() {
  const state = new Map<string, string | null>();
  const seeds = new Map<string, any>();
  return {
    state,
    setWorktreeAction(path: string | undefined, value: string, opts?: { worktreeSeed?: any }) {
      const key = `worktree:${path ?? "__main__"}`;
      state.set(key, value);
      if (opts?.worktreeSeed) seeds.set(key, opts.worktreeSeed);
    },
    clearWorktreeAction(path: string | undefined) {
      const key = `worktree:${path ?? "__main__"}`;
      state.set(key, null);
      seeds.delete(key);
    },
    applyToWorktrees(worktrees: any[]) {
      const seen = new Set(worktrees.map((worktree) => `worktree:${worktree.path ?? "__main__"}`));
      const applied = worktrees.map((worktree) => {
        const value = state.get(`worktree:${worktree.path ?? "__main__"}`);
        if (!value) return worktree;
        return { ...worktree, pending: true, pendingAction: value, optimistic: true };
      });
      for (const [key, seed] of seeds) {
        const value = state.get(key);
        if (!value || seen.has(key)) continue;
        applied.push({ ...seed, pending: true, pendingAction: value, optimistic: true });
      }
      applied.sort((a, b) => {
        if (a.path === undefined) return -1;
        if (b.path === undefined) return 1;
        return Date.parse(b.createdAt ?? "0") - Date.parse(a.createdAt ?? "0");
      });
      return applied;
    },
  };
}

function attachPendingReapply(host: any, pending: ReturnType<typeof createPendingActionsStore>): void {
  host.reapplyDashboardPendingActions = vi.fn(() => {
    const rawWorktrees = host.dashboardRawWorktreeGroupsCache ?? host.dashboardWorktreeGroupsCache;
    host.dashboardWorktreeGroupsCache = pending.applyToWorktrees(rawWorktrees);
    host.dashboardState.worktreeNavOrder = host.dashboardWorktreeGroupsCache.map((group: any) => group.path);
  });
}

function applyRawWorktrees(host: any, pending: ReturnType<typeof createPendingActionsStore>, worktrees: any[]): void {
  host.dashboardRawWorktreeGroupsCache = worktrees;
  host.dashboardWorktreeGroupsCache = pending.applyToWorktrees(worktrees);
  host.dashboardState.worktreeNavOrder = host.dashboardWorktreeGroupsCache.map((group: any) => group.path);
}

describe("worktrees dashboard mutation protocol", () => {
  it("creates a worktree through the project service after the rendered model settles", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      dashboardModelServiceRefreshedAt: 0,
      worktreeInputBuffer: "demo",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      dashboardPendingActions: pending,
      dashboardWorktreeGroupsCache: [],
      dashboardState: { worktreeNavOrder: [], focusedWorktreePath: undefined },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      renderDashboard: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async () => {
        applyRawWorktrees(host, pending, [
          {
            name: "demo",
            branch: "demo",
            path: "/repo/.aimux/worktrees/demo",
            sessions: [],
            services: [],
          },
        ]);
        return true;
      }),
      settleDashboardCreatePending: vi.fn(),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));

    await vi.waitFor(() => expect(host.dashboardWorktreeGroupsCache[0]?.pending).not.toBe(true));

    expect(postToProjectService).toHaveBeenCalledWith(
      host,
      "/worktrees/create",
      { name: "demo" },
      { timeoutMs: 180_000 },
    );
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true);
    expect(host.settleDashboardCreatePending).not.toHaveBeenCalled();
    expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("clears pending create state without stale UI after leaving the dashboard", async () => {
    postToProjectService.mockClear();
    let resolveCreate!: () => void;
    postToProjectService.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      worktreeInputBuffer: "demo",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      dashboardPendingActions: pending,
      dashboardWorktreeGroupsCache: [],
      dashboardState: { worktreeNavOrder: [], focusedWorktreePath: undefined },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      renderDashboard: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async () => {
        applyRawWorktrees(host, pending, [
          {
            name: "demo",
            branch: "demo",
            path: "/repo/.aimux/worktrees/demo",
            sessions: [],
            services: [],
          },
        ]);
        return true;
      }),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));
    await vi.waitFor(() => expect(postToProjectService).toHaveBeenCalledOnce());
    host.mode = "session";
    host.dashboardInputEpoch = 1;
    resolveCreate();

    await vi.waitFor(() => expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull());
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("continues worktree create settlement after later dashboard input", async () => {
    postToProjectService.mockClear();
    let resolveCreate!: () => void;
    postToProjectService.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      worktreeInputBuffer: "demo",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      dashboardPendingActions: pending,
      dashboardWorktreeGroupsCache: [],
      dashboardState: { worktreeNavOrder: [], focusedWorktreePath: undefined },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      renderDashboard: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async () => {
        applyRawWorktrees(host, pending, [
          {
            name: "demo",
            branch: "demo",
            path: "/repo/.aimux/worktrees/demo",
            sessions: [],
            services: [],
          },
        ]);
        return true;
      }),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));
    await vi.waitFor(() => expect(postToProjectService).toHaveBeenCalledOnce());
    host.dashboardInputEpoch = 1;
    resolveCreate();

    await vi.waitFor(() => expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull());
    expect(host.dashboardWorktreeGroupsCache[0]).toMatchObject({ name: "demo", branch: "demo" });
    expect(host.dashboardState.focusedWorktreePath).toBe("/repo/.aimux/worktrees/demo");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("keeps service-projected failed worktree creates visible", async () => {
    postToProjectService.mockRejectedValueOnce(new Error("branch already exists"));
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      dashboardModelServiceRefreshedAt: 0,
      worktreeInputBuffer: "demo",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      dashboardPendingActions: pending,
      dashboardWorktreeGroupsCache: [],
      dashboardOperationFailuresCache: [],
      dashboardState: { worktreeNavOrder: [], focusedWorktreePath: undefined },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      renderDashboard: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async () => {
        applyRawWorktrees(host, pending, [
          {
            name: "demo",
            branch: "(failed)",
            path: "/repo/.aimux/worktrees/demo",
            sessions: [],
            services: [],
            operationFailure: {
              targetKind: "worktree",
              operation: "create",
              message: "branch already exists",
              worktreePath: "/repo/.aimux/worktrees/demo",
            },
          },
        ]);
        return true;
      }),
      settleDashboardCreatePending: vi.fn(),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));

    await vi.waitFor(() => expect(host.showDashboardError).toHaveBeenCalled(), { timeout: 2000 });

    expect(host.dashboardWorktreeGroupsCache[0]).toMatchObject({
      name: "demo",
      branch: "(failed)",
      path: "/repo/.aimux/worktrees/demo",
      operationFailure: expect.objectContaining({ message: "branch already exists" }),
    });
    expect(host.dashboardState.focusedWorktreePath).toBe("/repo/.aimux/worktrees/demo");
  });

  it("waits for service-projected create failures after overlapping refreshes", async () => {
    postToProjectService.mockResolvedValueOnce(undefined);
    const pending = createPendingActionsStore();
    let refreshCount = 0;
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
      refreshDashboardModelFromService: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount === 1) {
          host.dashboardModelServiceRefreshedAt += 1;
          return false;
        }
        applyRawWorktrees(host, pending, [
          {
            name: "demo",
            branch: "(failed)",
            path: "/repo/.aimux/worktrees/demo",
            sessions: [],
            services: [],
            operationFailure: {
              targetKind: "worktree",
              operation: "create",
              message: "branch already exists",
              worktreePath: "/repo/.aimux/worktrees/demo",
            },
          },
        ]);
        return true;
      }),
      settleDashboardCreatePending: vi.fn(),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));

    await vi.waitFor(() => expect(host.showDashboardError).toHaveBeenCalled(), { timeout: 2000 });

    expect(host.refreshDashboardModelFromService).toHaveBeenCalled();
    expect(host.dashboardWorktreeGroupsCache[0]).toMatchObject({
      name: "demo",
      branch: "(failed)",
      operationFailure: expect.objectContaining({ message: "branch already exists" }),
    });
    expect(host.dashboardState.focusedWorktreePath).toBe("/repo/.aimux/worktrees/demo");
  });

  it("keeps immediate unprojected worktree create errors transient", async () => {
    postToProjectService.mockRejectedValueOnce(new Error("branch already exists"));
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      dashboardModelServiceRefreshError: new Error("offline"),
      worktreeInputBuffer: "demo",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      dashboardPendingActions: pending,
      dashboardWorktreeGroupsCache: [],
      dashboardOperationFailuresCache: [],
      dashboardState: { worktreeNavOrder: [], focusedWorktreePath: undefined },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      renderDashboard: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async () => true),
      settleDashboardCreatePending: vi.fn(),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));

    await vi.waitFor(() => expect(host.showDashboardError).toHaveBeenCalled(), { timeout: 2000 });

    expect(host.dashboardWorktreeGroupsCache).toEqual([]);
    expect(host.dashboardOperationFailuresCache).toEqual([]);
    expect(host.dashboardState.focusedWorktreePath).toBeUndefined();
    expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull();
  });

  it("preserves an existing worktree row after duplicate create errors", async () => {
    postToProjectService.mockRejectedValueOnce(new Error('Worktree "demo" already exists'));
    const pending = createPendingActionsStore();
    const existingWorktree = {
      name: "demo",
      branch: "demo",
      path: "/repo/.aimux/worktrees/demo",
      sessions: [],
      services: [],
    };
    const host: any = {
      mode: "dashboard",
      worktreeInputBuffer: "demo",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      dashboardPendingActions: pending,
      dashboardRawWorktreeGroupsCache: [existingWorktree],
      dashboardWorktreeGroupsCache: [existingWorktree],
      dashboardOperationFailuresCache: [],
      dashboardState: { worktreeNavOrder: [existingWorktree.path], focusedWorktreePath: existingWorktree.path },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      renderDashboard: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async () => {
        applyRawWorktrees(host, pending, [existingWorktree]);
        return true;
      }),
      settleDashboardCreatePending: vi.fn(),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));

    await vi.waitFor(() => expect(host.showDashboardError).toHaveBeenCalled(), { timeout: 2000 });

    expect(host.dashboardWorktreeGroupsCache).toEqual([existingWorktree]);
    expect(host.dashboardState.focusedWorktreePath).toBe(existingWorktree.path);
    expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull();
  });

  it("keeps project-service worktree creates pending until the worktree is rendered as real", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    let refreshCount = 0;
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
        refreshCount += 1;
        applyRawWorktrees(host, pending, [
          {
            name: "demo",
            branch: refreshCount < 2 ? "(creating)" : "demo",
            path: "/repo/.aimux/worktrees/demo",
            sessions: [],
            services: [],
            ...(refreshCount < 2 ? { pending: true, pendingAction: "creating" } : {}),
          },
        ]);
        return true;
      }),
      settleDashboardCreatePending: vi.fn(),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));
    await vi.waitFor(() => {
      expect(host.dashboardWorktreeGroupsCache[0]?.branch).toBe("demo");
      expect(host.dashboardWorktreeGroupsCache[0]?.pending).not.toBe(true);
    });

    expect(host.dashboardWorktreeGroupsCache[0]).toMatchObject({
      name: "demo",
      branch: "demo",
    });
    expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("clears project-service worktree create pending when the service snapshot is unreachable", async () => {
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
      refreshDashboardModelFromService: vi.fn(async () => false),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));
    await vi.waitFor(() => expect(host.showDashboardError).toHaveBeenCalled());

    expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull();
    expect(host.showDashboardError).toHaveBeenCalledWith('Failed to create "demo"', [
      "Path: /repo/.aimux/worktrees/demo",
      "Error: project service snapshot unavailable",
    ]);
  });

  it("surfaces async project-service worktree create failures instead of dropping the pending row", async () => {
    postToProjectService.mockClear();
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
      refreshDashboardModelFromService: vi.fn(async () => {
        applyRawWorktrees(host, pending, [
          {
            name: "demo",
            branch: "(failed)",
            path: "/repo/.aimux/worktrees/demo",
            sessions: [],
            services: [],
            operationFailure: {
              targetKind: "worktree",
              operation: "create",
              message: "branch already exists",
              worktreePath: "/repo/.aimux/worktrees/demo",
            },
          },
        ]);
        return true;
      }),
      settleDashboardCreatePending: vi.fn(),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));

    await vi.waitFor(() => expect(host.showDashboardError).toHaveBeenCalled());

    expect(host.dashboardWorktreeGroupsCache[0]).toMatchObject({
      name: "demo",
      branch: "(failed)",
      operationFailure: expect.objectContaining({ message: "branch already exists" }),
    });
    expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull();
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
      refreshDashboardModelFromService: vi.fn(async () => {
        applyRawWorktrees(host, pending, [
          {
            name: "newer",
            branch: "newer",
            path: "/repo/.aimux/worktrees/newer",
            sessions: [],
            services: [],
          },
        ]);
        return true;
      }),
      settleDashboardCreatePending: vi.fn(),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

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
      pendingWorktreeRemovals: new Map([[path, Promise.resolve({ path, status: "removed" })]]),
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
    attachPendingReapply(host, pending);

    beginWorktreeRemoval(host, path, "demo", 0);

    await vi.waitFor(() => expect(host.footerFlash).toBe("Graveyarded: demo"));

    expect(postToProjectService).toHaveBeenCalledWith(host, "/worktrees/graveyard", { path }, { timeoutMs: 180_000 });
    expect(host.reapplyDashboardPendingActions).toHaveBeenCalled();
    expect(pending.state.get(`worktree:${path}`)).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("continues worktree removal settlement after later dashboard input", async () => {
    postToProjectService.mockClear();
    let resolveRemove!: () => void;
    postToProjectService.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRemove = resolve;
        }),
    );
    const pending = createPendingActionsStore();
    const path = "/repo/.aimux/worktrees/demo";
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      worktreeRemovalJob: null,
      dashboardPendingActions: pending,
      dashboardWorktreeGroupsCache: [{ name: "demo", branch: "demo", path, sessions: [], services: [] }],
      dashboardState: { worktreeNavOrder: [path], focusedWorktreePath: path },
      refreshDashboardModelFromService: vi.fn(async () => {
        host.dashboardWorktreeGroupsCache = [];
        return true;
      }),
      renderDashboard: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    beginWorktreeRemoval(host, path, "demo", 0);
    await vi.waitFor(() => expect(postToProjectService).toHaveBeenCalledOnce());
    host.dashboardInputEpoch = 1;
    resolveRemove();

    await vi.waitFor(() => expect(pending.state.get(`worktree:${path}`)).toBeNull());
    expect(host.refreshDashboardModelFromService).toHaveBeenCalled();
    expect(host.footerFlash).toBe("");
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
    attachPendingReapply(host, pending);

    handleWorktreeRemoveConfirmKey(host, Buffer.from("\r"));

    expect(host.clearDashboardOverlay).toHaveBeenCalledOnce();
    expect(host.restoreDashboardAfterOverlayDismiss).not.toHaveBeenCalled();
    expect(postToProjectService).toHaveBeenCalledWith(host, "/worktrees/graveyard", { path }, { timeoutMs: 180_000 });
  });
});
