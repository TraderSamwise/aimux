import { createStore } from "jotai";
import { agentStateKey, projectStateKey } from "@/lib/project-key";
import { describe, expect, it } from "vitest";

import {
  CHAT_OUTPUT_CAPTURE_START_LINE,
  CHAT_OUTPUT_MAX_CAPTURE_START_LINE,
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
