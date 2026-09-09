import { describe, expect, it } from "vitest";

import {
  CHAT_SCROLL_END_THRESHOLD,
  chatChromeAfterUserScroll,
  chatCommandForContentChange,
  chatCommandForInitialLayout,
  chatCommandForKeyboardChange,
  chatCommandForNavigationFocus,
  chatDistanceFromEnd,
  chatPolicyAfterNavigationFocus,
  chatPolicyAfterUserScroll,
  chatScrollDirection,
  createChatScrollChromeState,
  createChatScrollPolicy,
  isChatPinnedToEnd,
} from "./chat-scroll-policy";

describe("chat scroll policy", () => {
  it("starts pinned to the newest content", () => {
    expect(createChatScrollPolicy()).toEqual({ intent: "pinned" });
  });

  it("computes distance from the bottom of a non-inverted transcript", () => {
    expect(chatDistanceFromEnd({ contentHeight: 1000, offsetY: 600, viewportHeight: 300 })).toBe(
      100,
    );
    expect(chatDistanceFromEnd({ contentHeight: 200, offsetY: 0, viewportHeight: 300 })).toBe(0);
  });

  it("treats offsets within the end threshold as pinned", () => {
    expect(
      isChatPinnedToEnd({
        contentHeight: 1000,
        offsetY: 1000 - 300 - CHAT_SCROLL_END_THRESHOLD,
        viewportHeight: 300,
      }),
    ).toBe(true);
    expect(
      isChatPinnedToEnd({
        contentHeight: 1000,
        offsetY: 1000 - 300 - CHAT_SCROLL_END_THRESHOLD - 1,
        viewportHeight: 300,
      }),
    ).toBe(false);
  });

  it("freezes when the user scrolls away from newest content", () => {
    expect(
      chatPolicyAfterUserScroll(createChatScrollPolicy(), {
        contentHeight: 1600,
        offsetY: 500,
        viewportHeight: 400,
      }),
    ).toEqual({ intent: "reading" });
  });

  it("returns to pinned when the user scrolls back to newest content", () => {
    expect(
      chatPolicyAfterUserScroll(
        { intent: "reading" },
        {
          contentHeight: 1600,
          offsetY: 1200,
          viewportHeight: 400,
        },
      ),
    ).toEqual({ intent: "pinned" });
  });

  it("only auto-scrolls content and keyboard changes while pinned", () => {
    expect(chatCommandForContentChange({ intent: "pinned" })).toEqual({
      animated: false,
      kind: "scrollToEnd",
      reason: "content",
    });
    expect(chatCommandForKeyboardChange({ intent: "pinned" })).toEqual({
      animated: false,
      kind: "scrollToEnd",
      reason: "keyboard",
    });
    expect(chatCommandForContentChange({ intent: "reading" })).toEqual({ kind: "none" });
    expect(chatCommandForKeyboardChange({ intent: "reading" })).toEqual({ kind: "none" });
  });

  it("resets to pinned on navigation focus", () => {
    expect(chatPolicyAfterNavigationFocus()).toEqual({ intent: "pinned" });
    expect(chatCommandForNavigationFocus()).toEqual({
      animated: false,
      kind: "scrollToEnd",
      reason: "navigation",
    });
    expect(chatCommandForInitialLayout()).toEqual({
      animated: false,
      kind: "scrollToEnd",
      reason: "initial",
    });
  });

  it("detects scroll direction with hysteresis", () => {
    expect(chatScrollDirection(null, 100)).toBe("none");
    expect(chatScrollDirection(100, 96)).toBe("none");
    expect(chatScrollDirection(100, 93)).toBe("towardHistory");
    expect(chatScrollDirection(100, 107)).toBe("towardNewest");
  });

  it("hides chat chrome only on deliberate scrollback", () => {
    expect(
      chatChromeAfterUserScroll(
        createChatScrollChromeState(),
        { intent: "reading" },
        {
          contentHeight: 1600,
          offsetY: 900,
          viewportHeight: 400,
        },
      ),
    ).toEqual({ lastOffsetY: 900, visible: true });

    expect(
      chatChromeAfterUserScroll(
        { lastOffsetY: 900, visible: true },
        { intent: "reading" },
        {
          contentHeight: 1600,
          offsetY: 880,
          viewportHeight: 400,
        },
      ),
    ).toEqual({ lastOffsetY: 880, visible: false });
  });

  it("reveals chat chrome on scroll toward newest and while pinned", () => {
    expect(
      chatChromeAfterUserScroll(
        { lastOffsetY: 700, visible: false },
        { intent: "reading" },
        {
          contentHeight: 1600,
          offsetY: 720,
          viewportHeight: 400,
        },
      ),
    ).toEqual({ lastOffsetY: 720, visible: true });

    expect(
      chatChromeAfterUserScroll(
        { lastOffsetY: 1000, visible: false },
        { intent: "reading" },
        {
          contentHeight: 1600,
          offsetY: 1200,
          viewportHeight: 400,
        },
      ),
    ).toEqual({ lastOffsetY: 1200, visible: true });
  });
});
