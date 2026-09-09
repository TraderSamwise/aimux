import { describe, expect, it } from "vitest";

import {
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
});
