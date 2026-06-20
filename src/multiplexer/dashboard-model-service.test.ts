import { describe, expect, it, vi, beforeEach } from "vitest";

const requestJson = vi.hoisted(() => vi.fn());
const resolveProjectServiceEndpoint = vi.hoisted(() => vi.fn());

vi.mock("../http-client.js", () => ({
  requestJson,
}));

vi.mock("../metadata-store.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  resolveProjectServiceEndpoint,
}));

import { DashboardPendingActions } from "../dashboard/pending-actions.js";
import { refreshDashboardModelFromService } from "./dashboard-model.js";

function hostDouble(): any {
  return {
    mode: "dashboard",
    dashboardModelRefreshedAt: 0,
    dashboardServiceSnapshotRefreshing: false,
    dashboardPendingActions: new DashboardPendingActions(() => {}),
    dashboardUiStateStore: {
      orderWorktreeGroups: vi.fn((groups) => groups),
      markSelectionDirty: vi.fn(),
    },
  };
}

describe("refreshDashboardModelFromService", () => {
  beforeEach(() => {
    requestJson.mockReset();
    resolveProjectServiceEndpoint.mockReset();
    resolveProjectServiceEndpoint.mockReturnValue({ host: "127.0.0.1", port: 43199 });
  });

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
    requestJson.mockResolvedValueOnce({
      status: 200,
      json: {
        ok: true,
        sessions: [session],
        teammates: [],
        services: [],
        worktrees: [{ name: "stale-local-shape", path: "/wrong", branch: "wrong", isBare: false }],
        worktreeGroups: [serviceGroup],
        operationFailures: [],
        mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
      },
    });

    await expect(refreshDashboardModelFromService(host, true)).resolves.toBe(true);

    expect(requestJson).toHaveBeenCalledWith("http://127.0.0.1:43199/desktop-state", { timeoutMs: 2000 });
    expect(host.dashboardSessionsCache).toEqual([session]);
    expect(host.dashboardWorktreeGroupsCache).toEqual([
      expect.objectContaining({ name: "Main Checkout", branch: "main", sessions: [session] }),
    ]);
  });

  it("rejects desktop-state payloads without service-composed worktree groups", async () => {
    const host = hostDouble();
    requestJson.mockResolvedValueOnce({
      status: 200,
      json: {
        ok: true,
        sessions: [],
        teammates: [],
        services: [],
        worktrees: [],
        mainCheckoutInfo: { name: "Main Checkout", branch: "main" },
      },
    });

    await expect(refreshDashboardModelFromService(host, false)).resolves.toBe(false);

    expect(host.dashboardSessionsCache).toBeUndefined();
    expect(host.dashboardWorktreeGroupsCache).toBeUndefined();
  });
});
