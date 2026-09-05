import { describe, expect, it } from "vitest";

import {
  chatVisibleTranscriptForLiveChange,
  chatVisibleTranscriptForPinned,
  chatVisibleTranscriptMessages,
} from "./chat-visible-transcript";

describe("chat visible transcript", () => {
  it("tracks live messages while pinned", () => {
    const current = chatVisibleTranscriptForPinned({
      liveMessages: ["first"],
      sessionKey: "codex-1",
    });
    const liveMessages = ["first", "second"];

    expect(
      chatVisibleTranscriptForLiveChange(current, {
        intent: "pinned",
        liveMessages,
        sessionKey: "codex-1",
      }),
    ).toEqual({ messages: liveMessages, sessionKey: "codex-1" });
  });

  it("freezes visible messages while reading", () => {
    const visibleMessages = ["first"];
    const current = chatVisibleTranscriptForPinned({
      liveMessages: visibleMessages,
      sessionKey: "codex-1",
    });

    expect(
      chatVisibleTranscriptForLiveChange(current, {
        intent: "reading",
        liveMessages: ["first", "second"],
        sessionKey: "codex-1",
      }),
    ).toBe(current);
  });

  it("resets to live messages when the session changes", () => {
    const liveMessages = ["other session"];
    const current = chatVisibleTranscriptForPinned({
      liveMessages: ["first"],
      sessionKey: "codex-1",
    });

    expect(
      chatVisibleTranscriptForLiveChange(current, {
        intent: "reading",
        liveMessages,
        sessionKey: "claude-2",
      }),
    ).toEqual({ messages: liveMessages, sessionKey: "claude-2" });
  });

  it("uses live messages instead of a stale snapshot for a new session render", () => {
    const current = chatVisibleTranscriptForPinned({
      liveMessages: ["first"],
      sessionKey: "codex-1",
    });
    const liveMessages = ["other session"];

    expect(
      chatVisibleTranscriptMessages(current, {
        liveMessages,
        sessionKey: "claude-2",
      }),
    ).toBe(liveMessages);
  });
});
