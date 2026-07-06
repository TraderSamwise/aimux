import { describe, expect, it, vi } from "vitest";

import {
  getJsonWithTuiApiRuntime,
  getOrCreateTuiApiRuntime,
  postJsonWithTuiApiRuntime,
  scheduleTuiApiRecovery,
  TuiApiMutationBlockedError,
  TuiApiRuntime,
  TUI_API_RECOVERY_COOLDOWN_MS,
  TUI_API_RECOVERY_DEBOUNCE_MS,
} from "./tui-api-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TuiApiRuntime", () => {
  it("coalesces concurrent refreshes for the same resource", async () => {
    const request = vi.fn(async () => ({ ok: true, value: 1 }));
    const runtime = new TuiApiRuntime({ request });

    const first = runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    const second = runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, value: { ok: true, value: 1 }, stale: false, generation: 1 },
      { ok: true, value: { ok: true, value: 1 }, stale: false, generation: 1 },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good value when a refresh fails", async () => {
    const request = vi.fn().mockResolvedValueOnce({ ok: true, value: 1 }).mockRejectedValueOnce(new Error("timeout"));
    const states: string[] = [];
    const runtime = new TuiApiRuntime({ request, onConnectionStateChange: (state) => states.push(state) });

    await expect(runtime.refreshJson("desktop-state", "/desktop-state", (value) => value)).resolves.toMatchObject({
      ok: true,
      value: { ok: true, value: 1 },
    });
    await expect(runtime.refreshJson("desktop-state", "/desktop-state", (value) => value)).resolves.toMatchObject({
      ok: false,
      value: { ok: true, value: 1 },
      stale: true,
    });

    expect(runtime.getSnapshot("desktop-state")).toMatchObject({
      value: { ok: true, value: 1 },
      stale: true,
      pending: false,
    });
    expect(states).toContain("stale");
  });

  it("does not coalesce mutations", async () => {
    const mutate = vi.fn(async (_path: string, body: unknown) => ({ ok: true, body }));
    const runtime = new TuiApiRuntime({ request: vi.fn(), mutate });

    const first = runtime.mutateJson("/notifications/read", { id: "one" }, (value) => value);
    const second = runtime.mutateJson("/notifications/read", { id: "two" }, (value) => value);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, value: { ok: true, body: { id: "one" } } },
      { ok: true, value: { ok: true, body: { id: "two" } } },
    ]);
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  it("reports reconnecting state when a mutation fails", async () => {
    const states: string[] = [];
    const runtime = new TuiApiRuntime({
      request: vi.fn(),
      mutate: vi.fn(async () => {
        throw new Error("offline");
      }),
      onConnectionStateChange: (state) => states.push(state),
    });

    await expect(runtime.mutateJson("/notifications/read", {}, (value) => value)).resolves.toMatchObject({
      ok: false,
      error: expect.any(Error),
    });

    expect(states).toContain("reconnecting");
  });

  it("does not reconnect or recover for semantic mutation failures", async () => {
    const states: string[] = [];
    const failures = vi.fn();
    const error = Object.assign(new Error("session is already stopped"), {
      status: 400,
      tuiApiRecoverable: false,
    });
    const runtime = new TuiApiRuntime({
      request: vi.fn(),
      mutate: vi.fn(async () => {
        throw error;
      }),
      onConnectionStateChange: (state) => states.push(state),
      onRequestFailure: failures,
    });

    await expect(runtime.mutateJson("/agents/stop", {}, (value) => value)).resolves.toMatchObject({
      ok: false,
      error,
    });

    expect(runtime.getConnectionState()).toBe("ready");
    expect(states).toEqual([]);
    expect(failures).not.toHaveBeenCalled();
  });

  it("still recovers for retryable service status failures", async () => {
    const states: string[] = [];
    const failures = vi.fn();
    const error = Object.assign(new Error("service unavailable"), {
      status: 503,
      tuiApiRecoverable: true,
    });
    const runtime = new TuiApiRuntime({
      request: vi.fn(async () => {
        throw error;
      }),
      onConnectionStateChange: (state) => states.push(state),
      onRequestFailure: failures,
    });

    await expect(runtime.requestJson("/desktop-state", (value) => value)).resolves.toMatchObject({
      ok: false,
      error,
    });

    expect(runtime.getConnectionState()).toBe("reconnecting");
    expect(states).toEqual(["reconnecting"]);
    expect(failures).toHaveBeenCalledWith(error);
  });

  it("keeps refresh failures reconnecting while scheduling recovery", async () => {
    const states: string[] = [];
    const failures = vi.fn();
    const error = new Error("invalid coordination payload");
    const runtime = new TuiApiRuntime({
      request: vi.fn(async () => {
        throw error;
      }),
      onConnectionStateChange: (state) => states.push(state),
      onRequestFailure: failures,
    });

    await expect(
      runtime.refreshJson("coordination-worklist", "/coordination-worklist", (value) => value),
    ).resolves.toMatchObject({
      ok: false,
      error,
    });

    expect(runtime.getConnectionState()).toBe("reconnecting");
    expect(states).toEqual(["refreshing", "reconnecting"]);
    expect(failures).toHaveBeenCalledWith(error);
  });

  it("does not let an older wrapper read failure degrade a newer success", async () => {
    const slow = deferred<unknown>();
    const fast = deferred<unknown>();
    const failures = vi.fn();
    const runtime = new TuiApiRuntime({
      request: vi.fn().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise),
      onRequestFailure: failures,
    });

    const slowRead = runtime.requestJson("/slow", (value) => value);
    const fastRead = runtime.requestJson("/fast", (value) => value);

    fast.resolve({ ok: true });
    await expect(fastRead).resolves.toEqual({ ok: true, value: { ok: true } });
    slow.reject(new Error("late timeout"));
    await expect(slowRead).resolves.toMatchObject({ ok: false, error: expect.any(Error) });

    expect(runtime.getConnectionState()).toBe("ready");
    expect(failures).not.toHaveBeenCalled();
  });

  it("keeps the successful request watermark monotonic", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const third = deferred<unknown>();
    const failures = vi.fn();
    const runtime = new TuiApiRuntime({
      request: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
        .mockReturnValueOnce(third.promise),
      onRequestFailure: failures,
    });

    const oldest = runtime.requestJson("/oldest", (value) => value);
    const middle = runtime.requestJson("/middle", (value) => value);
    const newest = runtime.requestJson("/newest", (value) => value);

    third.resolve({ ok: true, id: "newest" });
    await expect(newest).resolves.toMatchObject({ ok: true });
    first.resolve({ ok: true, id: "oldest" });
    await expect(oldest).resolves.toMatchObject({ ok: true });
    second.reject(new Error("middle timeout"));
    await expect(middle).resolves.toMatchObject({ ok: false, error: expect.any(Error) });

    expect(runtime.getConnectionState()).toBe("ready");
    expect(failures).not.toHaveBeenCalled();
  });

  it("does not let an older wrapper mutation failure degrade a newer success", async () => {
    const slow = deferred<unknown>();
    const fast = deferred<unknown>();
    const failures = vi.fn();
    const runtime = new TuiApiRuntime({
      request: vi.fn(),
      mutate: vi.fn().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise),
      onRequestFailure: failures,
    });

    const slowMutation = runtime.mutateJson("/slow", {}, (value) => value);
    const fastMutation = runtime.mutateJson("/fast", {}, (value) => value);

    fast.resolve({ ok: true });
    await expect(fastMutation).resolves.toEqual({ ok: true, value: { ok: true } });
    slow.reject(new Error("late timeout"));
    await expect(slowMutation).resolves.toMatchObject({ ok: false, error: expect.any(Error) });

    expect(runtime.getConnectionState()).toBe("ready");
    expect(failures).not.toHaveBeenCalled();
  });

  it("does not let an older resource refresh failure degrade a newer direct success", async () => {
    const slow = deferred<unknown>();
    const fast = deferred<unknown>();
    const failures = vi.fn();
    const runtime = new TuiApiRuntime({
      request: vi.fn().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise),
      onRequestFailure: failures,
    });

    const refresh = runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    const read = runtime.requestJson("/health", (value) => value);

    fast.resolve({ ok: true });
    await expect(read).resolves.toEqual({ ok: true, value: { ok: true } });
    slow.reject(new Error("late timeout"));
    await expect(refresh).resolves.toMatchObject({ ok: false, error: expect.any(Error) });

    expect(runtime.getConnectionState()).toBe("ready");
    expect(failures).not.toHaveBeenCalled();
  });

  it("keeps critical resource failures reconnecting until that resource refreshes", async () => {
    const critical = deferred<unknown>();
    const health = deferred<unknown>();
    const recovered = deferred<unknown>();
    const failures = vi.fn();
    const states: string[] = [];
    const runtime = new TuiApiRuntime({
      request: vi
        .fn()
        .mockReturnValueOnce(critical.promise)
        .mockReturnValueOnce(health.promise)
        .mockReturnValueOnce(recovered.promise),
      criticalResources: ["desktop-state"],
      onConnectionStateChange: (state) => states.push(state),
      onRequestFailure: failures,
    });

    const refresh = runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    const read = runtime.requestJson("/health", (value) => value);

    health.resolve({ ok: true });
    await expect(read).resolves.toEqual({ ok: true, value: { ok: true } });
    critical.reject(new Error("late desktop-state timeout"));
    await expect(refresh).resolves.toMatchObject({ ok: false, error: expect.any(Error) });

    expect(runtime.getConnectionState()).toBe("reconnecting");
    expect(failures).toHaveBeenCalledTimes(1);

    const recoveryRefresh = runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    recovered.resolve({ ok: true, recovered: true });
    await expect(recoveryRefresh).resolves.toMatchObject({
      ok: true,
      value: { ok: true, recovered: true },
    });

    expect(runtime.getConnectionState()).toBe("ready");
    expect(states).toEqual(["refreshing", "ready", "reconnecting", "ready"]);
  });

  it("routes wrapper reads through the shared runtime transport", async () => {
    const host: any = {};
    const request = vi.fn(async () => ({ ok: true, value: 1 }));

    await expect(getJsonWithTuiApiRuntime(host, "/desktop-state", { timeoutMs: 5000 }, request)).resolves.toEqual({
      ok: true,
      value: 1,
    });

    expect(request).toHaveBeenCalledWith(host, "/desktop-state", { timeoutMs: 5000 });
    expect(host.tuiApiRuntime.getConnectionState()).toBe("ready");
  });

  it("keeps wrapper read failures thrown for existing callers", async () => {
    const host: any = {};
    const request = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(getJsonWithTuiApiRuntime(host, "/desktop-state", undefined, request)).rejects.toThrow("offline");

    expect(request).toHaveBeenCalledWith(host, "/desktop-state", undefined);
    expect(host.tuiApiConnectionState).toBe("reconnecting");
  });

  it("keeps dashboard critical refresh failures reconnecting after wrapper success", async () => {
    const desktopState = deferred<unknown>();
    const host: any = {
      mode: "dashboard",
      refreshRuntimeGuard: vi.fn(),
      getFromProjectService: vi.fn(() => desktopState.promise),
    };
    const runtime = getOrCreateTuiApiRuntime(host);
    const wrapperRead = vi.fn(async () => ({ ok: true, value: "health" }));

    const refresh = runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    await expect(getJsonWithTuiApiRuntime(host, "/health", undefined, wrapperRead)).resolves.toEqual({
      ok: true,
      value: "health",
    });
    desktopState.reject(new Error("desktop-state failed"));
    await expect(refresh).resolves.toMatchObject({ ok: false, error: expect.any(Error) });

    expect(host.tuiApiConnectionState).toBe("reconnecting");
    expect(runtime.getConnectionState()).toBe("reconnecting");
  });

  it("routes wrapper mutations through the shared runtime transport", async () => {
    const host: any = {};
    const mutate = vi.fn(async () => ({ ok: true, warning: "kept" }));

    await expect(
      postJsonWithTuiApiRuntime(host, "/agents/resume", { sessionId: "claude-1" }, { timeoutMs: 60_000 }, mutate),
    ).resolves.toEqual({ ok: true, warning: "kept" });

    expect(mutate).toHaveBeenCalledWith(host, "/agents/resume", { sessionId: "claude-1" }, { timeoutMs: 60_000 });
    expect(host.tuiApiRuntime.getConnectionState()).toBe("ready");
  });

  it("keeps wrapper mutation failures thrown for existing callers", async () => {
    const host: any = {};
    const mutate = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      postJsonWithTuiApiRuntime(host, "/agents/stop", { sessionId: "claude-1" }, undefined, mutate),
    ).rejects.toThrow("offline");

    expect(mutate).toHaveBeenCalledWith(host, "/agents/stop", { sessionId: "claude-1" }, undefined);
    expect(host.tuiApiConnectionState).toBe("reconnecting");
  });

  it("does not run recovery for best-effort mutation failures", async () => {
    const failures = vi.fn();
    const runtime = new TuiApiRuntime({
      request: vi.fn(),
      mutate: vi.fn(async () => {
        throw new Error("telemetry timeout");
      }),
      onRequestFailure: failures,
    });

    await expect(
      runtime.mutateJson("/notification-context", { source: "tui" }, (value) => value, {
        timeoutMs: 3000,
        recoverOnFailure: false,
      }),
    ).resolves.toMatchObject({ ok: false, error: expect.any(Error) });

    expect(runtime.getConnectionState()).toBe("ready");
    expect(failures).not.toHaveBeenCalled();
  });

  it("coalesces API failures into one runtime guard recovery", async () => {
    vi.useFakeTimers();
    try {
      const host: any = {
        mode: "dashboard",
        refreshRuntimeGuard: vi.fn(),
        getFromProjectService: vi.fn(async () => {
          throw new Error("offline");
        }),
      };
      const runtime = getOrCreateTuiApiRuntime(host);

      await expect(runtime.refreshJson("desktop-state", "/desktop-state", (value) => value)).resolves.toMatchObject({
        ok: false,
      });
      await expect(
        postJsonWithTuiApiRuntime(host, "/agents/stop", { sessionId: "claude-1" }, undefined, async () => {
          throw new Error("still offline");
        }),
      ).rejects.toBeInstanceOf(TuiApiMutationBlockedError);

      expect(host.refreshRuntimeGuard).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(TUI_API_RECOVERY_DEBOUNCE_MS);
      expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes failed critical resources after a recovery probe succeeds", async () => {
    vi.useFakeTimers();
    try {
      const host: any = {
        mode: "dashboard",
        refreshRuntimeGuard: vi.fn(async () => undefined),
        getFromProjectService: vi
          .fn()
          .mockRejectedValueOnce(new Error("desktop-state offline"))
          .mockResolvedValueOnce({ ok: true, recovered: true }),
      };
      const runtime = getOrCreateTuiApiRuntime(host);

      await expect(runtime.refreshJson("desktop-state", "/desktop-state", (value) => value)).resolves.toMatchObject({
        ok: false,
      });
      expect(runtime.getConnectionState()).toBe("reconnecting");

      await vi.advanceTimersByTimeAsync(TUI_API_RECOVERY_DEBOUNCE_MS);

      expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(1);
      expect(host.getFromProjectService).toHaveBeenCalledTimes(2);
      expect(runtime.getConnectionState()).toBe("ready");
      expect(runtime.getSnapshot("desktop-state")).toMatchObject({
        value: { ok: true, recovered: true },
        error: undefined,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes a connection snapshot for stale cached resource failures", async () => {
    const error = new Error("timeout");
    const request = vi.fn().mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(error);
    const runtime = new TuiApiRuntime({ request, criticalResources: ["desktop-state"] });

    await expect(runtime.refreshJson("desktop-state", "/desktop-state", (value) => value)).resolves.toMatchObject({
      ok: true,
    });
    await expect(runtime.refreshJson("desktop-state", "/desktop-state", (value) => value)).resolves.toMatchObject({
      ok: false,
      stale: true,
    });

    expect(runtime.getConnectionSnapshot()).toMatchObject({
      state: "stale",
      pendingResources: [],
      staleResources: ["desktop-state"],
      failedResources: ["desktop-state"],
      failedCriticalResources: ["desktop-state"],
      lastError: error,
    });
  });

  it("reports repairing, repaired, and ready around successful scheduled recovery", async () => {
    vi.useFakeTimers();
    try {
      const states: string[] = [];
      const host: any = {
        mode: "dashboard",
        refreshRuntimeGuard: vi.fn(async () => undefined),
        getFromProjectService: vi
          .fn()
          .mockRejectedValueOnce(new Error("desktop-state offline"))
          .mockResolvedValueOnce({ ok: true, recovered: true }),
      };
      const runtime = new TuiApiRuntime({
        request: (path, opts) => host.getFromProjectService(path, opts),
        criticalResources: ["desktop-state"],
        onConnectionStateChange: (state) => {
          states.push(state);
          host.tuiApiConnectionState = state;
        },
        onRequestFailure: () => scheduleTuiApiRecovery(host),
      });
      host.tuiApiRuntime = runtime;

      await expect(runtime.refreshJson("desktop-state", "/desktop-state", (value) => value)).resolves.toMatchObject({
        ok: false,
      });
      await vi.advanceTimersByTimeAsync(TUI_API_RECOVERY_DEBOUNCE_MS);

      expect(states).toContain("repairing");
      expect(states).toContain("repaired");
      expect(states.indexOf("repairing")).toBeLessThan(states.indexOf("repaired"));
      expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(1);
      expect(host.getFromProjectService).toHaveBeenCalledTimes(2);
      expect(runtime.getConnectionState()).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports failed when scheduled recovery rejects", async () => {
    vi.useFakeTimers();
    try {
      const states: string[] = [];
      const host: any = {
        mode: "dashboard",
        refreshRuntimeGuard: vi.fn(async () => {
          throw new Error("repair failed");
        }),
      };
      const runtime = new TuiApiRuntime({
        request: vi.fn(),
        onConnectionStateChange: (state) => states.push(state),
      });
      host.tuiApiRuntime = runtime;

      scheduleTuiApiRecovery(host, { immediate: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(host.tuiApiRecoveryLastError).toBeInstanceOf(Error);
      expect(runtime.getConnectionState()).toBe("failed");
      expect(states).toEqual(["repairing", "failed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cooldowns repeated runtime guard recovery probes", async () => {
    vi.useFakeTimers();
    try {
      const host: any = {
        mode: "dashboard",
        refreshRuntimeGuard: vi.fn(async () => undefined),
      };

      scheduleTuiApiRecovery(host, { immediate: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(1);

      scheduleTuiApiRecovery(host, { immediate: true });
      await vi.advanceTimersByTimeAsync(TUI_API_RECOVERY_COOLDOWN_MS - 1);
      expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries pending recovery after an in-flight guard probe completes", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<void>();
      const host: any = {
        mode: "dashboard",
        refreshRuntimeGuard: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined),
      };

      scheduleTuiApiRecovery(host, { immediate: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(1);

      scheduleTuiApiRecovery(host, { immediate: true });
      first.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(TUI_API_RECOVERY_COOLDOWN_MS);

      expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries recovery after a guard probe rejects", async () => {
    vi.useFakeTimers();
    try {
      const host: any = {
        mode: "dashboard",
        refreshRuntimeGuard: vi.fn().mockRejectedValueOnce(new Error("probe failed")).mockResolvedValueOnce(undefined),
      };

      scheduleTuiApiRecovery(host, { immediate: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(TUI_API_RECOVERY_COOLDOWN_MS);
      expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(2);
      expect(host.tuiApiRecoveryLastError).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not consume recovery while an external guard probe is active", async () => {
    vi.useFakeTimers();
    try {
      const host: any = {
        mode: "dashboard",
        runtimeGuardProbing: true,
        refreshRuntimeGuard: vi.fn(async () => undefined),
      };

      scheduleTuiApiRecovery(host, { immediate: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(host.refreshRuntimeGuard).not.toHaveBeenCalled();
      expect(host.tuiApiLastRecoveryAt).toBeUndefined();
      expect(host.tuiApiRecoveryPending).toBe(true);

      host.runtimeGuardProbing = false;
      await vi.advanceTimersByTimeAsync(TUI_API_RECOVERY_DEBOUNCE_MS);

      expect(host.refreshRuntimeGuard).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let wrapper reads replace the default refresh transport", async () => {
    const host: any = {
      getFromProjectService: vi.fn(async () => ({ ok: true, value: "fallback" })),
    };
    const runtime = getOrCreateTuiApiRuntime(host);
    const request = vi.fn(async () => ({ ok: true, value: "transport" }));

    await expect(getJsonWithTuiApiRuntime(host, "/desktop-state", undefined, request)).resolves.toEqual({
      ok: true,
      value: "transport",
    });
    await expect(runtime.refreshJson("desktop-state", "/desktop-state", (value) => value)).resolves.toMatchObject({
      ok: true,
      value: { ok: true, value: "fallback" },
    });

    expect(host.getFromProjectService).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps concurrent wrapper read transports scoped to their call", async () => {
    const defaultRefresh = deferred<unknown>();
    const wrapperRead = deferred<unknown>();
    const host: any = {
      getFromProjectService: vi.fn(() => defaultRefresh.promise),
    };
    const runtime = getOrCreateTuiApiRuntime(host);
    const request = vi.fn(() => wrapperRead.promise);

    const refresh = runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    const read = getJsonWithTuiApiRuntime(host, "/desktop-state", undefined, request);

    wrapperRead.resolve({ ok: true, value: "wrapper" });
    await expect(read).resolves.toEqual({ ok: true, value: "wrapper" });
    defaultRefresh.resolve({ ok: true, value: "default" });
    await expect(refresh).resolves.toMatchObject({
      ok: true,
      value: { ok: true, value: "default" },
    });

    expect(host.getFromProjectService).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps wrapper mutations scoped while preserving the default mutation transport", async () => {
    const host: any = {
      getFromProjectService: vi.fn(async () => ({ ok: true })),
      postToProjectService: vi.fn(async (_path: string, body: unknown) => ({ ok: true, body })),
    };
    const runtime = getOrCreateTuiApiRuntime(host);
    const mutate = vi.fn(async () => ({ ok: true, value: "wrapper" }));

    await expect(
      postJsonWithTuiApiRuntime(host, "/agents/stop", { sessionId: "a" }, undefined, mutate),
    ).resolves.toEqual({
      ok: true,
      value: "wrapper",
    });
    await expect(runtime.mutateJson("/agents/stop", { sessionId: "b" }, (value) => value)).resolves.toMatchObject({
      ok: true,
      value: { ok: true, body: { sessionId: "b" } },
    });
    const opts = { timeoutMs: 10_000 };
    await expect(runtime.mutateJson("/agents/stop", { sessionId: "c" }, (value) => value, opts)).resolves.toMatchObject(
      {
        ok: true,
        value: { ok: true, body: { sessionId: "c" } },
      },
    );

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(host.postToProjectService).toHaveBeenCalledWith("/agents/stop", { sessionId: "b" });
    expect(host.postToProjectService).toHaveBeenCalledWith("/agents/stop", { sessionId: "c" }, opts);
  });

  it("blocks wrapper mutations while a critical resource is reconnecting", async () => {
    const host: any = {
      getFromProjectService: vi.fn(async () => ({ ok: true, sessions: [] })),
      postToProjectService: vi.fn(async () => ({ ok: true })),
    };
    const runtime = getOrCreateTuiApiRuntime(host);
    await runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    host.getFromProjectService.mockRejectedValue(Object.assign(new Error("offline"), { code: "ECONNREFUSED" }));
    await runtime.refreshJson("desktop-state", "/desktop-state", (value) => value, { supersede: true });
    const mutate = vi.fn(async () => ({ ok: true }));

    await expect(
      postJsonWithTuiApiRuntime(host, "/agents/stop", { sessionId: "a" }, undefined, mutate),
    ).rejects.toBeInstanceOf(TuiApiMutationBlockedError);
    expect(mutate).not.toHaveBeenCalled();
    expect(host.postToProjectService).not.toHaveBeenCalled();
  });

  it("bootstraps direct resource refreshes through the dashboard GET wrapper", async () => {
    const lowLevelRequest = vi.fn().mockResolvedValueOnce({ ok: true, value: "first" });
    const host: any = {
      getFromProjectService(path: string, opts?: { timeoutMs?: number }) {
        return getJsonWithTuiApiRuntime(host, path, opts, lowLevelRequest);
      },
    };
    const runtime = getOrCreateTuiApiRuntime(host);

    await expect(runtime.refreshJson("desktop-state", "/desktop-state", (value) => value)).resolves.toMatchObject({
      ok: true,
      value: { ok: true, value: "first" },
    });

    expect(lowLevelRequest).toHaveBeenCalledWith(host, "/desktop-state", undefined);
  });

  it("cancels scheduled recovery when the dashboard leaves dashboard mode", async () => {
    vi.useFakeTimers();
    try {
      const host: any = {
        mode: "dashboard",
        refreshRuntimeGuard: vi.fn(),
        getFromProjectService: vi.fn(async () => {
          throw new Error("offline");
        }),
      };
      const runtime = getOrCreateTuiApiRuntime(host);

      await expect(runtime.refreshJson("desktop-state", "/desktop-state", (value) => value)).resolves.toMatchObject({
        ok: false,
      });
      host.mode = "session";
      await vi.advanceTimersByTimeAsync(TUI_API_RECOVERY_DEBOUNCE_MS);

      expect(host.refreshRuntimeGuard).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an older superseded response overwrite a newer snapshot", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const runtime = new TuiApiRuntime({ request });

    const slow = runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    const fast = runtime.refreshJson("desktop-state", "/desktop-state", (value) => value, { supersede: true });

    second.resolve({ ok: true, value: 2 });
    await expect(fast).resolves.toMatchObject({ ok: true, value: { ok: true, value: 2 }, generation: 2 });
    first.resolve({ ok: true, value: 1 });
    await expect(slow).resolves.toMatchObject({ ok: false, value: { ok: true, value: 2 }, generation: 1 });

    expect(runtime.getSnapshot("desktop-state")).toMatchObject({
      value: { ok: true, value: 2 },
      generation: 2,
    });
  });

  it("ignores pending work after disposal", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn(() => pending.promise);
    const runtime = new TuiApiRuntime({ request });

    const refresh = runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    runtime.dispose();
    pending.resolve({ ok: true, value: 1 });

    await expect(refresh).resolves.toMatchObject({ ok: false, stale: true });
    expect(runtime.getConnectionState()).toBe("disposed");
    expect(runtime.getSnapshot("desktop-state")).toMatchObject({ pending: false });
  });

  it("ignores pending refresh failures after disposal", async () => {
    const pending = deferred<unknown>();
    const failures: unknown[] = [];
    const runtime = new TuiApiRuntime({
      request: vi.fn(() => pending.promise),
      onRequestFailure: (error) => failures.push(error),
    });

    const refresh = runtime.refreshJson("desktop-state", "/desktop-state", (value) => value);
    runtime.dispose();
    pending.reject(new Error("transport failed after teardown"));

    await expect(refresh).resolves.toEqual({ ok: false, value: undefined, stale: true, generation: 1 });
    expect(failures).toEqual([]);
    expect(runtime.getConnectionState()).toBe("disposed");
    expect(runtime.getSnapshot("desktop-state")).toMatchObject({ error: undefined, pending: false });
  });

  it("does not report direct read success after disposal", async () => {
    const pending = deferred<unknown>();
    const states: string[] = [];
    const runtime = new TuiApiRuntime({
      request: vi.fn(() => pending.promise),
      onConnectionStateChange: (state) => states.push(state),
    });

    const read = runtime.requestJson("/desktop-state", (value) => value);
    runtime.dispose();
    pending.resolve({ ok: true });

    await expect(read).resolves.toMatchObject({ ok: false, error: expect.any(Error) });
    expect(runtime.getConnectionState()).toBe("disposed");
    expect(states).toEqual(["disposed"]);
  });

  it("does not report mutation success after disposal", async () => {
    const pending = deferred<unknown>();
    const states: string[] = [];
    const runtime = new TuiApiRuntime({
      request: vi.fn(),
      mutate: vi.fn(() => pending.promise),
      onConnectionStateChange: (state) => states.push(state),
    });

    const mutate = runtime.mutateJson("/agents/stop", { sessionId: "codex-1" }, (value) => value);
    runtime.dispose();
    pending.resolve({ ok: true });

    await expect(mutate).resolves.toMatchObject({ ok: false, error: expect.any(Error) });
    expect(runtime.getConnectionState()).toBe("disposed");
    expect(states).toEqual(["disposed"]);
  });
});
