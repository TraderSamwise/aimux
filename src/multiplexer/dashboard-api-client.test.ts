import { describe, expect, it, vi } from "vitest";

import { refreshDashboardApiResource, refreshDashboardModelThroughApi } from "./dashboard-api-client.js";

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

  it("wraps dashboard model refresh failures as false", async () => {
    const host: any = {
      refreshDashboardModelFromService: vi.fn(async () => {
        throw new Error("offline");
      }),
    };

    await expect(refreshDashboardModelThroughApi(host, { force: true })).resolves.toBe(false);
  });
});
