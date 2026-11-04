import { createStore } from "jotai";
import { agentStateKey, projectStateKey } from "@/lib/project-key";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyOutputSnapshotAtom,
  activityFamily,
  clearLocalInterruptHoldAtom,
  ingestEventAtom,
  markOutputInterruptedAtom,
  transcriptFamily,
  lastErrorFamily,
  outputAnsiFamily,
  outputAvailableFamily,
  outputBufferFamily,
  paneSelectionFamily,
  activityTextFamily,
  transcriptStartLineFamily,
} from "@/stores/chat";

describe("chat output store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies live-pane snapshots to the same state used by event streaming", () => {
    const store = createStore();

    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: { type: "error", sessionId: "agent-1", error: "stream lost" },
    });
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      output: "hello",
      outputAnsi: undefined,
      paneState: undefined,
      messages: [],
    });

    expect(store.get(outputBufferFamily(agentKey("agent-1")))).toBe("hello");
    expect(store.get(lastErrorFamily(agentKey("agent-1")))).toBeNull();
  });

  it("surfaces tmux-unavailable snapshots as transcript errors", () => {
    const store = createStore();

    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: undefined,
      tmuxUnavailable: { ok: false, error: "tmux capture-pane timed out after 2s" },
    });

    expect(store.get(lastErrorFamily(agentKey("agent-1")))).toBe(
      "tmux capture-pane timed out after 2s",
    );

    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      output: "",
      outputAnsi: undefined,
      paneState: undefined,
      messages: [],
    });

    expect(store.get(lastErrorFamily(agentKey("agent-1")))).toBeNull();
  });

  it("keeps a local interrupt visible through stale running snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    const store = createStore();

    store.set(markOutputInterruptedAtom, agentKey("agent-1"));
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: undefined,
      activity: "running",
      activityText: "Working...",
    });

    expect(store.get(activityFamily(agentKey("agent-1")))).toBe("interrupted");
    expect(store.get(activityTextFamily(agentKey("agent-1")))).toBe("");
  });

  it("keeps a local interrupt visible through full snapshots that omit activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    const store = createStore();

    store.set(markOutputInterruptedAtom, agentKey("agent-1"));
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      output: "stale output",
      outputAnsi: undefined,
      paneState: undefined,
    });

    expect(store.get(outputBufferFamily(agentKey("agent-1")))).toBe("stale output");
    expect(store.get(activityFamily(agentKey("agent-1")))).toBe("interrupted");
    expect(store.get(activityTextFamily(agentKey("agent-1")))).toBe("");
  });

  it("accepts explicit non-running state during the local interrupt hold", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    const store = createStore();

    store.set(markOutputInterruptedAtom, agentKey("agent-1"));
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: undefined,
      activity: "done",
      activityText: "",
    });

    expect(store.get(activityFamily(agentKey("agent-1")))).toBe("done");
    expect(store.get(activityTextFamily(agentKey("agent-1")))).toBe("");
  });

  it("accepts running snapshots after the local interrupt hold is cleared", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    const store = createStore();

    store.set(markOutputInterruptedAtom, agentKey("agent-1"));
    store.set(clearLocalInterruptHoldAtom, agentKey("agent-1"));
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: undefined,
      activity: "running",
      activityText: "Working...",
    });

    expect(store.get(activityFamily(agentKey("agent-1")))).toBe("running");
    expect(store.get(activityTextFamily(agentKey("agent-1")))).toBe("Working...");
  });

  it("accepts running snapshots after the local interrupt hold expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    const store = createStore();

    store.set(markOutputInterruptedAtom, agentKey("agent-1"));
    vi.advanceTimersByTime(5_001);
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: undefined,
      activity: "running",
      activityText: "Working...",
    });

    expect(store.get(activityFamily(agentKey("agent-1")))).toBe("running");
    expect(store.get(activityTextFamily(agentKey("agent-1")))).toBe("Working...");
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
      agentStateKey: agentKey("agent-1"),
      output: "Published events: 21",
      outputAnsi: undefined,
      paneState: undefined,
      messages: [message],
    });

    expect(store.get(transcriptFamily(agentKey("agent-1")))).toEqual([message]);
  });

  it("empties rather than going stale when a snapshot carries none", () => {
    const store = createStore();
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      output: "one",
      outputAnsi: undefined,
      paneState: undefined,
      messages: [message],
    });
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      output: "two",
      outputAnsi: undefined,
      paneState: undefined,
    });

    expect(store.get(transcriptFamily(agentKey("agent-1")))).toEqual([]);
  });

  it("keeps the coloured pane when the service sends one", () => {
    const store = createStore();
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      output: "plain",
      outputAnsi: "\x1b[31mplain",
      paneState: undefined,
    });

    expect(store.get(outputAnsiFamily(agentKey("agent-1")))).toBe("\x1b[31mplain");
    expect(store.get(outputBufferFamily(agentKey("agent-1")))).toBe("plain");
  });

  it("falls back to the uncoloured pane against a service too old to send one", () => {
    const store = createStore();
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      output: "plain",
      outputAnsi: undefined,
      paneState: undefined,
    });

    expect(store.get(outputAnsiFamily(agentKey("agent-1")))).toBe("plain");
  });

  it("does not clear terminal buffers when a chat-only snapshot omits output", () => {
    const store = createStore();
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      output: "plain",
      outputAnsi: "\x1b[32mplain",
      paneState: undefined,
    });
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: undefined,
      messages: [message],
    });

    expect(store.get(transcriptFamily(agentKey("agent-1")))).toEqual([message]);
    expect(store.get(outputBufferFamily(agentKey("agent-1")))).toBe("plain");
    expect(store.get(outputAnsiFamily(agentKey("agent-1")))).toBe("\x1b[32mplain");
    expect(store.get(outputAvailableFamily(agentKey("agent-1")))).toBe(true);
  });

  it("takes them from a stream event too", () => {
    const store = createStore();
    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        output: "Published events: 21",
        outputAnsi: "\x1b[32mPublished events: 21",
        startLine: -120,
        messages: [message],
      },
    });

    expect(store.get(transcriptFamily(agentKey("agent-1")))).toEqual([message]);
    expect(store.get(outputAnsiFamily(agentKey("agent-1")))).toBe("\x1b[32mPublished events: 21");
  });

  it("does not clear terminal buffers when a chat-only stream event omits output", () => {
    const store = createStore();
    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        output: "plain",
        outputAnsi: "\x1b[32mplain",
        startLine: -120,
      },
    });
    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        startLine: -120,
        messages: [message],
      },
    });

    expect(store.get(transcriptFamily(agentKey("agent-1")))).toEqual([message]);
    expect(store.get(outputBufferFamily(agentKey("agent-1")))).toBe("plain");
    expect(store.get(outputAnsiFamily(agentKey("agent-1")))).toBe("\x1b[32mplain");
    expect(store.get(outputAvailableFamily(agentKey("agent-1")))).toBe(true);
  });

  it("records terminal availability from a chat-only stream event", () => {
    const store = createStore();
    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        startLine: -120,
        outputAvailable: true,
        messages: [message],
      },
    });

    expect(store.get(transcriptFamily(agentKey("agent-1")))).toEqual([message]);
    expect(store.get(outputBufferFamily(agentKey("agent-1")))).toBe("");
    expect(store.get(outputAvailableFamily(agentKey("agent-1")))).toBe(true);
  });

  it("keeps activity text when a sparse stream event omits it", () => {
    const store = createStore();
    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        output: "work",
        outputAnsi: undefined,
        paneState: undefined,
        startLine: -120,
        activity: "running",
        activityText: "Working... (3s)",
      },
    });
    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        startLine: -120,
        messages: [message],
      },
    });

    expect(store.get(activityTextFamily(agentKey("agent-1")))).toBe("Working... (3s)");
  });

  it("clears activity text when a stream event explicitly sends empty text", () => {
    const store = createStore();
    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        output: "work",
        outputAnsi: undefined,
        paneState: undefined,
        startLine: -120,
        activity: "running",
        activityText: "Working... (3s)",
      },
    });
    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        startLine: -120,
        activityText: "",
      },
    });

    expect(store.get(activityTextFamily(agentKey("agent-1")))).toBe("");
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
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: undefined,
      outputAvailable: true,
      startLine: -640,
      messages: [older, newer],
    });
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: undefined,
      outputAvailable: true,
      startLine: -160,
      messages: [newer, newest],
    });

    expect(store.get(transcriptStartLineFamily(agentKey("agent-1")))).toBe(-640);
    expect(store.get(transcriptFamily(agentKey("agent-1"))).map((item) => item.id)).toEqual([
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
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: undefined,
      outputAvailable: true,
      startLine: -640,
      messages: [repeatedA, repeatedB],
    });
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: undefined,
      outputAvailable: true,
      startLine: -160,
      messages: [smallerWindowRepeatedB, newest],
    });

    expect(store.get(transcriptFamily(agentKey("agent-1"))).map((item) => item.id)).toEqual([
      "assistant:same",
      "assistant:same",
      "assistant:newest",
    ]);
  });

  it("does not rewrite settled same-window messages after compaction changes projection gaps", () => {
    const store = createStore();
    const summary = {
      ...message,
      id: "assistant:summary",
      text: "Compact summary",
      parts: [{ type: "text" as const, text: "Compact summary" }],
      latest: undefined,
    };
    const connectivityProbe = {
      ...message,
      id: "assistant:probe",
      text: 'Searching for 2 patterns\ncurl /supabase {"query":"select 1;"}',
      parts: [
        {
          type: "text" as const,
          text: 'Searching for 2 patterns\ncurl /supabase {"query":"select 1;"}',
        },
      ],
      latest: undefined,
    };
    const differentToolCall = {
      ...message,
      id: "assistant:query",
      text: 'Searching for 2 patterns\ncurl /supabase {"query":"select slug, name from table;"}',
      parts: [
        {
          type: "text" as const,
          text: 'Searching for 2 patterns\ncurl /supabase {"query":"select slug, name from table;"}',
        },
      ],
      latest: undefined,
    };
    const prompt = {
      ...message,
      id: "user:prompt",
      role: "user" as const,
      text: "next prompt after compact",
      parts: [{ type: "text" as const, text: "next prompt after compact" }],
    };

    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        startLine: -160,
        messages: [summary, connectivityProbe, prompt],
      },
    });
    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        startLine: -160,
        messages: [summary, differentToolCall, prompt],
      },
    });
    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        startLine: -160,
        messages: [summary, prompt],
      },
    });

    expect(store.get(transcriptFamily(agentKey("agent-1"))).map((item) => item.text)).toEqual([
      "Compact summary",
      'Searching for 2 patterns\ncurl /supabase {"query":"select 1;"}',
      "next prompt after compact",
    ]);
  });

  it("still lets a same-window latest message complete", () => {
    const store = createStore();
    const prompt = {
      ...message,
      id: "user:prompt",
      role: "user" as const,
      text: "run the query",
      parts: [{ type: "text" as const, text: "run the query" }],
      latest: undefined,
    };
    const partial = {
      ...message,
      id: "assistant:partial",
      text: "Searching for 2 patterns...",
      parts: [{ type: "text" as const, text: "Searching for 2 patterns..." }],
      latest: true as const,
    };
    const completed = {
      ...message,
      id: "assistant:complete",
      text: "Searching for 2 patterns...\nDone.",
      parts: [{ type: "text" as const, text: "Searching for 2 patterns...\nDone." }],
      latest: undefined,
    };
    const nextPrompt = {
      ...message,
      id: "user:next",
      role: "user" as const,
      text: "next prompt",
      parts: [{ type: "text" as const, text: "next prompt" }],
      latest: true as const,
    };

    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        startLine: -160,
        messages: [prompt, partial],
      },
    });
    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        startLine: -160,
        messages: [prompt, completed, nextPrompt],
      },
    });

    expect(store.get(transcriptFamily(agentKey("agent-1"))).map((item) => item.text)).toEqual([
      "run the query",
      "Searching for 2 patterns...\nDone.",
      "next prompt",
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
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        startLine: -160,
        messages: [tailOnly],
      },
    });
    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        startLine: -640,
        messages: [wider],
      },
    });

    expect(store.get(transcriptStartLineFamily(agentKey("agent-1")))).toBe(-640);
    expect(store.get(transcriptFamily(agentKey("agent-1")))).toEqual([wider]);
  });

  it("clears stale activity text when a snapshot explicitly sends an empty label", () => {
    const store = createStore();
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: undefined,
      activity: "running",
      activityText: "Perambulating...",
    });

    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: undefined,
      activity: "interrupted",
      activityText: "",
    });

    expect(store.get(activityTextFamily(agentKey("agent-1")))).toBe("");
  });

  it("holds the chooser the service read, and drops it once the pane stops showing one", () => {
    const store = createStore();
    const selection = {
      question: "Do you want to create hello.txt?",
      options: [
        { number: 1, label: "Yes", selected: true },
        { number: 3, label: "No", selected: false },
      ],
    };

    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: { ...IDLE_PANE, selection },
    });
    expect(store.get(paneSelectionFamily(agentKey("agent-1")))).toEqual(selection);

    // The answered chooser. `paneState` arrives on every read, so the control
    // has to go away on the one after the answer — a chooser still on screen
    // is a control that answers nothing.
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: IDLE_PANE,
    });
    expect(store.get(paneSelectionFamily(agentKey("agent-1")))).toBeUndefined();
  });

  it("leaves the chooser alone when a service too old to project one sends nothing", () => {
    const store = createStore();
    const selection = { options: [{ label: "No, exit", selected: true }] };

    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: { ...IDLE_PANE, selection },
    });
    // Absent `paneState` is "this service does not say", not "no chooser".
    // Clearing on it would clear on every poll and the control could never
    // render against an older daemon mid-upgrade.
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      paneState: undefined,
    });

    expect(store.get(paneSelectionFamily(agentKey("agent-1")))).toEqual(selection);
  });

  it("carries the chooser in from the event stream too", () => {
    const store = createStore();
    const selection = {
      options: [
        { number: 1, label: "Yes", selected: true },
        { number: 2, label: "No", selected: false },
      ],
    };

    store.set(ingestEventAtom, {
      projectStateKey: TEST_PROJECT_KEY,
      event: {
        type: "agent_output",
        sessionId: "agent-1",
        startLine: 0,
        output: "pane",
        messages: [],
        paneState: { ...IDLE_PANE, selection },
      },
    });

    expect(store.get(paneSelectionFamily(agentKey("agent-1")))).toEqual(selection);
  });
});

const IDLE_PANE = {
  promptVisible: true,
  errorVisible: false,
  interruptedVisible: false,
  updatePromptVisible: false,
};

// One project on one machine, so these tests key an agent the way the app does.
const TEST_PROJECT_KEY = projectStateKey({ machineId: "mbp", path: "/repo" });

// One project on one machine, so these tests key an agent the way the app does.
function agentKey(sessionId: string) {
  return agentStateKey(TEST_PROJECT_KEY, sessionId);
}
