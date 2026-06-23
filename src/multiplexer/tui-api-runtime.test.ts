import { describe, expect, it, vi } from "vitest";

import {
  getJsonWithTuiApiRuntime,
  getOrCreateTuiApiRuntime,
  postJsonWithTuiApiRuntime,
  TuiApiRuntime,
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
    expect(states).toContain("degraded");
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

  it("reports degraded state when a mutation fails", async () => {
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

    expect(states).toContain("degraded");
  });

  it("routes wrapper reads through the shared runtime transport", async () => {
    const host: any = {};
    const request = vi.fn(async () => ({ ok: true, value: 1 }));

    await expect(getJsonWithTuiApiRuntime(host, "/desktop-state", { timeoutMs: 5000 }, request)).resolves.toEqual({
      ok: true,
      value: 1,
    });

    expect(request).toHaveBeenCalledWith(host, "/desktop-state", { timeoutMs: 5000 });
    expect(host.tuiApiRuntime.getConnectionState()).toBe("connected");
  });

  it("keeps wrapper read failures thrown for existing callers", async () => {
    const host: any = {};
    const request = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(getJsonWithTuiApiRuntime(host, "/desktop-state", undefined, request)).rejects.toThrow("offline");

    expect(request).toHaveBeenCalledWith(host, "/desktop-state", undefined);
    expect(host.tuiApiConnectionState).toBe("degraded");
  });

  it("routes wrapper mutations through the shared runtime transport", async () => {
    const host: any = {};
    const mutate = vi.fn(async () => ({ ok: true, warning: "kept" }));

    await expect(
      postJsonWithTuiApiRuntime(host, "/agents/resume", { sessionId: "claude-1" }, { timeoutMs: 60_000 }, mutate),
    ).resolves.toEqual({ ok: true, warning: "kept" });

    expect(mutate).toHaveBeenCalledWith(host, "/agents/resume", { sessionId: "claude-1" }, { timeoutMs: 60_000 });
    expect(host.tuiApiRuntime.getConnectionState()).toBe("connected");
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
    expect(host.tuiApiConnectionState).toBe("degraded");
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
      ).rejects.toThrow("still offline");

      expect(host.refreshRuntimeGuard).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(25);
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
    await expect(
      runtime.mutateJson("/agents/stop", { sessionId: "c" }, (value) => value, opts),
    ).resolves.toMatchObject({
      ok: true,
      value: { ok: true, body: { sessionId: "c" } },
    });

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(host.postToProjectService).toHaveBeenCalledWith("/agents/stop", { sessionId: "b" });
    expect(host.postToProjectService).toHaveBeenCalledWith("/agents/stop", { sessionId: "c" }, opts);
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
      await vi.advanceTimersByTimeAsync(25);

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
