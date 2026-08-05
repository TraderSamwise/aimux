import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  applyOutputSnapshotAtom,
  ingestEventAtom,
  transcriptFamily,
  lastErrorFamily,
  outputBufferFamily,
} from "@/stores/chat";

describe("chat output store", () => {
  it("applies live-pane snapshots to the same state used by event streaming", () => {
    const store = createStore();

    store.set(ingestEventAtom, { type: "error", sessionId: "agent-1", error: "stream lost" });
    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      output: "hello",
      messages: [],
    });

    expect(store.get(outputBufferFamily("agent-1"))).toBe("hello");
    expect(store.get(lastErrorFamily("agent-1"))).toBeNull();
  });
});

describe("the projected transcript", () => {
  const message = {
    id: "assistant:abc123",
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: "Published events: 21" }],
    text: "Published events: 21",
    latest: true as const,
  };

  it("takes the messages the service projected", () => {
    const store = createStore();
    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      output: "Published events: 21",
      messages: [message],
    });

    expect(store.get(transcriptFamily("agent-1"))).toEqual([message]);
  });

  it("empties rather than going stale when a snapshot carries none", () => {
    const store = createStore();
    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      output: "one",
      messages: [message],
    });
    store.set(applyOutputSnapshotAtom, { sessionId: "agent-1", output: "two" });

    expect(store.get(transcriptFamily("agent-1"))).toEqual([]);
  });

  it("takes them from a stream event too", () => {
    const store = createStore();
    store.set(ingestEventAtom, {
      type: "agent_output",
      sessionId: "agent-1",
      output: "Published events: 21",
      startLine: -120,
      messages: [message],
    });

    expect(store.get(transcriptFamily("agent-1"))).toEqual([message]);
  });
});
