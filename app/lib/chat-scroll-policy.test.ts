import { describe, expect, it } from "vitest";

import {
  CHAT_SCROLL_END_THRESHOLD,
  chatChromeAfterUserScroll,
  chatCommandForContentChange,
  chatCommandForInitialLayout,
  chatCommandForKeyboardChange,
  chatCommandForNavigationFocus,
  chatDistanceFromEnd,
  chatScrollTargetForEnd,
  chatPolicyAfterNavigationFocus,
  chatPolicyAfterUserScroll,
  chatScrollCommandRunsWhileUnpinned,
  chatScrollEndOffset,
  chatScrollDirection,
  createChatScrollChromeState,
  createChatScrollPolicy,
  isChatPinnedToEnd,
  type ChatScrollReason,
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

// The keyboard adds a bottom contentInset, which extends the scrollable range
// past the content. Scrolling to `contentHeight - viewportHeight` then lands
// short by exactly the inset, which is why the newest terminal output sat behind
// the keyboard while the pane believed it was pinned to the end.
describe("where to scroll to reach the newest content", () => {
  // The dangerous case, and the reason this returns null rather than a number:
  // a freshly mounted pane is zero everywhere, and the library reports the
  // keyboard and composer inset through its own callback, which can arrive
  // before the first layout. A pane that trusted `target > 0` then scrolled to
  // the INSET -- a couple of hundred points from the TOP of the history.
  it("has no answer before the pane has been measured", () => {
    expect(
      chatScrollEndOffset({ bottomInset: 200, contentHeight: 0, offsetY: 0, viewportHeight: 0 }),
    ).toBeNull();
    expect(
      chatScrollEndOffset({ bottomInset: 200, contentHeight: 4000, offsetY: 0, viewportHeight: 0 }),
    ).toBeNull();
    expect(
      chatScrollEndOffset({ bottomInset: 200, contentHeight: 0, offsetY: 0, viewportHeight: 300 }),
    ).toBeNull();
  });

  it("is the inset-aware end once it has", () => {
    expect(
      chatScrollEndOffset({
        bottomInset: 200,
        contentHeight: 4000,
        offsetY: 0,
        viewportHeight: 300,
      }),
    ).toBe(3900);
    expect(chatScrollEndOffset({ contentHeight: 4000, offsetY: 0, viewportHeight: 300 })).toBe(
      3700,
    );
  });

  // Content shorter than the viewport has nothing to scroll, and the native
  // command handles it without being told a number.
  it("has no answer when the content fits", () => {
    expect(chatScrollEndOffset({ contentHeight: 200, offsetY: 0, viewportHeight: 300 })).toBeNull();
  });
});

describe("a landing scroll outranks the reader's position", () => {
  // `initial` and `navigation` are how a pane opens on the newest message, so
  // they run whatever the intent says. `content` and `keyboard` are offers the
  // reader refuses by scrolling up. Stated as a total table so a new reason
  // has to be classified rather than quietly joining the second group.
  const RUNS = {
    content: false,
    initial: true,
    keyboard: false,
    navigation: true,
  } as const satisfies Record<ChatScrollReason, boolean>;

  it("runs only the commands that put the reader at the end", () => {
    for (const [reason, expected] of Object.entries(RUNS)) {
      expect(chatScrollCommandRunsWhileUnpinned(reason as ChatScrollReason), reason).toBe(expected);
    }
  });

  // Nothing queued is nothing to protect: a pane with no command in flight
  // cancels as it always did.
  it("protects nothing when no command is in flight", () => {
    expect(chatScrollCommandRunsWhileUnpinned(null)).toBe(false);
  });

  // The whole point, in the geometry that caused it: a composer reserve of 200
  // means the content's end is 200px short of the scrollable end, so a pane
  // that scrolled to the former reads as 200px of scrollback -- past the 20px
  // threshold -- and freezes.
  it("calls a pane that scrolled to the content's end unpinned, and the real end pinned", () => {
    const geometry = { bottomInset: 200, contentHeight: 4000, viewportHeight: 300 };
    const contentEnd = geometry.contentHeight - geometry.viewportHeight;
    expect(chatScrollTargetForEnd({ ...geometry, offsetY: 0 })).toBe(contentEnd + 200);
    expect(isChatPinnedToEnd({ ...geometry, offsetY: contentEnd })).toBe(false);
    expect(isChatPinnedToEnd({ ...geometry, offsetY: contentEnd + 200 })).toBe(true);
    expect(
      chatPolicyAfterUserScroll(createChatScrollPolicy(), { ...geometry, offsetY: contentEnd }),
    ).toEqual({ intent: "reading" });
    expect(
      chatPolicyAfterUserScroll(createChatScrollPolicy(), {
        ...geometry,
        offsetY: contentEnd + 200,
      }),
    ).toEqual({ intent: "pinned" });
  });
});

describe("the end of the content with a keyboard inset", () => {
  const geometry = { contentHeight: 1000, offsetY: 0, viewportHeight: 300 };

  it("targets past the content by the inset", () => {
    expect(chatScrollTargetForEnd({ ...geometry, bottomInset: 280 })).toBe(980);
  });

  it("targets the plain end with no inset", () => {
    expect(chatScrollTargetForEnd(geometry)).toBe(700);
    expect(chatScrollTargetForEnd({ ...geometry, bottomInset: 0 })).toBe(700);
  });

  it("never targets a negative offset when the content is shorter than the viewport", () => {
    expect(chatScrollTargetForEnd({ contentHeight: 100, offsetY: 0, viewportHeight: 300 })).toBe(0);
  });

  it("does not call the pre-keyboard end position pinned once the inset exists", () => {
    const atOldEnd = { ...geometry, bottomInset: 280, offsetY: 700 };
    expect(chatDistanceFromEnd(atOldEnd)).toBe(280);
    expect(isChatPinnedToEnd(atOldEnd)).toBe(false);
  });

  it("calls the inset-aware end position pinned", () => {
    expect(isChatPinnedToEnd({ ...geometry, bottomInset: 280, offsetY: 980 })).toBe(true);
  });
});
