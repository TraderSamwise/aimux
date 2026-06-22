import { describe, expect, it, vi } from "vitest";

import {
  captureDashboardLifecycle,
  isDashboardLifecycleCurrent,
  renderDashboardIfCurrent,
  startDashboardLifecycleTask,
} from "./dashboard-lifecycle.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("dashboard lifecycle guards", () => {
  it("keeps unscoped dashboard lifecycle tokens current while the host stays in dashboard mode", () => {
    const host: any = { mode: "dashboard" };
    const token = captureDashboardLifecycle(host);

    expect(isDashboardLifecycleCurrent(host, token)).toBe(true);
  });

  it("fails closed when an input epoch was requested but the host cannot verify it", () => {
    const host: any = { mode: "dashboard" };
    const token = captureDashboardLifecycle(host, { inputEpoch: true });

    expect(isDashboardLifecycleCurrent(host, token)).toBe(false);
  });

  it("rejects stale input epoch tokens", () => {
    const host: any = { mode: "dashboard", dashboardInputEpoch: 3 };
    const token = captureDashboardLifecycle(host, { inputEpoch: true });

    host.dashboardInputEpoch = 4;

    expect(isDashboardLifecycleCurrent(host, token)).toBe(false);
  });

  it("fails closed when a screen token cannot be verified", () => {
    const host: any = { mode: "dashboard" };
    const token = captureDashboardLifecycle(host, { screen: "coordination" });

    expect(isDashboardLifecycleCurrent(host, token)).toBe(false);
  });

  it("renders only when the requested screen still matches", () => {
    const render = vi.fn();
    const host: any = {
      mode: "dashboard",
      dashboardState: { screen: "coordination" },
    };
    const token = captureDashboardLifecycle(host, { screen: "coordination" });

    renderDashboardIfCurrent(host, token, render);
    host.dashboardState.screen = "project";
    renderDashboardIfCurrent(host, token, render);

    expect(render).toHaveBeenCalledOnce();
  });

  it("runs lifecycle task success handlers only while the token is current", async () => {
    const pending = deferred<string>();
    const onSuccess = vi.fn();
    const onFinally = vi.fn();
    const host: any = { mode: "dashboard", dashboardInputEpoch: 1, dashboardState: { screen: "project" } };

    startDashboardLifecycleTask(host, { inputEpoch: true, screen: "project" }, () => pending.promise, {
      onSuccess,
      onFinally,
    });
    host.dashboardInputEpoch = 2;
    pending.resolve("done");
    await pending.promise;
    await Promise.resolve();

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFinally).not.toHaveBeenCalled();
  });

  it("runs lifecycle task error handlers only while the token is current", async () => {
    const pending = deferred<string>();
    const onError = vi.fn();
    const host: any = { mode: "dashboard", dashboardInputEpoch: 1, dashboardState: { screen: "coordination" } };

    startDashboardLifecycleTask(host, { inputEpoch: true, screen: "coordination" }, () => pending.promise, {
      onError,
    });
    host.mode = "session";
    pending.reject(new Error("late failure"));
    await pending.promise.catch(() => undefined);
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
  });

  it("runs lifecycle task handlers when the token remains current", async () => {
    const onSuccess = vi.fn();
    const onFinally = vi.fn();
    const host: any = { mode: "dashboard", dashboardInputEpoch: 1, dashboardState: { screen: "library" } };

    startDashboardLifecycleTask(host, { inputEpoch: true, screen: "library" }, async () => "ok", {
      onSuccess,
      onFinally,
    });

    await vi.waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith("ok", expect.objectContaining({ inputEpoch: 1, screen: "library" })),
    );
    expect(onFinally).toHaveBeenCalledWith(expect.objectContaining({ inputEpoch: 1, screen: "library" }));
  });
});
