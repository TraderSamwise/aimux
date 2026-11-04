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
      columns: 72,
      outputAvailable: true,
      outputText: "old",
      sessionKey: "session-1",
    });
    const liveOutput = terminalVisibleOutputForPinned({
      lines: ["new"],
      columns: 72,
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
      columns: 72,
      outputAvailable: true,
      outputText: "old",
      sessionKey: "session-1",
    });
    const liveOutput = terminalVisibleOutputForPinned({
      lines: ["new"],
      columns: 72,
      outputAvailable: true,
      outputText: "new",
      sessionKey: "session-1",
    });

    expect(terminalVisibleOutputForLiveChange(current, { intent: "reading", liveOutput })).toBe(
      current,
    );
  });

  it("accepts prepended history while reading", () => {
    const current = terminalVisibleOutputForPinned({
      lines: ["newer"],
      columns: 72,
      outputAvailable: true,
      outputText: "newer",
      sessionKey: "session-1",
    });
    const liveOutput = terminalVisibleOutputForPinned({
      lines: ["older", "newer"],
      columns: 72,
      outputAvailable: true,
      outputText: "older\nnewer",
      sessionKey: "session-1",
    });

    expect(terminalVisibleOutputForLiveChange(current, { intent: "reading", liveOutput })).toBe(
      liveOutput,
    );
  });

  it("accepts prepended history while the agent is still emitting", () => {
    // The snapshot a history page arrives in is the WHOLE window as of the
    // fetch, so for a working agent it is deeper at the top and longer at the
    // bottom in the same update. A suffix test sees that as neither, and the
    // scrollback the reader asked for never renders -- which is every case
    // that matters, because an idle agent is not one anybody scrolls back
    // through.
    const current = terminalVisibleOutputForPinned({
      lines: ["newer"],
      columns: 72,
      outputAvailable: true,
      outputText: "newer",
      sessionKey: "session-1",
    });
    const liveOutput = terminalVisibleOutputForPinned({
      lines: ["older", "newer", "newest"],
      columns: 72,
      outputAvailable: true,
      outputText: "older\nnewer\nnewest",
      sessionKey: "session-1",
    });

    expect(terminalVisibleOutputForLiveChange(current, { intent: "reading", liveOutput })).toBe(
      liveOutput,
    );
  });

  it("keeps the frozen tail when output is only appended", () => {
    // The freeze itself, stated as the inverse of the two acceptances above:
    // growth at the bottom alone must not move a reader who is scrolled up.
    const current = terminalVisibleOutputForPinned({
      lines: ["older", "newer"],
      columns: 72,
      outputAvailable: true,
      outputText: "older\nnewer",
      sessionKey: "session-1",
    });
    const liveOutput = terminalVisibleOutputForPinned({
      lines: ["older", "newer", "newest"],
      columns: 72,
      outputAvailable: true,
      outputText: "older\nnewer\nnewest",
      sessionKey: "session-1",
    });

    expect(terminalVisibleOutputForLiveChange(current, { intent: "reading", liveOutput })).toBe(
      current,
    );
  });

  it("resets to live output when the session changes", () => {
    const current = terminalVisibleOutputForPinned({
      lines: ["old"],
      columns: 72,
      outputAvailable: true,
      outputText: "old",
      sessionKey: "session-1",
    });
    const liveOutput = terminalVisibleOutputForPinned({
      lines: ["other"],
      columns: 72,
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

describe("geometry is not content", () => {
  // The freeze holds the view still while someone READS. A width change
  // re-truncates every rule without changing a byte of outputText, so if the
  // content freeze swallowed it, the frozen lines kept the old width and
  // every rule wrapped until the reader scrolled back to the bottom.
  //
  // Reachable: terminal mode, scroll up to read, rotate the phone to
  // portrait. Columns drop, the lines are recomputed correctly, and the view
  // shows the old ones.
  it("takes the new lines when the column count changed, even mid-read", () => {
    const current = terminalVisibleOutputForPinned({
      columns: 72,
      lines: ["wide"],
      outputAvailable: true,
      outputText: "same bytes",
      sessionKey: "session-1",
    });
    const liveOutput = terminalVisibleOutputForPinned({
      columns: 30,
      lines: ["narrow"],
      outputAvailable: true,
      outputText: "same bytes",
      sessionKey: "session-1",
    });

    expect(terminalVisibleOutputForLiveChange(current, { intent: "reading", liveOutput })).toBe(
      liveOutput,
    );
  });

  it("still freezes when only the content would change", () => {
    const current = terminalVisibleOutputForPinned({
      columns: 72,
      lines: ["old"],
      outputAvailable: true,
      outputText: "old",
      sessionKey: "session-1",
    });
    const liveOutput = terminalVisibleOutputForPinned({
      columns: 72,
      lines: ["old", "new"],
      outputAvailable: true,
      outputText: "oldnew",
      sessionKey: "session-1",
    });

    expect(terminalVisibleOutputForLiveChange(current, { intent: "reading", liveOutput })).toBe(
      current,
    );
  });
});
