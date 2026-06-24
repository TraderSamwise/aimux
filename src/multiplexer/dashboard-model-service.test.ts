import { describe, expect, it, vi } from "vitest";

import { DashboardPendingActions } from "../dashboard/pending-actions.js";
import { refreshDashboardModelFromService } from "./dashboard-model.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function hostDouble(): any {
  return {
    mode: "dashboard",
    dashboardModelRefreshedAt: 0,
    getFromProjectService: vi.fn(),
    refreshRuntimeGuard: vi.fn(),
    dashboardPendingActions: new DashboardPendingActions(() => {}),
    dashboardUiStateStore: {
      orderWorktreeGroups: vi.fn((groups) => groups),
      markSelectionDirty: vi.fn(),
    },
    tmuxRuntimeManager: {
      listProjectManagedWindows: vi.fn(() => []),
      isWindowAlive: vi.fn(() => true),
    },
  };
}

describe("refreshDashboardModelFromService", () => {
  function desktopPayload(sessionId: string) {
    const session = {
      index: 0,
      id: sessionId,
      command: "claude",
      status: "running",
      active: false,
    };
    return {
      ok: true,
      sessions: [session],
      teammates: [],
      services: [],
      worktrees: [],
      worktreeGroups: [
        {
          name: "Main Checkout",
          branch: "main",
          path: undefined,
          status: "active",
          sessions: [session],
          services: [],
        },
      ],
      operationFailures: [],
      mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
    };
  }

  it("applies dashboard worktree groups provided by /desktop-state", async () => {
    const host = hostDouble();
    const session = {
      index: 0,
      id: "claude-1",
      command: "claude",
      status: "running",
      active: false,
    };
    const serviceGroup = {
      name: "Main Checkout",
      branch: "main",
      path: undefined,
      status: "active",
      sessions: [session],
      services: [],
    };
    host.getFromProjectService.mockResolvedValueOnce({
      ok: true,
      sessions: [session],
      teammates: [],
      services: [],
      worktrees: [{ name: "stale-local-shape", path: "/wrong", branch: "wrong", isBare: false }],
      worktreeGroups: [serviceGroup],
      operationFailures: [],
      mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
    });

    await expect(refreshDashboardModelFromService(host, true)).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledWith("/desktop-state", { timeoutMs: 5000 });
    expect(host.dashboardSessionsCache).toEqual([session]);
    expect(host.dashboardWorktreeGroupsCache).toEqual([
      expect.objectContaining({ name: "Main Checkout", branch: "main", sessions: [session] }),
    ]);
    expect(host.dashboardModelServiceRefreshedAt).toBeGreaterThan(0);
    expect(host.dashboardModelServiceRefreshError).toBeUndefined();
    expect(host.refreshRuntimeGuard).not.toHaveBeenCalled();
  });

  it("probes the runtime guard after a successful refresh only when currently guarded", async () => {
    const host = hostDouble();
    host.runtimeGuardState = { kind: "stale", reason: "service-mismatch" };
    host.getFromProjectService.mockResolvedValueOnce(desktopPayload("fresh"));

    await expect(refreshDashboardModelFromService(host, true)).resolves.toBe(true);

    await vi.waitFor(() => expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(1));
  });

  it("lets forced refreshes supersede an older pending background refresh", async () => {
    const host = hostDouble();
    const background = deferred<any>();
    const forced = deferred<any>();
    host.getFromProjectService.mockReturnValueOnce(background.promise).mockReturnValueOnce(forced.promise);

    const backgroundRefresh = refreshDashboardModelFromService(host, false);
    const forcedRefresh = refreshDashboardModelFromService(host, true);

    forced.resolve(desktopPayload("fresh"));
    await expect(forcedRefresh).resolves.toBe(true);
    background.resolve(desktopPayload("stale"));
    await expect(backgroundRefresh).resolves.toBe(false);

    expect(host.getFromProjectService).toHaveBeenCalledTimes(2);
    expect(host.dashboardSessionsCache.map((session: any) => session.id)).toEqual(["fresh"]);
    expect(host.dashboardModelServiceRefreshError).toBeUndefined();
    expect(host.refreshRuntimeGuard).not.toHaveBeenCalled();
  });

  it("does not apply desktop-state when the refresh lifecycle is stale", async () => {
    const host = hostDouble();
    host.dashboardInputEpoch = 1;
    host.getFromProjectService.mockResolvedValueOnce(desktopPayload("stale"));

    await expect(
      refreshDashboardModelFromService(host, true, {
        lifecycle: { mode: "dashboard", inputEpoch: 0, requiresInputEpoch: true },
      }),
    ).resolves.toBe(false);

    expect(host.dashboardSessionsCache).toBeUndefined();
    expect(host.dashboardModelServiceRefreshedAt).toBeUndefined();
    expect(host.refreshRuntimeGuard).not.toHaveBeenCalled();
  });

  it("does not report stale invalid desktop-state refreshes", async () => {
    const host = hostDouble();
    host.dashboardInputEpoch = 1;
    host.getFromProjectService.mockResolvedValueOnce({
      ok: true,
      sessions: [],
      teammates: [],
      services: [],
      worktrees: [],
      mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
    });

    await expect(
      refreshDashboardModelFromService(host, true, {
        lifecycle: { mode: "dashboard", inputEpoch: 0, requiresInputEpoch: true },
      }),
    ).resolves.toBe(false);

    expect(host.dashboardSessionsCache).toBeUndefined();
    expect(host.dashboardModelServiceRefreshError).toBeUndefined();
    expect(host.refreshRuntimeGuard).not.toHaveBeenCalled();
  });

  it("rejects desktop-state payloads without service-composed worktree groups", async () => {
    const host = hostDouble();
    host.getFromProjectService.mockResolvedValueOnce({
      ok: true,
      sessions: [],
      teammates: [],
      services: [],
      worktrees: [],
      mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
    });

    await expect(refreshDashboardModelFromService(host, false)).resolves.toBe(false);

    expect(host.getFromProjectService).toHaveBeenCalledWith("/desktop-state", { timeoutMs: 3000 });
    expect(host.dashboardSessionsCache).toBeUndefined();
    expect(host.dashboardWorktreeGroupsCache).toBeUndefined();
    expect(host.dashboardModelServiceRefreshError).toBeInstanceOf(Error);
    expect(host.refreshRuntimeGuard).not.toHaveBeenCalled();
  });

  it("probes the runtime guard when a forced refresh receives an invalid payload", async () => {
    const host = hostDouble();
    host.getFromProjectService.mockResolvedValueOnce({
      ok: true,
      sessions: [],
      teammates: [],
      services: [],
      worktrees: [],
      mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
    });

    await expect(refreshDashboardModelFromService(host, true)).resolves.toBe(false);

    expect(host.getFromProjectService).toHaveBeenCalledWith("/desktop-state", { timeoutMs: 5000 });
    expect(host.dashboardSessionsCache).toBeUndefined();
    expect(host.dashboardWorktreeGroupsCache).toBeUndefined();
    await vi.waitFor(() => expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(1));
  });

  it("does not apply an empty desktop-state snapshot while tmux still has live agents", async () => {
    const host = hostDouble();
    host.tmuxRuntimeManager.listProjectManagedWindows.mockReturnValueOnce([
      {
        target: { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "codex" },
        metadata: { kind: "agent", sessionId: "codex-1" },
      },
    ]);
    host.getFromProjectService.mockResolvedValueOnce({
      ok: true,
      sessions: [],
      teammates: [],
      services: [],
      worktrees: [],
      worktreeGroups: [
        {
          name: "Main Checkout",
          branch: "main",
          path: undefined,
          status: "offline",
          sessions: [],
          services: [],
        },
      ],
      operationFailures: [],
      mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
    });

    await expect(refreshDashboardModelFromService(host, true)).resolves.toBe(false);

    expect(host.dashboardSessionsCache).toBeUndefined();
    expect(host.dashboardWorktreeGroupsCache).toBeUndefined();
    expect(host.dashboardModelServiceRefreshError).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(1));
  });

  it("does not reject an empty desktop-state snapshot for dead tmux agent panes", async () => {
    const host = hostDouble();
    host.tmuxRuntimeManager.isWindowAlive.mockReturnValue(false);
    host.tmuxRuntimeManager.listProjectManagedWindows.mockReturnValueOnce([
      {
        target: { sessionName: "aimux-repo", windowId: "@1", windowIndex: 1, windowName: "codex" },
        metadata: { kind: "agent", sessionId: "codex-1" },
      },
    ]);
    host.getFromProjectService.mockResolvedValueOnce({
      ok: true,
      sessions: [],
      teammates: [],
      services: [],
      worktrees: [],
      worktreeGroups: [
        {
          name: "Main Checkout",
          branch: "main",
          path: undefined,
          status: "offline",
          sessions: [],
          services: [],
        },
      ],
      operationFailures: [],
      mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
    });

    await expect(refreshDashboardModelFromService(host, true)).resolves.toBe(true);

    expect(host.dashboardSessionsCache).toEqual([]);
    expect(host.dashboardModelServiceRefreshError).toBeUndefined();
    expect(host.refreshRuntimeGuard).not.toHaveBeenCalled();
  });
});
