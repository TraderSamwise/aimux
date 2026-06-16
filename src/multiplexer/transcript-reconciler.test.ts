import { describe, expect, it, vi } from "vitest";
import type { MetadataState } from "../metadata-store.js";
import type { RuntimeTopologySessionState } from "../runtime-core/topology-sessions.js";
import type { TranscriptProbe } from "../transcript-turn-state.js";
import { TranscriptReconciler } from "./transcript-reconciler.js";

function session(id: string, over: Partial<RuntimeTopologySessionState> = {}): RuntimeTopologySessionState {
  return {
    id,
    tool: "claude",
    toolConfigKey: "claude",
    command: "claude",
    args: [],
    status: "running",
    backendSessionId: "be-" + id,
    worktreePath: "/wt/" + id,
    ...over,
  };
}

function metadata(
  id: string,
  derived: Record<string, unknown>,
  context: Record<string, unknown> = { transcriptPath: "/t/" + id + ".jsonl" },
): MetadataState {
  return { version: 1, sessions: { [id]: { updatedAt: "now", derived, context } } } as MetadataState;
}

function makeReconciler(over: Partial<Parameters<typeof TranscriptReconciler>[0] extends never ? never : any> = {}) {
  const settleActivity = vi.fn();
  const clearStaleResponse = vi.fn();
  const deps = {
    loadMetadata: () => metadata("a", { activity: "running", attention: "normal" }),
    loadSessions: () => [session("a")],
    hasPendingInteraction: () => false,
    settleActivity,
    clearStaleResponse,
    probe: (_tool: string, _path: string): TranscriptProbe | null => ({ turn: "complete", size: 10, mtimeMs: 1 }),
    ...over,
  };
  return { reconciler: new TranscriptReconciler(deps), settleActivity, clearStaleResponse, deps };
}

describe("TranscriptReconciler — stuck working", () => {
  it("settles only after the transcript is complete AND quiescent across two ticks", () => {
    const { reconciler, settleActivity } = makeReconciler();
    reconciler.scan(); // first observation: complete, but unconfirmed
    expect(settleActivity).not.toHaveBeenCalled();
    reconciler.scan(); // same size/mtime -> confirmed quiescent
    expect(settleActivity).toHaveBeenCalledWith("a");
  });

  it("does not settle while the transcript is still being written (size changes)", () => {
    let size = 10;
    const { reconciler, settleActivity } = makeReconciler({
      probe: () => ({ turn: "complete" as const, size: size++, mtimeMs: size }),
    });
    reconciler.scan();
    reconciler.scan();
    reconciler.scan();
    expect(settleActivity).not.toHaveBeenCalled();
  });

  it("never settles a mid-turn (in_progress) transcript", () => {
    const { reconciler, settleActivity } = makeReconciler({
      probe: () => ({ turn: "in_progress" as const, size: 10, mtimeMs: 1 }),
    });
    reconciler.scan();
    reconciler.scan();
    expect(settleActivity).not.toHaveBeenCalled();
  });

  it("ignores a genuinely idle agent (activity not running/waiting)", () => {
    const { reconciler, settleActivity } = makeReconciler({
      loadMetadata: () => metadata("a", { activity: "idle", attention: "normal" }),
    });
    reconciler.scan();
    reconciler.scan();
    expect(settleActivity).not.toHaveBeenCalled();
  });

  it("does not touch a needs_input agent (attention not normal)", () => {
    const { reconciler, settleActivity } = makeReconciler({
      loadMetadata: () => metadata("a", { activity: "waiting", attention: "needs_input" }),
    });
    reconciler.scan();
    reconciler.scan();
    expect(settleActivity).not.toHaveBeenCalled();
  });

  it("settles a stuck waiting+normal agent (decoupled pair) too", () => {
    const { reconciler, settleActivity } = makeReconciler({
      loadMetadata: () => metadata("a", { activity: "waiting", attention: "normal" }),
    });
    reconciler.scan();
    reconciler.scan();
    expect(settleActivity).toHaveBeenCalledWith("a");
  });

  it("skips sessions with no resolvable transcript path", () => {
    const probe = vi.fn(() => ({ turn: "complete" as const, size: 10, mtimeMs: 1 }));
    const { reconciler, settleActivity } = makeReconciler({
      probe,
      loadMetadata: () => metadata("a", { activity: "running", attention: "normal" }, {}),
      loadSessions: () => [session("a", { backendSessionId: undefined })],
    });
    reconciler.scan();
    reconciler.scan();
    expect(probe).not.toHaveBeenCalled();
    expect(settleActivity).not.toHaveBeenCalled();
  });
});

describe("TranscriptReconciler — codex path cache", () => {
  it("caches the resolved codex path while live and re-resolves after the session leaves", () => {
    const findCodexPath = vi.fn(() => "/codex/x.jsonl");
    let live = true;
    const { reconciler } = makeReconciler({
      findCodexPath,
      loadMetadata: () => metadata("a", { activity: "running", attention: "normal" }, {}),
      loadSessions: () => (live ? [session("a", { toolConfigKey: "codex", backendSessionId: "be" })] : []),
      probe: () => ({ turn: "in_progress" as const, size: 10, mtimeMs: 1 }),
    });
    reconciler.scan();
    reconciler.scan();
    expect(findCodexPath).toHaveBeenCalledTimes(1); // cached across ticks
    live = false;
    reconciler.scan(); // session gone -> cache pruned
    live = true;
    reconciler.scan();
    expect(findCodexPath).toHaveBeenCalledTimes(2); // re-resolved after returning
  });
});

describe("TranscriptReconciler — stranded needs_response", () => {
  it("clears needs_response when no live interaction remains", () => {
    const { reconciler, clearStaleResponse } = makeReconciler({
      loadMetadata: () => metadata("a", { activity: "idle", attention: "needs_response" }),
      hasPendingInteraction: () => false,
    });
    reconciler.scan();
    expect(clearStaleResponse).toHaveBeenCalledWith("a");
  });

  it("leaves needs_response alone while an interaction is still pending", () => {
    const { reconciler, clearStaleResponse } = makeReconciler({
      loadMetadata: () => metadata("a", { activity: "idle", attention: "needs_response" }),
      hasPendingInteraction: () => true,
    });
    reconciler.scan();
    expect(clearStaleResponse).not.toHaveBeenCalled();
  });
});
