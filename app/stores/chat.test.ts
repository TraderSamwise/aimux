import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  applyOutputSnapshotAtom,
  ingestEventAtom,
  lastErrorFamily,
  outputBufferFamily,
  parsedOutputFamily,
} from "@/stores/chat";

describe("chat output store", () => {
  it("applies live-pane snapshots to the same state used by event streaming", () => {
    const store = createStore();
    const parsed = { blocks: [{ type: "message", text: "hello" }] };

    store.set(ingestEventAtom, { type: "error", sessionId: "agent-1", error: "stream lost" });
    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      output: "hello",
      parsed,
    });

    expect(store.get(outputBufferFamily("agent-1"))).toBe("hello");
    expect(store.get(parsedOutputFamily("agent-1"))).toBe(parsed);
    expect(store.get(lastErrorFamily("agent-1"))).toBeNull();
  });
});
