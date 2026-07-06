import { describe, expect, it, vi } from "vitest";

import {
  isDashboardApiMutationBlocked,
  mutateDashboardApi,
  refreshDashboardApiResource,
  refreshDashboardModelThroughApi,
} from "./dashboard-api-client.js";
import { getOrCreateTuiApiRuntime, TuiApiMutationBlockedError } from "./tui-api-runtime.js";

describe("dashboard-api-client", () => {
  it("applies resource snapshots through the TUI API runtime", async () => {
    const host: any = {
      getFromProjectService: vi.fn(async () => ({ ok: true, value: 1 })),
    };
    const apply = vi.fn();
    const ensure = vi.fn();

    await expect(
      refreshDashboardApiResource(host, {
        resource: "demo",
        path: "/demo",
        validate: (value) => value,
        apply,
        ensure,
      }),
    ).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledWith("/demo");
    expect(apply).toHaveBeenCalledWith({ ok: true, value: 1 });
    expect(ensure).not.toHaveBeenCalled();
  });

  it("does not request or apply a resource for a stale lifecycle", async () => {
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 2,
      getFromProjectService: vi.fn(async () => ({ ok: true, value: 1 })),
    };
    const apply = vi.fn();
    const ensure = vi.fn();

    await expect(
      refreshDashboardApiResource(
        host,
        {
          resource: "demo",
          path: "/demo",
          validate: (value) => value,
          apply,
          ensure,
        },
        { lifecycle: { mode: "dashboard", inputEpoch: 1, requiresInputEpoch: true } },
      ),
    ).resolves.toBe(false);

    expect(host.getFromProjectService).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("does not apply a resource if the lifecycle goes stale while loading", async () => {
    let resolveRequest!: (value: unknown) => void;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 1,
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          }),
      ),
    };
    const apply = vi.fn();
    const ensure = vi.fn();

    const refresh = refreshDashboardApiResource(
      host,
      {
        resource: "demo",
        path: "/demo",
        validate: (value) => value,
        apply,
        ensure,
      },
      { lifecycle: { mode: "dashboard", inputEpoch: 1, requiresInputEpoch: true } },
    );
    host.dashboardInputEpoch = 2;
    resolveRequest({ ok: true, value: 1 });

    await expect(refresh).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("returns a failed dashboard model refresh outcome when no snapshot is usable", async () => {
    const host: any = {
      refreshDashboardModelFromService: vi.fn(async () => {
        throw new Error("offline");
      }),
    };

    await expect(refreshDashboardModelThroughApi(host, { force: true })).resolves.toMatchObject({
      ok: false,
      status: "failed",
      stale: false,
    });
  });

  it("returns a stale dashboard model refresh outcome when a prior desktop snapshot is usable", async () => {
    const host: any = {
      getFromProjectService: vi.fn(async () => ({ ok: true, sessions: [] })),
      refreshDashboardModelFromService: vi.fn(async () => {
        host.dashboardModelServiceRefreshError = new Error("offline");
        return false;
      }),
    };
    const runtime = getOrCreateTuiApiRuntime(host);
    await runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    host.getFromProjectService.mockRejectedValue(new Error("offline"));
    await runtime.refreshJson("desktop-state", "/desktop-state", (value) => value, { supersede: true });

    await expect(refreshDashboardModelThroughApi(host, { force: true })).resolves.toMatchObject({
      ok: false,
      status: "stale",
      stale: true,
    });
  });

  it("allows model settlement refreshes while inactive even with a stale render lifecycle", async () => {
    const host: any = {
      mode: "session",
      dashboardInputEpoch: 2,
      refreshDashboardModelFromService: vi.fn(async () => true),
    };

    await expect(
      refreshDashboardModelThroughApi(host, {
        force: true,
        allowInactive: true,
        lifecycle: { mode: "dashboard", inputEpoch: 1, requiresInputEpoch: true },
      }),
    ).resolves.toMatchObject({ ok: true, status: "applied" });

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true, { allowInactive: true });
  });

  it("mutates through the shared TUI API runtime", async () => {
    const host: any = {
      getFromProjectService: vi.fn(),
      postToProjectService: vi.fn(async (_path: string, body: unknown) => ({ ok: true, body })),
    };

    await expect(mutateDashboardApi(host, "/agents/stop", { sessionId: "a" })).resolves.toEqual({
      ok: true,
      body: { sessionId: "a" },
    });

    expect(host.postToProjectService).toHaveBeenCalledWith("/agents/stop", { sessionId: "a" });
  });

  it("blocks mutations while the critical desktop-state resource is reconnecting", async () => {
    const host: any = {
      getFromProjectService: vi.fn(async () => ({ ok: true, sessions: [] })),
      postToProjectService: vi.fn(async () => ({ ok: true })),
    };
    const runtime = getOrCreateTuiApiRuntime(host);
    await runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    host.getFromProjectService.mockRejectedValue(Object.assign(new Error("offline"), { code: "ECONNREFUSED" }));
    await runtime.refreshJson("desktop-state", "/desktop-state", (value) => value, { supersede: true });

    expect(isDashboardApiMutationBlocked(host)).toBe(true);
    await expect(mutateDashboardApi(host, "/agents/stop", { sessionId: "a" })).rejects.toBeInstanceOf(
      TuiApiMutationBlockedError,
    );
    expect(host.postToProjectService).not.toHaveBeenCalled();
  });
});
