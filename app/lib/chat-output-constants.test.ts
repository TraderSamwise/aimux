import { createStore } from "jotai";
import { agentStateKey, projectStateKey } from "@/lib/project-key";
import { describe, expect, it } from "vitest";

import {
  CHAT_OUTPUT_CAPTURE_START_LINE,
  CHAT_OUTPUT_INITIAL_CAPTURE_START_LINE,
  CHAT_HISTORY_PAGE_FAILURE_LIMIT,
  CHAT_OUTPUT_MAX_CAPTURE_START_LINE,
  chatHistoryPageOutcome,
  chatHistoryPagingAllowed,
  chatHistorySeedStartLine,
  chatOutputHistoryStartLineForScroll,
  nextChatOutputCaptureStartLine,
} from "./chat-output-constants";
import {
  applyOutputSnapshotAtom,
  transcriptFamily,
  transcriptStartLineFamily,
} from "@/stores/chat";
import type { AgentTranscriptMessage } from "../../src/agent-transcript-contract";

function message(id: string, text: string): AgentTranscriptMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
    text,
  };
}

describe("chat output history pagination", () => {
  it("requests an older capture window near the top and applies the wider snapshot", () => {
    const requestedStartLine = chatOutputHistoryStartLineForScroll({
      currentStartLine: CHAT_OUTPUT_CAPTURE_START_LINE,
      metrics: {
        contentHeight: 3200,
        offsetY: 24,
        viewportHeight: 720,
      },
    });

    expect(requestedStartLine).toBe(nextChatOutputCaptureStartLine(CHAT_OUTPUT_CAPTURE_START_LINE));

    const store = createStore();
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      outputAvailable: true,
      startLine: CHAT_OUTPUT_CAPTURE_START_LINE,
      messages: [message("assistant:newer", "newer message")],
    });
    store.set(applyOutputSnapshotAtom, {
      agentStateKey: agentKey("agent-1"),
      outputAnsi: undefined,
      outputAvailable: true,
      startLine: requestedStartLine ?? undefined,
      messages: [
        message("assistant:older", "older message"),
        message("assistant:newer", "newer message"),
      ],
    });

    expect(store.get(transcriptStartLineFamily(agentKey("agent-1")))).toBe(requestedStartLine);
    expect(store.get(transcriptFamily(agentKey("agent-1"))).map((item) => item.id)).toEqual([
      "assistant:older",
      "assistant:newer",
    ]);
  });

  it("does not request history away from the top, while pending, or past the capture floor", () => {
    expect(
      chatOutputHistoryStartLineForScroll({
        currentStartLine: CHAT_OUTPUT_CAPTURE_START_LINE,
        metrics: { contentHeight: 3200, offsetY: 240, viewportHeight: 720 },
      }),
    ).toBeNull();
    expect(
      chatOutputHistoryStartLineForScroll({
        currentStartLine: CHAT_OUTPUT_CAPTURE_START_LINE,
        metrics: { contentHeight: 3200, offsetY: 24, viewportHeight: 720 },
        pendingStartLine: -480,
      }),
    ).toBeNull();
    expect(
      chatOutputHistoryStartLineForScroll({
        currentStartLine: CHAT_OUTPUT_MAX_CAPTURE_START_LINE,
        metrics: { contentHeight: 3200, offsetY: 24, viewportHeight: 720 },
      }),
    ).toBeNull();
  });
});

// One project on one machine, so these tests key an agent the way the app does.
const TEST_PROJECT_KEY = projectStateKey({ machineId: "mbp", path: "/repo" });

// One project on one machine, so these tests key an agent the way the app does.
function agentKey(sessionId: string) {
  return agentStateKey(TEST_PROJECT_KEY, sessionId);
}

describe("what a requested history page means for the cursor", () => {
  it("does not move the cursor when nothing was served", () => {
    // The case the whole item is about: a shared chat or a down service makes
    // `refreshOutputSnapshot` answer without asking, and the cursor used to
    // advance anyway -- walking from the initial window to the floor with zero
    // network calls.
    expect(
      chatHistoryPageOutcome({
        currentStartLine: CHAT_OUTPUT_INITIAL_CAPTURE_START_LINE,
        appliedStartLine: undefined,
      }),
    ).toEqual({ kind: "not-served" });
  });

  it("follows what the service served, not what was asked for", () => {
    // A service clamps the request to its own capture limit. Advancing to the
    // REQUESTED depth is how every later page came to ask for a window
    // nothing would ever serve.
    expect(
      chatHistoryPageOutcome({
        currentStartLine: CHAT_OUTPUT_INITIAL_CAPTURE_START_LINE,
        appliedStartLine: -800,
      }),
    ).toEqual({ kind: "advanced", startLine: -800 });
  });

  it("reads a page that goes no deeper as the real floor", () => {
    // The constant floor is only this view's own bound. The service has one of
    // its own and cannot be asked for it, so asking and learning there is no
    // more is the only honest signal.
    expect(
      chatHistoryPageOutcome({
        currentStartLine: -800,
        appliedStartLine: -800,
      }),
    ).toEqual({ kind: "no-deeper-history" });
  });

  it("never walks the cursor back towards the live window", () => {
    expect(
      chatHistoryPageOutcome({
        currentStartLine: CHAT_OUTPUT_MAX_CAPTURE_START_LINE,
        appliedStartLine: CHAT_OUTPUT_INITIAL_CAPTURE_START_LINE,
      }),
    ).toEqual({ kind: "no-deeper-history" });
  });
});

describe("the pager's failure brake", () => {
  it("keeps asking while failures are few", () => {
    for (let failures = 0; failures < CHAT_HISTORY_PAGE_FAILURE_LIMIT; failures += 1) {
      expect(chatHistoryPagingAllowed(failures)).toBe(true);
    }
  });

  it("stops asking once they are not", () => {
    // Holding the cursor still removes the accidental brake the old bug
    // provided, so one request per scroll event against a failing service
    // would run forever.
    expect(chatHistoryPagingAllowed(CHAT_HISTORY_PAGE_FAILURE_LIMIT)).toBe(false);
    expect(chatHistoryPagingAllowed(CHAT_HISTORY_PAGE_FAILURE_LIMIT + 10)).toBe(false);
  });
});

describe("a page that races the live stream", () => {
  it("still counts, because the served line does not come from the store", () => {
    // `applyTranscriptMessages` sets the start-line atom to `undefined` when a
    // stream event carries none, while still storing that event's messages. So
    // the atom holds a page's own value only until the next stream event, and
    // the pager used to read it after awaiting. Reading `undefined` there
    // meant "nothing arrived" for a page that had -- three of those in a row
    // and the pager stops for good.
    //
    // The fix is the source of the value, so this pins the distinction the
    // outcome draws: a served line is a page, absence is not.
    expect(
      chatHistoryPageOutcome({
        currentStartLine: CHAT_OUTPUT_INITIAL_CAPTURE_START_LINE,
        appliedStartLine: -480,
      }),
    ).toEqual({ kind: "advanced", startLine: -480 });
    expect(
      chatHistoryPageOutcome({
        currentStartLine: CHAT_OUTPUT_INITIAL_CAPTURE_START_LINE,
        appliedStartLine: undefined,
      }),
    ).toEqual({ kind: "not-served" });
  });
});

describe("seeding a re-entered chat's cursor", () => {
  it("starts at the live window when the store holds nothing", () => {
    expect(chatHistorySeedStartLine(undefined)).toBe(CHAT_OUTPUT_CAPTURE_START_LINE);
  });

  it("picks up where the stored transcript left off", () => {
    expect(chatHistorySeedStartLine(-640)).toBe(-640);
  });

  it("always leaves one page of room to ask", () => {
    // Seeding to the floor makes the pager a dead end:
    // `chatOutputHistoryStartLineForScroll` declines when there is nothing
    // deeper, and the floor notice needs a page THIS mount was given -- so
    // scrolling up would do nothing and say nothing. The stored line can also
    // outlive the pane it described, so it is never taken as final.
    const seeded = chatHistorySeedStartLine(CHAT_OUTPUT_MAX_CAPTURE_START_LINE);
    expect(seeded).toBeGreaterThan(CHAT_OUTPUT_MAX_CAPTURE_START_LINE);
    expect(
      chatOutputHistoryStartLineForScroll({
        currentStartLine: seeded,
        metrics: { contentHeight: 2_000, offsetY: 0, viewportHeight: 800 },
      }),
    ).not.toBeNull();
  });

  it("never seeds shallower than the live window", () => {
    expect(chatHistorySeedStartLine(-10)).toBe(CHAT_OUTPUT_CAPTURE_START_LINE);
  });
});

describe("a page that arrives without a start line", () => {
  it("is still a page, because the field is optional in the contract", () => {
    // The store writes `undefined` for it and keeps the messages, so reading
    // that as "nothing arrived" stopped paging on a page already on screen --
    // worse than the bug being fixed. The call site falls back to the line it
    // asked for, which is the best information available.
    expect(
      chatHistoryPageOutcome({
        currentStartLine: CHAT_OUTPUT_INITIAL_CAPTURE_START_LINE,
        appliedStartLine: nextChatOutputCaptureStartLine(CHAT_OUTPUT_INITIAL_CAPTURE_START_LINE),
      }),
    ).toEqual({
      kind: "advanced",
      startLine: nextChatOutputCaptureStartLine(CHAT_OUTPUT_INITIAL_CAPTURE_START_LINE),
    });
  });
});
