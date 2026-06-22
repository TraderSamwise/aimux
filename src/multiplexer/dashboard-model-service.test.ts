import { describe, expect, it, vi } from "vitest";

import { DashboardPendingActions } from "../dashboard/pending-actions.js";
import { refreshDashboardModelFromService } from "./dashboard-model.js";

function hostDouble(): any {
  return {
    mode: "dashboard",
    dashboardModelRefreshedAt: 0,
    dashboardServiceSnapshotRefreshing: false,
    getFromProjectService: vi.fn(),
    refreshRuntimeGuard: vi.fn(),
    dashboardPendingActions: new DashboardPendingActions(() => {}),
    dashboardUiStateStore: {
      orderWorktreeGroups: vi.fn((groups) => groups),
      markSelectionDirty: vi.fn(),
    },
  };
}

describe("refreshDashboardModelFromService", () => {
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

    expect(host.getFromProjectService).toHaveBeenCalledWith("/desktop-state", { timeoutMs: 2000 });
    expect(host.dashboardSessionsCache).toEqual([session]);
    expect(host.dashboardWorktreeGroupsCache).toEqual([
      expect.objectContaining({ name: "Main Checkout", branch: "main", sessions: [session] }),
    ]);
    expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(1);
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

    expect(host.getFromProjectService).toHaveBeenCalledWith("/desktop-state", { timeoutMs: 750 });
    expect(host.dashboardSessionsCache).toBeUndefined();
    expect(host.dashboardWorktreeGroupsCache).toBeUndefined();
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

    expect(host.getFromProjectService).toHaveBeenCalledWith("/desktop-state", { timeoutMs: 2000 });
    expect(host.dashboardSessionsCache).toBeUndefined();
    expect(host.dashboardWorktreeGroupsCache).toBeUndefined();
    expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(1);
  });
});
