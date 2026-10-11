import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dismiss: vi.fn(),
  platform: { OS: "ios" },
}));

vi.mock("react-native", () => ({
  Keyboard: { dismiss: mocks.dismiss },
  Platform: mocks.platform,
}));

import { blurWebActiveElement } from "./blur-web-active-element";
import {
  chatKeyboardIntent,
  recordComposerFocusIntent,
  resetChatKeyboardIntent,
} from "./chat-keyboard-intent";

describe("blurWebActiveElement", () => {
  beforeEach(() => {
    mocks.dismiss.mockClear();
    mocks.platform.OS = "ios";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dismisses the native keyboard outside web", () => {
    blurWebActiveElement();

    expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  });

  it("blurs the active web element on web", () => {
    const blur = vi.fn();
    class MockHTMLElement {
      blur = blur;
    }
    mocks.platform.OS = "web";
    vi.stubGlobal("HTMLElement", MockHTMLElement);
    vi.stubGlobal("document", {
      activeElement: new MockHTMLElement(),
    });

    blurWebActiveElement();

    expect(blur).toHaveBeenCalledTimes(1);
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });
});

/**
 * Every programmatic dismissal goes through here, and the one that matters is
 * the sidebar's: it puts the keyboard away and THEN navigates, so the switch
 * that should carry the keyboard forward is itself a blur.
 */
describe("a dismissal nobody asked for", () => {
  beforeEach(() => {
    mocks.platform.OS = "ios";
    resetChatKeyboardIntent();
  });

  it("does not read as the reader putting the keyboard away", () => {
    recordComposerFocusIntent(true);
    blurWebActiveElement();
    recordComposerFocusIntent(false);
    expect(chatKeyboardIntent()).toBe(true);
  });
});
