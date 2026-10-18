import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { projectStateKey } from "@/lib/project-key";
import { agentActionsFamily } from "./agentActions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness(machineId = "host-a", sessionId = "agent-1") {
  const store = createStore();
  const scope = { projectStateKey: projectStateKey({ machineId, path: "/repo" }), sessionId };
  const actions = agentActionsFamily(scope);
  const request = vi.fn(async () => ({}));
  const onStarted = vi.fn();
  const onSucceeded = vi.fn();
  const onFailed = vi.fn();
  const input = { action: "resume" as const, request, onStarted, onSucceeded, onFailed };
  return { store, scope, actions, input, request, onStarted, onSucceeded, onFailed };
}

describe("agent row action state", () => {
  it("publishes loading on press before the request or response", async () => {
    const h = harness();
    const pending = deferred<Record<string, never>>();
    h.request.mockImplementation(() => {
      expect(h.store.get(h.actions)).toEqual({ busyAction: "resume", error: null });
      return pending.promise;
    });
    const operation = h.store.set(h.actions, h.input);
    expect(h.store.get(h.actions).busyAction).toBe("resume");
    expect(h.onSucceeded).not.toHaveBeenCalled();
    pending.resolve({});
    await operation;
    expect(h.onStarted).toHaveBeenCalledOnce();
    expect(h.onSucceeded).toHaveBeenCalledOnce();
    expect(h.store.get(h.actions)).toEqual({ busyAction: null, error: null });
  });

  it("makes same-turn double taps and a remounted row share one request", async () => {
    const h = harness();
    const pending = deferred<Record<string, never>>();
    h.request.mockReturnValue(pending.promise);
    const first = h.store.set(h.actions, h.input);
    const remounted = agentActionsFamily({ ...h.scope });
    const second = h.store.set(remounted, h.input);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.onStarted).toHaveBeenCalledOnce();
    pending.resolve({});
    await Promise.all([first, second]);
  });

  it.each([
    new Error("Network request failed: failed to fetch"),
    new Error("Relay not connected"),
    Object.assign(new Error("Request was cancelled"), { kind: "cancelled" }),
    new Error("Request timed out after 120000ms — may still be running, check first"),
    new Error("Cannot start agent-1; not enough memory"),
  ])("shows failed start reason: $message", async (error) => {
    const h = harness();
    h.request.mockRejectedValue(error);
    await h.store.set(h.actions, h.input);
    expect(h.store.get(h.actions)).toEqual({ busyAction: null, error: error.message });
    expect(h.onFailed).toHaveBeenCalledOnce();
    expect(h.onSucceeded).not.toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledOnce();
  });

  it("allows an explicit retry after failure and clears the prior error on press", async () => {
    const h = harness();
    h.request.mockRejectedValueOnce(new Error("offline"));
    await h.store.set(h.actions, h.input);
    const pending = deferred<Record<string, never>>();
    h.request.mockReturnValueOnce(pending.promise);
    const retry = h.store.set(h.actions, h.input);
    expect(h.store.get(h.actions)).toEqual({ busyAction: "resume", error: null });
    pending.resolve({});
    await retry;
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it("does not lock another agent or another machine's copy of the project", async () => {
    const h = harness();
    const pending = deferred<Record<string, never>>();
    h.request.mockReturnValue(pending.promise);
    const first = h.store.set(h.actions, h.input);
    for (const scope of [
      { ...h.scope, sessionId: "agent-2" },
      { ...h.scope, projectStateKey: projectStateKey({ machineId: "host-b", path: "/repo" }) },
    ]) {
      const independent = agentActionsFamily(scope);
      const request = vi.fn(async () => ({}));
      await h.store.set(independent, { ...h.input, request });
      expect(request).toHaveBeenCalledOnce();
    }
    expect(h.store.get(h.actions).busyAction).toBe("resume");
    pending.resolve({});
    await first;
  });

  it("reports an empty failure and releases the guard when transition setup throws", async () => {
    const h = harness();
    h.onStarted.mockImplementation(() => {
      throw new Error("");
    });
    await h.store.set(h.actions, h.input);
    expect(h.store.get(h.actions)).toEqual({
      busyAction: null,
      error: "Agent action failed. Check the project and try again.",
    });
    expect(h.request).not.toHaveBeenCalled();
  });
});
