import { describe, expect, it } from "vitest";

import {
  LifecycleMutationConflictError,
  LifecycleMutationQueue,
  LifecycleMutationQueueFullError,
  lifecycleOk,
  waitForEarlyLifecycleResult,
  type LifecycleTransitionInput,
} from "./lifecycle-mutation-queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function transition(targetId: string): LifecycleTransitionInput {
  return {
    operation: "agent.stop",
    targetKind: "agent",
    targetId,
  };
}

describe("LifecycleMutationQueue", () => {
  it("runs lifecycle mutations serially and tracks diagnostics", async () => {
    const firstBlocker = deferred<void>();
    const queue = new LifecycleMutationQueue({ projectRoot: () => "/repo" });
    const events: string[] = [];

    const first = queue.enqueue(async () => {
      events.push("first:start");
      await firstBlocker.promise;
      events.push("first:end");
      return "first";
    }, transition("one"));
    const second = queue.enqueue(() => {
      events.push("second:start");
      return "second";
    }, transition("two"));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first:start"]);
    expect(queue.diagnostics()).toMatchObject({
      ok: true,
      projectRoot: "/repo",
      queuedCount: 2,
      queueLimit: 32,
      telemetry: { enqueued: 2, started: 1, maxQueuedCount: 2 },
    });

    firstBlocker.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(queue.diagnostics()).toMatchObject({
      queuedCount: 0,
      activeTargets: [],
      telemetry: { enqueued: 2, started: 2, succeeded: 2, failed: 0, released: 2 },
    });
  });

  it("rejects concurrent mutations for the same lifecycle target", async () => {
    const blocker = deferred<void>();
    const queue = new LifecycleMutationQueue({ projectRoot: () => "/repo" });
    const first = queue.enqueue(() => blocker.promise, transition("same"));

    expect(() => queue.enqueue(() => "ignored", transition("same"))).toThrow(LifecycleMutationConflictError);
    expect(queue.diagnostics()).toMatchObject({
      queuedCount: 1,
      telemetry: { rejectedConflicts: 1 },
    });

    blocker.resolve();
    await first;
  });

  it("rejects transition-backed work over the queue limit", async () => {
    const blocker = deferred<void>();
    const queue = new LifecycleMutationQueue({ queueLimit: 1, projectRoot: () => "/repo" });
    const first = queue.enqueue(() => blocker.promise, transition("one"));

    expect(() => queue.enqueue(() => "ignored", transition("two"))).toThrow(LifecycleMutationQueueFullError);
    expect(queue.diagnostics()).toMatchObject({
      queuedCount: 1,
      queueLimit: 1,
      telemetry: { rejectedQueueFull: 1 },
    });

    blocker.resolve();
    await first;
  });

  it("records failed lifecycle mutations and exposes user-facing errors", async () => {
    const queue = new LifecycleMutationQueue({ projectRoot: () => "/repo" });

    await expect(queue.enqueue(() => Promise.reject(new Error("boom")), transition("failed"))).rejects.toThrow("boom");
    expect(queue.diagnostics()).toMatchObject({
      queuedCount: 0,
      telemetry: { failed: 1, released: 1, lastError: "boom" },
    });
  });
});

describe("lifecycle helpers", () => {
  it("wraps lifecycle-ok responses with transition metadata", () => {
    const result = lifecycleOk({ sessionId: "codex-one" }, transition("codex-one"));

    expect(result).toMatchObject({
      ok: true,
      sessionId: "codex-one",
      transition: {
        operation: "agent.stop",
        targetKind: "agent",
        targetId: "codex-one",
        phase: "succeeded",
      },
    });
    expect(result.transition.operationId).toContain("agent.stop:codex-one:");
  });

  it("returns early when lifecycle work is still pending", async () => {
    const pending = await waitForEarlyLifecycleResult(new Promise(() => {}), 1);

    expect(pending).toEqual({ kind: "pending" });
  });

  it("returns early resolved and rejected lifecycle outcomes", async () => {
    await expect(waitForEarlyLifecycleResult(Promise.resolve("ok"))).resolves.toEqual({
      kind: "resolved",
      result: "ok",
    });
    const error = new Error("failed");
    await expect(waitForEarlyLifecycleResult(Promise.reject(error))).resolves.toEqual({
      kind: "rejected",
      error,
    });
  });
});
