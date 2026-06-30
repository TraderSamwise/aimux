import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  mutateDashboardApi: vi.fn(),
}));

vi.mock("./dashboard-api-client.js", () => apiMocks);

import {
  clearTuiRuntimeMutationQueue,
  queueTuiNotificationContext,
  queueTuiSessionSeen,
} from "./tui-runtime-mutations.js";

describe("TUI runtime mutation queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    apiMocks.mutateDashboardApi.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces notification context updates and marks sessions seen off the hot path", async () => {
    const host: any = {};

    queueTuiNotificationContext(host, { screen: "dashboard", sessionId: "first", panelOpen: true });
    queueTuiNotificationContext(host, { screen: "agent", sessionId: "second", panelOpen: false });
    queueTuiSessionSeen(host, "first");
    queueTuiSessionSeen(host, "second");

    expect(apiMocks.mutateDashboardApi).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();

    expect(apiMocks.mutateDashboardApi).toHaveBeenCalledTimes(3);
    expect(apiMocks.mutateDashboardApi).toHaveBeenNthCalledWith(
      1,
      host,
      "/notification-context",
      {
        source: "tui",
        focused: true,
        screen: "agent",
        sessionId: "second",
        panelOpen: false,
      },
      { timeoutMs: 3000, recoverOnFailure: false },
    );
    expect(apiMocks.mutateDashboardApi).toHaveBeenNthCalledWith(2, host, "/mark-seen", {
      session: "first",
    });
    expect(apiMocks.mutateDashboardApi).toHaveBeenNthCalledWith(3, host, "/mark-seen", {
      session: "second",
    });
  });

  it("drops failed telemetry context without overwriting newer context", async () => {
    const host: any = {};
    apiMocks.mutateDashboardApi.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true });

    queueTuiNotificationContext(host, { screen: "dashboard", sessionId: "old" });
    await vi.runOnlyPendingTimersAsync();
    queueTuiNotificationContext(host, { screen: "coordination", sessionId: "new" });
    await vi.advanceTimersByTimeAsync(250);

    expect(apiMocks.mutateDashboardApi).toHaveBeenCalledTimes(2);
    expect(apiMocks.mutateDashboardApi).toHaveBeenLastCalledWith(
      host,
      "/notification-context",
      {
        source: "tui",
        focused: true,
        screen: "coordination",
        sessionId: "new",
      },
      { timeoutMs: 3000, recoverOnFailure: false },
    );
  });

  it("clears pending retries during teardown", async () => {
    const host: any = {};
    apiMocks.mutateDashboardApi.mockRejectedValue(new Error("offline"));

    queueTuiSessionSeen(host, "codex-1");
    await vi.runOnlyPendingTimersAsync();
    clearTuiRuntimeMutationQueue(host);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(apiMocks.mutateDashboardApi).toHaveBeenCalledTimes(1);
    expect(host.tuiRuntimeMutationQueue).toBeUndefined();
  });

  it("lets fresh context updates preempt a pending mark-seen retry backoff", async () => {
    const host: any = {};
    apiMocks.mutateDashboardApi.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true });

    queueTuiSessionSeen(host, "codex-1");
    await vi.runOnlyPendingTimersAsync();
    queueTuiNotificationContext(host, { screen: "agent", sessionId: "codex-2" });
    await vi.advanceTimersByTimeAsync(0);

    expect(apiMocks.mutateDashboardApi).toHaveBeenCalledTimes(3);
    expect(apiMocks.mutateDashboardApi).toHaveBeenNthCalledWith(
      2,
      host,
      "/notification-context",
      {
        source: "tui",
        focused: true,
        screen: "agent",
        sessionId: "codex-2",
      },
      { timeoutMs: 3000, recoverOnFailure: false },
    );
    expect(apiMocks.mutateDashboardApi).toHaveBeenNthCalledWith(3, host, "/mark-seen", {
      session: "codex-1",
    });
  });

  it("drops failed notification context when no fresh context arrived", async () => {
    const host: any = {};
    apiMocks.mutateDashboardApi.mockRejectedValue(new Error("offline"));

    queueTuiNotificationContext(host, { screen: "agent", sessionId: "codex-1" });
    await vi.runOnlyPendingTimersAsync();
    expect(apiMocks.mutateDashboardApi).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(apiMocks.mutateDashboardApi).toHaveBeenCalledTimes(1);
  });

  it("merges partial notification context patches before flushing", async () => {
    const host: any = {};

    queueTuiNotificationContext(host, { screen: "agent", sessionId: "codex-1" });
    queueTuiNotificationContext(host, { panelOpen: false });
    await vi.runOnlyPendingTimersAsync();

    expect(apiMocks.mutateDashboardApi).toHaveBeenCalledOnce();
    expect(apiMocks.mutateDashboardApi).toHaveBeenCalledWith(
      host,
      "/notification-context",
      {
        source: "tui",
        focused: true,
        screen: "agent",
        sessionId: "codex-1",
        panelOpen: false,
      },
      { timeoutMs: 3000, recoverOnFailure: false },
    );
  });

  it("does not reschedule an in-flight failure after teardown", async () => {
    const host: any = {};
    let rejectMutation!: (error: unknown) => void;
    apiMocks.mutateDashboardApi.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectMutation = reject;
      }),
    );

    queueTuiSessionSeen(host, "codex-1");
    await vi.advanceTimersByTimeAsync(0);
    clearTuiRuntimeMutationQueue(host);
    rejectMutation(new Error("offline"));
    await vi.runAllTimersAsync();

    expect(apiMocks.mutateDashboardApi).toHaveBeenCalledTimes(1);
    expect(host.tuiRuntimeMutationQueue).toBeUndefined();
  });

  it("does not recreate the queue when in-flight context fails after teardown", async () => {
    const host: any = {};
    let rejectMutation!: (error: unknown) => void;
    apiMocks.mutateDashboardApi.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectMutation = reject;
      }),
    );

    queueTuiNotificationContext(host, { screen: "agent", sessionId: "codex-1" });
    await vi.advanceTimersByTimeAsync(0);
    clearTuiRuntimeMutationQueue(host);
    rejectMutation(new Error("offline"));
    await vi.runAllTimersAsync();

    expect(apiMocks.mutateDashboardApi).toHaveBeenCalledTimes(1);
    expect(host.tuiRuntimeMutationQueue).toBeUndefined();
  });

  it("does not continue a mixed batch after teardown", async () => {
    const host: any = {};
    let resolveContext!: (value: unknown) => void;
    apiMocks.mutateDashboardApi.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveContext = resolve;
      }),
    );

    queueTuiNotificationContext(host, { screen: "agent", sessionId: "codex-1" });
    queueTuiSessionSeen(host, "codex-1");
    await vi.advanceTimersByTimeAsync(0);
    clearTuiRuntimeMutationQueue(host);
    resolveContext({ ok: true });
    await vi.runAllTimersAsync();

    expect(apiMocks.mutateDashboardApi).toHaveBeenCalledTimes(1);
    expect(host.tuiRuntimeMutationQueue).toBeUndefined();
  });
});
