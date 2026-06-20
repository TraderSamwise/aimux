import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyDashboardAlert, scheduleProjectViewRefresh, stopDashboardProjectEventStream } from "./project-event-stream.js";

describe("dashboard project event refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes dashboard model and current coordination view for notification updates", async () => {
    const host: any = {
      mode: "dashboard",
      isDashboardScreen: vi.fn((screen: string) => screen === "coordination"),
      refreshDashboardModelFromService: vi.fn(async () => true),
      refreshCoordinationFromService: vi.fn(async () => true),
      renderCurrentDashboardView: vi.fn(),
    };

    scheduleProjectViewRefresh(host, ["notifications", "coordination-worklist"]);
    await vi.runAllTimersAsync();

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(true);
    expect(host.refreshCoordinationFromService).toHaveBeenCalledOnce();
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
  });

  it("coalesces bursts and cancels pending refreshes on stop", async () => {
    const host: any = {
      mode: "dashboard",
      refreshDashboardModelFromService: vi.fn(async () => true),
      renderCurrentDashboardView: vi.fn(),
    };

    scheduleProjectViewRefresh(host, ["desktop-state"]);
    scheduleProjectViewRefresh(host, ["threads"]);
    stopDashboardProjectEventStream(host);
    await vi.runAllTimersAsync();

    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
  });

  it("applies SSE alert flashes that used to come from the in-process bus", () => {
    const host: any = {
      renderCurrentDashboardView: vi.fn(),
    };

    applyDashboardAlert(host, {
      type: "alert",
      kind: "task_failed",
      projectId: "project",
      title: "Task failed",
      message: "Failure",
      ts: new Date().toISOString(),
    });

    expect(host.footerFlash).toBe("✗ Task failed");
    expect(host.footerFlashTicks).toBe(4);
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
  });
});
