import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const metadataMocks = vi.hoisted(() => ({
  removeMetadataEndpoint: vi.fn(),
}));

const controlMocks = vi.hoisted(() => ({
  resolveCurrentProjectServiceEndpointForDashboard: vi.fn(),
}));

vi.mock("../metadata-store.js", () => metadataMocks);
vi.mock("./dashboard-control.js", () => controlMocks);

import {
  applyDashboardAlert,
  handleProjectEvent,
  scheduleProjectViewRefresh,
  startDashboardProjectEventStream,
  stopDashboardProjectEventStream,
} from "./project-event-stream.js";

describe("dashboard project event refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    controlMocks.resolveCurrentProjectServiceEndpointForDashboard.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes dashboard model and current coordination view for notification updates", async () => {
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      isDashboardScreen: vi.fn((screen: string) => screen === "coordination"),
      refreshDashboardModelFromService: vi.fn(async () => true),
      refreshCoordinationFromService: vi.fn(async () => true),
      renderCurrentDashboardView: vi.fn(),
    };

    scheduleProjectViewRefresh(host, ["notifications", "coordination-worklist"]);
    await vi.runAllTimersAsync();

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        lifecycle: expect.objectContaining({ inputEpoch: 0 }),
      }),
    );
    expect(host.refreshCoordinationFromService).toHaveBeenCalledWith({
      force: true,
      lifecycle: expect.objectContaining({ inputEpoch: 0 }),
    });
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

  it("drops pending refreshes when the dashboard exits before the timer fires", async () => {
    const host: any = {
      mode: "dashboard",
      refreshDashboardModelFromService: vi.fn(async () => true),
      renderCurrentDashboardView: vi.fn(),
    };

    scheduleProjectViewRefresh(host, ["desktop-state"]);
    host.mode = "session";
    await vi.runAllTimersAsync();

    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
  });

  it("does not render if the dashboard exits while an event refresh is in flight", async () => {
    let resolveRefresh!: (value: boolean) => void;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      refreshDashboardModelFromService: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      renderCurrentDashboardView: vi.fn(),
    };

    scheduleProjectViewRefresh(host, ["desktop-state"]);
    await vi.advanceTimersByTimeAsync(25);
    host.mode = "session";
    resolveRefresh(true);
    await vi.runAllTimersAsync();

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledOnce();
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
  });

  it("resyncs API-backed dashboard state when the SSE stream reconnects", async () => {
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      isDashboardScreen: vi.fn(() => false),
      refreshDashboardModelFromService: vi.fn(async () => true),
      renderCurrentDashboardView: vi.fn(),
    };

    handleProjectEvent(host, "ready", { ok: true });
    await vi.runAllTimersAsync();

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        lifecycle: expect.objectContaining({ inputEpoch: 0 }),
      }),
    );
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
  });

  it("repairs the control plane and resyncs views when the SSE stream fails", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => {
      throw new Error("socket closed");
    });
    globalThis.fetch = fetchMock as never;
    controlMocks.resolveCurrentProjectServiceEndpointForDashboard.mockResolvedValue({
      host: "127.0.0.1",
      port: 43444,
      pid: 1234,
      updatedAt: new Date().toISOString(),
    });
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      ensureDashboardControlPlane: vi.fn(async () => true),
      isDashboardScreen: vi.fn(() => false),
      refreshDashboardModelFromService: vi.fn(async () => true),
      renderCurrentDashboardView: vi.fn(),
    };

    try {
      startDashboardProjectEventStream(host);
      await vi.advanceTimersByTimeAsync(25);
      await vi.advanceTimersByTimeAsync(25);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(metadataMocks.removeMetadataEndpoint).toHaveBeenCalledWith(process.cwd());
      expect(host.ensureDashboardControlPlane).toHaveBeenCalledOnce();
      expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          lifecycle: expect.objectContaining({ inputEpoch: 0 }),
        }),
      );
      expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
    } finally {
      stopDashboardProjectEventStream(host);
      globalThis.fetch = originalFetch;
    }
  });

  it("repairs the control plane when endpoint resolution fails", async () => {
    controlMocks.resolveCurrentProjectServiceEndpointForDashboard.mockRejectedValueOnce(new Error("metadata stale"));
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      ensureDashboardControlPlane: vi.fn(async () => true),
      isDashboardScreen: vi.fn(() => false),
      refreshDashboardModelFromService: vi.fn(async () => true),
      renderCurrentDashboardView: vi.fn(),
    };

    startDashboardProjectEventStream(host);
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(25);

    expect(host.ensureDashboardControlPlane).toHaveBeenCalledOnce();
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        lifecycle: expect.objectContaining({ inputEpoch: 0 }),
      }),
    );
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();

    stopDashboardProjectEventStream(host);
  });

  it("applies SSE alert flashes that used to come from the in-process bus", () => {
    const host: any = {
      mode: "dashboard",
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

  it("ignores alerts after the dashboard has exited", () => {
    const host: any = {
      mode: "session",
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

    expect(host.footerFlash).toBeUndefined();
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
  });
});
