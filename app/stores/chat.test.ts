import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  applyOutputSnapshotAtom,
  ingestEventAtom,
  transcriptFamily,
  lastErrorFamily,
  outputAnsiFamily,
  outputBufferFamily,
} from "@/stores/chat";

describe("chat output store", () => {
  it("applies live-pane snapshots to the same state used by event streaming", () => {
    const store = createStore();

    store.set(ingestEventAtom, { type: "error", sessionId: "agent-1", error: "stream lost" });
    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      output: "hello",
      outputAnsi: undefined,
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
      outputAnsi: undefined,
      messages: [message],
    });

    expect(store.get(transcriptFamily("agent-1"))).toEqual([message]);
  });

  it("empties rather than going stale when a snapshot carries none", () => {
    const store = createStore();
    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      output: "one",
      outputAnsi: undefined,
      messages: [message],
    });
    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      output: "two",
      outputAnsi: undefined,
    });

    expect(store.get(transcriptFamily("agent-1"))).toEqual([]);
  });

  it("keeps the coloured pane when the service sends one", () => {
    const store = createStore();
    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      output: "plain",
      outputAnsi: "\x1b[31mplain",
    });

    expect(store.get(outputAnsiFamily("agent-1"))).toBe("\x1b[31mplain");
    expect(store.get(outputBufferFamily("agent-1"))).toBe("plain");
  });

  it("falls back to the uncoloured pane against a service too old to send one", () => {
    const store = createStore();
    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      output: "plain",
      outputAnsi: undefined,
    });

    expect(store.get(outputAnsiFamily("agent-1"))).toBe("plain");
  });

  it("takes them from a stream event too", () => {
    const store = createStore();
    store.set(ingestEventAtom, {
      type: "agent_output",
      sessionId: "agent-1",
      output: "Published events: 21",
      outputAnsi: "\x1b[32mPublished events: 21",
      startLine: -120,
      messages: [message],
    });

    expect(store.get(transcriptFamily("agent-1"))).toEqual([message]);
    expect(store.get(outputAnsiFamily("agent-1"))).toBe("\x1b[32mPublished events: 21");
  });
});
