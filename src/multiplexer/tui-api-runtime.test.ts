import { describe, expect, it, vi } from "vitest";

import { TuiApiRuntime } from "./tui-api-runtime.js";

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
});
