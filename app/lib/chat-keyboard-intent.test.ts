import { beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_KEYBOARD_INTENT_TTL_MS,
  PROGRAMMATIC_BLUR_WINDOW_MS,
  chatKeyboardIntent,
  createChatKeyboardEdgeWatcher,
  recordChatKeyboardHidden,
  markProgrammaticComposerBlur,
  recordComposerFocusIntent,
  resetChatKeyboardIntent,
  shouldFocusComposerOnOpen,
} from "./chat-keyboard-intent";

beforeEach(() => {
  resetChatKeyboardIntent();
});

describe("what the reader last did with the keyboard", () => {
  it("starts with no opinion", () => {
    expect(chatKeyboardIntent()).toBe(false);
  });

  it("remembers that they opened it", () => {
    recordComposerFocusIntent(true);
    expect(chatKeyboardIntent()).toBe(true);
  });

  it("remembers that they put it away", () => {
    recordComposerFocusIntent(true);
    recordComposerFocusIntent(false);
    expect(chatKeyboardIntent()).toBe(false);
  });

  // The whole hazard: tapping an agent in the sidebar dismisses the keyboard
  // and THEN navigates, so the switch that should carry it forward is itself
  // a blur. Reading that as "they put it away" defeats the feature.
  it("ignores the blur that a dismissal caused", () => {
    recordComposerFocusIntent(true);
    markProgrammaticComposerBlur(1_000);
    recordComposerFocusIntent(false, { now: 1_050 });
    expect(chatKeyboardIntent()).toBe(true);
  });

  // ...but only for as long as that dismissal can account for. A blur a
  // second later is the reader's own.
  it("stops covering for a dismissal once its window passes", () => {
    recordComposerFocusIntent(true);
    markProgrammaticComposerBlur(1_000);
    recordComposerFocusIntent(false, { now: 1_001 + PROGRAMMATIC_BLUR_WINDOW_MS });
    expect(chatKeyboardIntent()).toBe(false);
  });

  // A screen that has lost navigation focus is being left, not dismissed.
  it("ignores a blur from a screen that is no longer in front", () => {
    recordComposerFocusIntent(true);
    recordComposerFocusIntent(false, { screenFocused: false });
    expect(chatKeyboardIntent()).toBe(true);
  });

  // A hardware keyboard means there is no soft keyboard to carry. Asked at
  // focus time, because by the time the next chat opens the keyboard has been
  // dismissed and every device measures as though it had one.
  it("records no want when the keyboard is a hardware one", () => {
    recordComposerFocusIntent(true, { hasHardwareKeyboard: true });
    expect(chatKeyboardIntent()).toBe(false);
  });

  // Android's back gesture puts the keyboard away without the composer ever
  // losing focus, so a blur alone would never hear about it.
  it("hears a keyboard that went away without a blur", () => {
    recordComposerFocusIntent(true);
    recordChatKeyboardHidden();
    expect(chatKeyboardIntent()).toBe(false);
  });

  it("ignores a hide that a dismissal caused, like a blur", () => {
    recordComposerFocusIntent(true);
    markProgrammaticComposerBlur(1_000);
    recordChatKeyboardHidden({ now: 1_050 });
    expect(chatKeyboardIntent()).toBe(true);
  });

  // Focusing again is unambiguous, so it also ends any dismissal window.
  it("takes a new focus as the plainest answer there is", () => {
    markProgrammaticComposerBlur(1_000);
    recordComposerFocusIntent(true, { now: 1_050 });
    recordComposerFocusIntent(false, { now: 1_060 });
    expect(chatKeyboardIntent()).toBe(false);
  });
});

describe("where a dismissal has to come from to count", () => {
  // Backgrounding the app hides the keyboard AND blurs the composer. Reading
  // either as the reader putting it away means coming back to a chat that has
  // forgotten what you were doing in it.
  it("ignores a keyboard that went away because the app did", () => {
    recordComposerFocusIntent(true);
    recordChatKeyboardHidden({ appVisible: false });
    expect(chatKeyboardIntent()).toBe(true);
  });

  it("ignores a blur from a backgrounded app", () => {
    recordComposerFocusIntent(true);
    recordComposerFocusIntent(false, { appVisible: false });
    expect(chatKeyboardIntent()).toBe(true);
  });

  // The same rule in the other direction. The keyboard coming back as the app
  // returns to the foreground is the OS restoring it, not a decision, and the
  // screen leans on this for the edge it re-arms from.
  it("arms nothing from a screen that is not in front", () => {
    recordComposerFocusIntent(true, { screenFocused: false });
    expect(chatKeyboardIntent()).toBe(false);
  });

  it("arms nothing from a backgrounded app", () => {
    recordComposerFocusIntent(true, { appVisible: false });
    expect(chatKeyboardIntent()).toBe(false);
  });
});

describe("which edge a keyboard change is", () => {
  it("calls the first change from up to down a hide", () => {
    const edge = createChatKeyboardEdgeWatcher(true);
    expect(edge(false)).toBe("hidden");
  });

  // The effect re-runs on renders that changed nothing, and a level rule
  // would re-clear the want on every one of them.
  it("calls an unchanged level neither edge", () => {
    const edge = createChatKeyboardEdgeWatcher(true);
    expect(edge(false)).toBe("hidden");
    expect(edge(false)).toBe(null);
  });

  it("calls a mount with the keyboard already down neither edge", () => {
    const edge = createChatKeyboardEdgeWatcher(false);
    expect(edge(false)).toBe(null);
  });

  // An interactive dismiss the reader abandons fires a hide and then a show.
  // The second edge is what re-arms the carry the first one cleared.
  it("calls the keyboard coming back a raise", () => {
    const edge = createChatKeyboardEdgeWatcher(true);
    expect(edge(false)).toBe("hidden");
    expect(edge(true)).toBe("raised");
  });
});

describe("how long the memory speaks for", () => {
  // Every way out of a chat is a programmatic dismissal, so nothing else ever
  // clears this. Without a bound, opening a plan, reading it and coming back
  // raises a keyboard the reader stopped thinking about minutes ago.
  it("forgets a want that is no longer about what they were just doing", () => {
    recordComposerFocusIntent(true, { now: 1_000 });
    expect(chatKeyboardIntent(1_001 + CHAT_KEYBOARD_INTENT_TTL_MS)).toBe(false);
  });

  it("still speaks for a switch made at the edge of the window", () => {
    recordComposerFocusIntent(true, { now: 1_000 });
    expect(chatKeyboardIntent(1_000 + CHAT_KEYBOARD_INTENT_TTL_MS)).toBe(true);
  });

  // Carrying the keyboard focuses the next composer, which records a fresh
  // want -- so the window rolls and switching chats all afternoon keeps
  // working. Pinned because an absolute stamp would not do this.
  it("rolls forward each time the keyboard is carried", () => {
    const beyond = 2 * CHAT_KEYBOARD_INTENT_TTL_MS;
    recordComposerFocusIntent(true, { now: 1_000 });
    recordComposerFocusIntent(true, { now: 1_000 + CHAT_KEYBOARD_INTENT_TTL_MS });
    expect(chatKeyboardIntent(1_000 + beyond)).toBe(true);
  });
});

describe("whether a chat that just opened takes the keyboard", () => {
  const wants = { hasComposer: true, hasHardwareKeyboard: false, intent: true };

  it("does when that is what the reader was doing", () => {
    expect(shouldFocusComposerOnOpen(wants)).toBe(true);
  });

  it("does not when they had put it away", () => {
    expect(shouldFocusComposerOnOpen({ ...wants, intent: false })).toBe(false);
  });

  it("does not when the screen has no composer to focus", () => {
    expect(shouldFocusComposerOnOpen({ ...wants, hasComposer: false })).toBe(false);
  });

  // Nothing is occluded and the composer is where typing goes, so there is no
  // want to consult -- which is also why a focus against one records none.
  it("does with a hardware keyboard whatever the reader last did", () => {
    expect(shouldFocusComposerOnOpen({ ...wants, hasHardwareKeyboard: true, intent: false })).toBe(
      true,
    );
  });

  // A composer that is not rendered has nothing to focus, hardware or not.
  it("does not with a hardware keyboard and no composer", () => {
    expect(
      shouldFocusComposerOnOpen({ hasComposer: false, hasHardwareKeyboard: true, intent: true }),
    ).toBe(false);
  });
});
