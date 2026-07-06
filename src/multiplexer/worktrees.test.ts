import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { postToProjectService, worktreeCreatePathForTest } = vi.hoisted(() => ({
  postToProjectService: vi.fn(async () => undefined),
  worktreeCreatePathForTest: { value: "/repo/.aimux/worktrees/demo" },
}));

vi.mock("./dashboard-control.js", () => ({
  postToProjectService,
}));

vi.mock("../worktree.js", () => ({
  getWorktreeCreatePath: (name: string) => worktreeCreatePathForTest.value.replace(/demo$/, name),
  isToolInternalWorktree: (worktree: any) =>
    worktree.name?.startsWith("agent-") && worktree.branch?.startsWith("worktree-agent-"),
  listWorktrees: () => [],
}));

import { beginWorktreeRemoval, handleWorktreeInputKey, handleWorktreeRemoveConfirmKey } from "./worktrees.js";

function createPendingActionsStore() {
  const state = new Map<string, string | null>();
  const seeds = new Map<string, any>();
  const tokens = new Map<string, number>();
  let nextToken = 0;
  return {
    state,
    setWorktreeAction(path: string | undefined, value: string, opts?: { worktreeSeed?: any }) {
      const key = `worktree:${path ?? "__main__"}`;
      const token = ++nextToken;
      state.set(key, value);
      tokens.set(key, token);
      if (opts?.worktreeSeed) seeds.set(key, opts.worktreeSeed);
      return token;
    },
    clearWorktreeAction(path: string | undefined) {
      const key = `worktree:${path ?? "__main__"}`;
      state.set(key, null);
      seeds.delete(key);
      tokens.delete(key);
    },
    clearWorktreeActionIfToken(path: string | undefined, token: number) {
      const key = `worktree:${path ?? "__main__"}`;
      if (tokens.get(key) !== token) return false;
      state.set(key, null);
      seeds.delete(key);
      tokens.delete(key);
      return true;
    },
    getWorktreeAction(path: string | undefined) {
      const value = state.get(`worktree:${path ?? "__main__"}`);
      return value || undefined;
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
  afterEach(() => {
    worktreeCreatePathForTest.value = "/repo/.aimux/worktrees/demo";
  });

  it("creates a worktree through the project service after the rendered model settles", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardModelServiceRefreshedAt: 0,
      worktreeInputBuffer: "demo",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      dashboardPendingActions: pending,
      dashboardWorktreeGroupsCache: [],
      dashboardState: { worktreeNavOrder: [], focusedWorktreePath: undefined },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      renderDashboard: vi.fn(),
      redrawDashboardWithOverlay: vi.fn(),
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
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ lifecycle: expect.objectContaining({ mode: "dashboard", inputEpoch: undefined }) }),
    );
    expect(host.settleDashboardCreatePending).not.toHaveBeenCalled();
    expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("accepts pasted worktree names before submit in the same input chunk", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardModelServiceRefreshedAt: 0,
      worktreeInputBuffer: "",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      dashboardPendingActions: pending,
      dashboardWorktreeGroupsCache: [],
      dashboardState: { worktreeNavOrder: [], focusedWorktreePath: undefined },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      renderDashboard: vi.fn(),
      redrawDashboardWithOverlay: vi.fn(),
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

    handleWorktreeInputKey(host, Buffer.from("demo\r"));

    await vi.waitFor(() => expect(postToProjectService).toHaveBeenCalled());

    expect(postToProjectService).toHaveBeenCalledWith(
      host,
      "/worktrees/create",
      { name: "demo" },
      { timeoutMs: 180_000 },
    );
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

  it("continues worktree create settlement without stale UI after later dashboard input", async () => {
    postToProjectService.mockClear();
    let resolveCreate!: () => void;
    postToProjectService.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const pending = createPendingActionsStore();
    let refreshCount = 0;
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
      refreshDashboardModelFromService: vi.fn(async (_force: boolean, opts?: any) => {
        expect(opts?.lifecycle?.requiresInputEpoch).not.toBe(true);
        refreshCount += 1;
        if (refreshCount === 1) {
          applyRawWorktrees(host, pending, []);
          return true;
        }
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
    host.dashboardState.focusedWorktreePath = "/repo/.aimux/worktrees/other";
    host.dashboardUiStateStore.markSelectionDirty.mockClear();
    host.renderDashboard.mockClear();
    host.dashboardInputEpoch = 1;
    resolveCreate();

    await vi.waitFor(() => expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull());
    expect(host.dashboardWorktreeGroupsCache[0]).toMatchObject({ name: "demo", branch: "demo" });
    expect(host.dashboardState.focusedWorktreePath).toBe("/repo/.aimux/worktrees/other");
    expect(host.dashboardUiStateStore.markSelectionDirty).not.toHaveBeenCalled();
    expect(host.renderDashboard).not.toHaveBeenCalled();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("keeps service-projected failed worktree creates visible", async () => {
    postToProjectService.mockRejectedValueOnce(new Error("branch already exists"));
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
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

  it("does not show stale worktree create failure after later dashboard input", async () => {
    postToProjectService.mockClear();
    let rejectCreate!: (reason?: unknown) => void;
    postToProjectService.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCreate = reject;
        }),
    );
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
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
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));
    await vi.waitFor(() => expect(postToProjectService).toHaveBeenCalledOnce());
    host.renderDashboard.mockClear();
    host.dashboardInputEpoch = 1;
    rejectCreate(new Error("branch already exists"));

    await vi.waitFor(() => expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull());
    expect(host.dashboardWorktreeGroupsCache[0]).toMatchObject({ name: "demo", branch: "(failed)" });
    expect(host.showDashboardError).not.toHaveBeenCalled();
    expect(host.renderDashboard).not.toHaveBeenCalled();
  });

  it("does not let stale worktree create failures clear a newer same-path pending action", async () => {
    postToProjectService.mockClear();
    let rejectCreate!: (reason?: unknown) => void;
    postToProjectService.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCreate = reject;
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
      dashboardOperationFailuresCache: [],
      dashboardState: { worktreeNavOrder: [], focusedWorktreePath: undefined },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      renderDashboard: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async () => true),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));
    await vi.waitFor(() => expect(postToProjectService).toHaveBeenCalledOnce());
    pending.setWorktreeAction("/repo/.aimux/worktrees/demo", "creating");
    rejectCreate(new Error("branch already exists"));

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBe("creating");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("waits for service-projected create failures after overlapping refreshes", async () => {
    postToProjectService.mockResolvedValueOnce(undefined);
    const pending = createPendingActionsStore();
    let refreshCount = 0;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
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
      dashboardInputEpoch: 0,
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
      dashboardInputEpoch: 0,
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

  it("accepts a rendered worktree create when the next forced snapshot is unavailable", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    let refreshCount = 0;
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
        refreshCount += 1;
        if (refreshCount === 1) {
          applyRawWorktrees(host, pending, [
            {
              name: "demo",
              branch: "(creating)",
              path: "/repo/.aimux/worktrees/demo",
              sessions: [],
              services: [],
              pending: true,
              pendingAction: "creating",
            },
          ]);
          return true;
        }
        applyRawWorktrees(host, pending, [
          {
            name: "demo",
            branch: "demo",
            path: "/repo/.aimux/worktrees/demo",
            sessions: [],
            services: [],
          },
        ]);
        return false;
      }),
      settleDashboardCreatePending: vi.fn(),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));

    await vi.waitFor(() => {
      expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull();
    });

    expect(host.dashboardWorktreeGroupsCache[0]).toMatchObject({
      name: "demo",
      branch: "demo",
    });
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("settles worktree create when optimistic and rendered paths canonicalize to the same directory", async () => {
    postToProjectService.mockClear();
    const root = mkdtempSync(join(tmpdir(), "aimux-worktree-paths-"));
    const realRoot = join(root, "real");
    const linkRoot = join(root, "link");
    mkdirSync(join(realRoot, "demo"), { recursive: true });
    symlinkSync(realRoot, linkRoot, "dir");
    worktreeCreatePathForTest.value = join(linkRoot, "demo");
    const renderedPath = join(realRoot, "demo");
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
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
            path: renderedPath,
            sessions: [],
            services: [],
          },
        ]);
        return true;
      }),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    try {
      handleWorktreeInputKey(host, Buffer.from("\r"));

      await vi.waitFor(() => expect(host.dashboardWorktreeGroupsCache[0]?.pending).not.toBe(true));

      expect(host.showDashboardError).not.toHaveBeenCalled();
      expect(pending.state.get(`worktree:${join(linkRoot, "demo")}`)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps project-service worktree creates pending while snapshots are temporarily unreachable", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    let refreshCount = 0;
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
        refreshCount += 1;
        if (refreshCount < 3) {
          applyRawWorktrees(host, pending, []);
          return false;
        }
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
    await vi.waitFor(() => expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull());

    expect(refreshCount).toBeGreaterThanOrEqual(3);
    expect(host.dashboardWorktreeGroupsCache[0]).toMatchObject({ name: "demo", branch: "demo" });
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("moves slow worktree creates into background reconciliation instead of failing", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    let ready = false;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardWorktreeInitialSettleMs: 5,
      dashboardWorktreeStableSettleMs: 0,
      dashboardWorktreeMutationReconcileMaxMs: 5_000,
      worktreeInputBuffer: "demo",
      clearDashboardOverlay: vi.fn(),
      restoreDashboardAfterOverlayDismiss: vi.fn(),
      dashboardPendingActions: pending,
      dashboardWorktreeGroupsCache: [],
      dashboardState: { worktreeNavOrder: [], focusedWorktreePath: undefined },
      dashboardUiStateStore: { markSelectionDirty: vi.fn() },
      renderDashboard: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
      refreshDashboardModelFromService: vi.fn(async () => {
        applyRawWorktrees(
          host,
          pending,
          ready
            ? [
                {
                  name: "demo",
                  branch: "demo",
                  path: "/repo/.aimux/worktrees/demo",
                  sessions: [],
                  services: [],
                },
              ]
            : [],
        );
        return ready;
      }),
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    handleWorktreeInputKey(host, Buffer.from("\r"));
    await vi.waitFor(() => expect(host.footerFlash).toBe("worktree creating is still settling"));

    expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBe("creating");
    expect(host.showDashboardError).not.toHaveBeenCalled();

    ready = true;
    await vi.waitFor(() => expect(pending.state.get("worktree:/repo/.aimux/worktrees/demo")).toBeNull(), {
      timeout: 3000,
    });

    expect(host.dashboardWorktreeGroupsCache[0]).toMatchObject({ name: "demo", branch: "demo" });
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("surfaces async project-service worktree create failures instead of dropping the pending row", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
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

  it("removes a worktree through the project service after the raw group disappears", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    const path = "/repo/.aimux/worktrees/demo";
    const worktree = { name: "demo", branch: "demo", path, sessions: [], services: [] };
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      worktreeRemovalJob: null,
      pendingWorktreeRemovals: new Map([[path, Promise.resolve({ path, status: "removed" })]]),
      dashboardPendingActions: pending,
      dashboardRawWorktreeGroupsCache: [worktree],
      dashboardWorktreeGroupsCache: [worktree],
      dashboardState: { worktreeNavOrder: [path], focusedWorktreePath: path },
      refreshLocalDashboardModel: vi.fn(),
      refreshDashboardModelFromService: vi.fn(async (_force: boolean, opts?: any) => {
        expect(opts?.lifecycle?.requiresInputEpoch).not.toBe(true);
        applyRawWorktrees(host, pending, []);
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

  it("keeps waiting for worktree removal when an API refresh reports an unchanged snapshot", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    const path = "/repo/.aimux/worktrees/demo";
    const worktree = { name: "demo", branch: "demo", path, sessions: [], services: [] };
    const holder: { host?: any } = {};
    let resolveSecondRefresh!: () => void;
    const secondRefresh = new Promise<boolean>((resolve) => {
      resolveSecondRefresh = () => {
        applyRawWorktrees(holder.host, pending, []);
        resolve(true);
      };
    });
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      worktreeRemovalJob: null,
      dashboardPendingActions: pending,
      dashboardRawWorktreeGroupsCache: [worktree],
      dashboardWorktreeGroupsCache: [worktree],
      dashboardState: { worktreeNavOrder: [path], focusedWorktreePath: path },
      refreshLocalDashboardModel: vi.fn(),
      refreshDashboardModelFromService: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockImplementation(() => secondRefresh),
      renderDashboard: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
      showDashboardError: vi.fn(),
    };
    holder.host = host;
    attachPendingReapply(host, pending);

    beginWorktreeRemoval(host, path, "demo", 0);

    await vi.waitFor(() => expect(host.refreshDashboardModelFromService).toHaveBeenCalledOnce());
    expect(host.footerFlash).toBe("");
    expect(host.worktreeRemovalJob).toEqual(expect.objectContaining({ path, name: "demo" }));

    await vi.waitFor(() => expect(host.refreshDashboardModelFromService).toHaveBeenCalledTimes(2));
    resolveSecondRefresh();

    await vi.waitFor(() => expect(host.footerFlash).toBe("Graveyarded: demo"));

    expect(host.refreshDashboardModelFromService).toHaveBeenCalled();
    expect(postToProjectService).toHaveBeenCalledWith(host, "/worktrees/graveyard", { path }, { timeoutMs: 180_000 });
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
    expect(host.footerFlash).toBe("Graveyarded: demo");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("ignores stale background worktree removal settlement after a newer same-path pending action", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    const path = "/repo/.aimux/worktrees/demo";
    const worktree = { name: "demo", branch: "demo", path, sessions: [], services: [] };
    let refreshCount = 0;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardWorktreeInitialSettleMs: 5,
      dashboardWorktreeStableSettleMs: 0,
      dashboardWorktreeMutationReconcileMaxMs: 5_000,
      worktreeRemovalJob: null,
      dashboardPendingActions: pending,
      dashboardRawWorktreeGroupsCache: [worktree],
      dashboardWorktreeGroupsCache: [worktree],
      dashboardState: { worktreeNavOrder: [path], focusedWorktreePath: path },
      refreshDashboardModelFromService: vi.fn(async (_force: boolean, opts?: any) => {
        expect(opts?.allowInactive).toBe(true);
        refreshCount += 1;
        if (refreshCount < 3) {
          applyRawWorktrees(host, pending, [worktree]);
          return true;
        }
        applyRawWorktrees(host, pending, []);
        return true;
      }),
      renderDashboard: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    beginWorktreeRemoval(host, path, "demo", 0);
    await vi.waitFor(() => expect(host.footerFlash).toBe("worktree graveyarding is still settling"));
    pending.setWorktreeAction(path, "graveyarding");

    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(pending.state.get(`worktree:${path}`)).toBe("graveyarding");
    expect(host.footerFlash).toBe("worktree graveyarding is still settling");
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("clears stale background worktree removal jobs without rendering stale success", async () => {
    postToProjectService.mockClear();
    const pending = createPendingActionsStore();
    const path = "/repo/.aimux/worktrees/demo";
    const worktree = { name: "demo", branch: "demo", path, sessions: [], services: [] };
    let refreshCount = 0;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      dashboardWorktreeInitialSettleMs: 5,
      dashboardWorktreeStableSettleMs: 0,
      dashboardWorktreeMutationReconcileMaxMs: 5_000,
      worktreeRemovalJob: null,
      dashboardPendingActions: pending,
      dashboardRawWorktreeGroupsCache: [worktree],
      dashboardWorktreeGroupsCache: [worktree],
      dashboardState: { worktreeNavOrder: [path], focusedWorktreePath: path },
      refreshDashboardModelFromService: vi.fn(async () => {
        refreshCount += 1;
        if (refreshCount < 3) {
          applyRawWorktrees(host, pending, [worktree]);
          return true;
        }
        applyRawWorktrees(host, pending, []);
        return true;
      }),
      renderDashboard: vi.fn(),
      footerFlash: "",
      footerFlashTicks: 0,
      showDashboardError: vi.fn(),
    };
    attachPendingReapply(host, pending);

    beginWorktreeRemoval(host, path, "demo", 0);
    await vi.waitFor(() => expect(host.footerFlash).toBe("worktree graveyarding is still settling"));
    host.mode = "session";

    await vi.waitFor(() => expect(host.worktreeRemovalJob).toBeNull(), { timeout: 3000 });
    expect(pending.state.get(`worktree:${path}`)).toBe("graveyarding");

    await vi.waitFor(() => expect(pending.state.get(`worktree:${path}`)).toBeNull(), { timeout: 3000 });
    expect(host.footerFlash).toBe("worktree graveyarding is still settling");
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
