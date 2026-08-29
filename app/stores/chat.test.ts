import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  applyOutputSnapshotAtom,
  ingestEventAtom,
  transcriptFamily,
  lastErrorFamily,
  outputAnsiFamily,
  outputAvailableFamily,
  outputBufferFamily,
  transcriptStartLineFamily,
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

  it("does not clear terminal buffers when a chat-only snapshot omits output", () => {
    const store = createStore();
    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      output: "plain",
      outputAnsi: "\x1b[32mplain",
    });
    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      outputAnsi: undefined,
      messages: [message],
    });

    expect(store.get(transcriptFamily("agent-1"))).toEqual([message]);
    expect(store.get(outputBufferFamily("agent-1"))).toBe("plain");
    expect(store.get(outputAnsiFamily("agent-1"))).toBe("\x1b[32mplain");
    expect(store.get(outputAvailableFamily("agent-1"))).toBe(true);
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

  it("does not clear terminal buffers when a chat-only stream event omits output", () => {
    const store = createStore();
    store.set(ingestEventAtom, {
      type: "agent_output",
      sessionId: "agent-1",
      output: "plain",
      outputAnsi: "\x1b[32mplain",
      startLine: -120,
    });
    store.set(ingestEventAtom, {
      type: "agent_output",
      sessionId: "agent-1",
      startLine: -120,
      messages: [message],
    });

    expect(store.get(transcriptFamily("agent-1"))).toEqual([message]);
    expect(store.get(outputBufferFamily("agent-1"))).toBe("plain");
    expect(store.get(outputAnsiFamily("agent-1"))).toBe("\x1b[32mplain");
    expect(store.get(outputAvailableFamily("agent-1"))).toBe(true);
  });

  it("records terminal availability from a chat-only stream event", () => {
    const store = createStore();
    store.set(ingestEventAtom, {
      type: "agent_output",
      sessionId: "agent-1",
      startLine: -120,
      outputAvailable: true,
      messages: [message],
    });

    expect(store.get(transcriptFamily("agent-1"))).toEqual([message]);
    expect(store.get(outputBufferFamily("agent-1"))).toBe("");
    expect(store.get(outputAvailableFamily("agent-1"))).toBe(true);
  });

  it("keeps an expanded transcript window when a smaller snapshot arrives", () => {
    const store = createStore();
    const older = {
      ...message,
      id: "assistant:older",
      text: "older message",
      parts: [{ type: "text" as const, text: "older message" }],
      latest: undefined,
    };
    const newer = {
      ...message,
      id: "assistant:newer",
      text: "newer message",
      parts: [{ type: "text" as const, text: "newer message" }],
    };
    const newest = {
      ...message,
      id: "assistant:newest",
      text: "newest message",
      parts: [{ type: "text" as const, text: "newest message" }],
    };

    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      outputAnsi: undefined,
      outputAvailable: true,
      startLine: -640,
      messages: [older, newer],
    });
    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      outputAnsi: undefined,
      outputAvailable: true,
      startLine: -160,
      messages: [newer, newest],
    });

    expect(store.get(transcriptStartLineFamily("agent-1"))).toBe(-640);
    expect(store.get(transcriptFamily("agent-1")).map((item) => item.id)).toEqual([
      "assistant:older",
      "assistant:newer",
      "assistant:newest",
    ]);
  });

  it("merges smaller windows by sequence overlap when repeated-message ids shift", () => {
    const store = createStore();
    const repeatedA = {
      ...message,
      id: "assistant:same",
      text: "same",
      parts: [{ type: "text" as const, text: "same" }],
      latest: undefined,
    };
    const repeatedB = {
      ...message,
      id: "assistant:same#2",
      text: "same",
      parts: [{ type: "text" as const, text: "same" }],
    };
    const smallerWindowRepeatedB = {
      ...message,
      id: "assistant:same",
      text: "same",
      parts: [{ type: "text" as const, text: "same" }],
    };
    const newest = {
      ...message,
      id: "assistant:newest",
      text: "newest",
      parts: [{ type: "text" as const, text: "newest" }],
    };

    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      outputAnsi: undefined,
      outputAvailable: true,
      startLine: -640,
      messages: [repeatedA, repeatedB],
    });
    store.set(applyOutputSnapshotAtom, {
      sessionId: "agent-1",
      outputAnsi: undefined,
      outputAvailable: true,
      startLine: -160,
      messages: [smallerWindowRepeatedB, newest],
    });

    expect(store.get(transcriptFamily("agent-1")).map((item) => item.id)).toEqual([
      "assistant:same",
      "assistant:same",
      "assistant:newest",
    ]);
  });

  it("replaces the transcript when a wider stream event arrives", () => {
    const store = createStore();
    const tailOnly = {
      ...message,
      id: "assistant:tail",
      text: "tail",
      parts: [{ type: "text" as const, text: "tail" }],
    };
    const wider = {
      ...message,
      id: "assistant:wider",
      text: "wider",
      parts: [{ type: "text" as const, text: "wider" }],
    };

    store.set(ingestEventAtom, {
      type: "agent_output",
      sessionId: "agent-1",
      startLine: -160,
      messages: [tailOnly],
    });
    store.set(ingestEventAtom, {
      type: "agent_output",
      sessionId: "agent-1",
      startLine: -640,
      messages: [wider],
    });

    expect(store.get(transcriptStartLineFamily("agent-1"))).toBe(-640);
    expect(store.get(transcriptFamily("agent-1"))).toEqual([wider]);
  });
});
