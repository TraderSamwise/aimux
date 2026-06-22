import { describe, expect, it, vi } from "vitest";

import {
  captureDashboardLifecycle,
  isDashboardLifecycleCurrent,
  renderDashboardIfCurrent,
} from "./dashboard-lifecycle.js";

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
});
