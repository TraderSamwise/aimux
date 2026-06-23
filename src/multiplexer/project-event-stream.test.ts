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
        lifecycle: expect.objectContaining({ mode: "dashboard", inputEpoch: undefined }),
      }),
    );
    expect(host.refreshCoordinationFromService).toHaveBeenCalledWith({
      force: true,
      lifecycle: expect.objectContaining({ mode: "dashboard", screen: "coordination" }),
    });
    expect(host.refreshCoordinationFromService.mock.calls[0]?.[0]?.lifecycle.inputEpoch).toBeUndefined();
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
  });

  it("keeps SSE data refreshes when input changes during the request", async () => {
    let resolveModelRefresh!: (value: boolean) => void;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      isDashboardScreen: vi.fn((screen: string) => screen === "coordination"),
      refreshDashboardModelFromService: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveModelRefresh = resolve;
          }),
      ),
      refreshCoordinationFromService: vi.fn(async () => true),
      renderCurrentDashboardView: vi.fn(),
    };

    scheduleProjectViewRefresh(host, ["notifications", "coordination-worklist"]);
    await vi.advanceTimersByTimeAsync(25);
    host.dashboardInputEpoch = 1;
    resolveModelRefresh(true);
    await vi.runAllTimersAsync();

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        lifecycle: expect.objectContaining({ mode: "dashboard", inputEpoch: undefined }),
      }),
    );
    expect(host.refreshCoordinationFromService).toHaveBeenCalledWith({
      force: true,
      lifecycle: expect.objectContaining({ mode: "dashboard", screen: "coordination" }),
    });
    expect(host.refreshCoordinationFromService.mock.calls[0]?.[0]?.lifecycle.inputEpoch).toBeUndefined();
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

  it("does not render after the event adapter stops during an in-flight refresh", async () => {
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
    stopDashboardProjectEventStream(host);
    resolveRefresh(true);
    await vi.runAllTimersAsync();

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledOnce();
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
  });

  it("keeps active project SSE refresh state when input changes on the same screen", async () => {
    let resolveProjectRefresh!: (value: unknown) => void;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      isDashboardScreen: vi.fn((screen: string) => screen === "project"),
      refreshDashboardModelFromService: vi.fn(async () => true),
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveProjectRefresh = resolve;
          }),
      ),
      renderCurrentDashboardView: vi.fn(),
    };

    scheduleProjectViewRefresh(host, ["project-observability"]);
    await vi.advanceTimersByTimeAsync(25);
    host.dashboardInputEpoch = 1;
    resolveProjectRefresh(projectPayload());
    await vi.runAllTimersAsync();

    expect(host.projectObservability?.story[0]?.title).toBe("SSE project update");
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
  });

  it("drops active project SSE refresh state after navigation away", async () => {
    let currentScreen = "project";
    let resolveProjectRefresh!: (value: unknown) => void;
    const host: any = {
      mode: "dashboard",
      dashboardInputEpoch: 0,
      isDashboardScreen: vi.fn((screen: string) => screen === currentScreen),
      refreshDashboardModelFromService: vi.fn(async () => true),
      projectObservability: projectPayload("old").project,
      projectObservabilityLoaded: true,
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveProjectRefresh = resolve;
          }),
      ),
      renderCurrentDashboardView: vi.fn(),
    };

    scheduleProjectViewRefresh(host, ["project-observability"]);
    await vi.advanceTimersByTimeAsync(25);
    currentScreen = "library";
    resolveProjectRefresh(projectPayload());
    await vi.runAllTimersAsync();

    expect(host.projectObservability.story[0]?.title).toBe("old");
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
        lifecycle: expect.objectContaining({ mode: "dashboard", inputEpoch: undefined }),
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
          lifecycle: expect.objectContaining({ mode: "dashboard", inputEpoch: undefined }),
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
        lifecycle: expect.objectContaining({ mode: "dashboard", inputEpoch: undefined }),
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

  it("ignores buffered events after the event adapter stops", async () => {
    const originalFetch = globalThis.fetch;
    let enqueue!: (chunk: Uint8Array) => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        enqueue = (chunk) => controller.enqueue(chunk);
      },
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: stream,
    })) as never;
    controlMocks.resolveCurrentProjectServiceEndpointForDashboard.mockResolvedValue({
      host: "127.0.0.1",
      port: 43444,
      pid: 1234,
      updatedAt: new Date().toISOString(),
    });
    const host: any = {
      mode: "dashboard",
      renderCurrentDashboardView: vi.fn(),
    };

    try {
      startDashboardProjectEventStream(host);
      await Promise.resolve();
      stopDashboardProjectEventStream(host);
      enqueue(
        new TextEncoder().encode(
          'event: alert\ndata: {"type":"alert","kind":"task_failed","projectId":"project","title":"Task failed","message":"Failure","ts":"now"}\n\n',
        ),
      );
      await vi.runAllTimersAsync();

      expect(host.footerFlash).toBeUndefined();
      expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
    } finally {
      stopDashboardProjectEventStream(host);
      globalThis.fetch = originalFetch;
    }
  });
});

function projectPayload(title = "SSE project update") {
  return {
    ok: true,
    project: {
      summary: {
        agentsRunning: 1,
        agentsWaiting: 0,
        agentsOffline: 0,
        services: 0,
        worktrees: 1,
        openTasks: 1,
        doneTasks: 0,
        unreadNotifications: 0,
      },
      progress: { pending: 0, assigned: 1, in_progress: 0, blocked: 0, done: 0, failed: 0, total: 1 },
      story: [{ id: "task:1", kind: "task", title, meta: "assigned", createdAt: "now" }],
    },
  };
}
