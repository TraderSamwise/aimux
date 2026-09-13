import { describe, expect, it } from "vitest";

import { createChatScrollChromeState, createChatScrollPolicy } from "./chat-scroll-policy";
import {
  terminalScrollStateAfterUserScroll,
  terminalVisibleOutputForLiveChange,
  terminalVisibleOutputForPinned,
} from "./terminal-visible-output";

describe("terminal visible output", () => {
  it("tracks live output while pinned", () => {
    const current = terminalVisibleOutputForPinned({
      lines: ["old"],
      outputAvailable: true,
      outputText: "old",
      sessionKey: "session-1",
    });
    const liveOutput = terminalVisibleOutputForPinned({
      lines: ["new"],
      outputAvailable: true,
      outputText: "new",
      sessionKey: "session-1",
    });

    expect(terminalVisibleOutputForLiveChange(current, { intent: "pinned", liveOutput })).toBe(
      liveOutput,
    );
  });

  it("freezes the rendered tail while reading", () => {
    const current = terminalVisibleOutputForPinned({
      lines: ["old"],
      outputAvailable: true,
      outputText: "old",
      sessionKey: "session-1",
    });
    const liveOutput = terminalVisibleOutputForPinned({
      lines: ["new"],
      outputAvailable: true,
      outputText: "new",
      sessionKey: "session-1",
    });

    expect(terminalVisibleOutputForLiveChange(current, { intent: "reading", liveOutput })).toBe(
      current,
    );
  });

  it("resets to live output when the session changes", () => {
    const current = terminalVisibleOutputForPinned({
      lines: ["old"],
      outputAvailable: true,
      outputText: "old",
      sessionKey: "session-1",
    });
    const liveOutput = terminalVisibleOutputForPinned({
      lines: ["other"],
      outputAvailable: true,
      outputText: "other",
      sessionKey: "session-2",
    });

    expect(terminalVisibleOutputForLiveChange(current, { intent: "reading", liveOutput })).toBe(
      liveOutput,
    );
  });

  it("hides chrome when terminal output scrolls toward history", () => {
    const first = terminalScrollStateAfterUserScroll({
      chrome: createChatScrollChromeState(),
      metrics: {
        contentHeight: 1600,
        offsetY: 900,
        viewportHeight: 400,
      },
      policy: createChatScrollPolicy(),
    });

    expect(first).toEqual({
      chrome: { lastOffsetY: 900, visible: true },
      policy: { intent: "reading" },
    });

    expect(
      terminalScrollStateAfterUserScroll({
        chrome: first.chrome,
        metrics: {
          contentHeight: 1600,
          offsetY: 880,
          viewportHeight: 400,
        },
        policy: first.policy,
      }),
    ).toEqual({
      chrome: { lastOffsetY: 880, visible: false },
      policy: { intent: "reading" },
    });
  });

  it("reveals chrome when terminal output returns to the newest content", () => {
    expect(
      terminalScrollStateAfterUserScroll({
        chrome: { lastOffsetY: 700, visible: false },
        metrics: {
          contentHeight: 1600,
          offsetY: 1200,
          viewportHeight: 400,
        },
        policy: { intent: "reading" },
      }),
    ).toEqual({
      chrome: { lastOffsetY: 1200, visible: true },
      policy: { intent: "pinned" },
    });
  });
});
