import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_COMPOSER_FOCUS_REQUEST_TTL_MS,
  clearChatComposerFocusRequest,
  deliverChatComposerFocus,
  registerChatComposerFocus,
  requestChatComposerFocus,
} from "@/lib/chat-composer-focus";

afterEach(() => {
  clearChatComposerFocusRequest();
});

describe("the chat composer focus request", () => {
  it("reaches a composer that is already registered", () => {
    const focus = vi.fn();
    const unregister = registerChatComposerFocus(focus, 1_000);
    expect(requestChatComposerFocus(1_000), "it was delivered").toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    unregister();
  });

  // Tapping an agent in the sidebar closes the drawer and navigates, so the
  // composer owed the keyboard is the one mounting next.
  it("waits for a composer that mounts afterwards", () => {
    expect(requestChatComposerFocus(1_000), "nobody to deliver to yet").toBe(false);
    const focus = vi.fn();
    const unregister = registerChatComposerFocus(focus, 1_000);
    expect(focus, "delivered on registration").toHaveBeenCalledTimes(1);
    unregister();
  });

  // Delivered once, not to every composer that ever mounts.
  it("is consumed by the first composer to take it", () => {
    requestChatComposerFocus(1_000);
    const first = vi.fn();
    registerChatComposerFocus(first, 1_000)();
    const second = vi.fn();
    registerChatComposerFocus(second, 1_000)();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second, "the request is spent").not.toHaveBeenCalled();
  });

  // A restore is the continuation of the tap that closed the drawer. Navigate
  // somewhere with no composer, come back later, and an unbounded request
  // would raise a keyboard out of nowhere.
  it("expires rather than raising a keyboard minutes later", () => {
    requestChatComposerFocus(1_000);
    const focus = vi.fn();
    const unregister = registerChatComposerFocus(
      focus,
      1_000 + CHAT_COMPOSER_FOCUS_REQUEST_TTL_MS + 1,
    );
    expect(focus, "a composer mounting too late gets no keyboard").not.toHaveBeenCalled();
    expect(deliverChatComposerFocus(1_000), "and the request is gone, not merely stale").toBe(
      false,
    );
    unregister();
  });

  it("still delivers at the edge of its lifetime", () => {
    requestChatComposerFocus(1_000);
    const focus = vi.fn();
    const unregister = registerChatComposerFocus(focus, 1_000 + CHAT_COMPOSER_FOCUS_REQUEST_TTL_MS);
    expect(focus).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("delivers nothing when nothing was asked for", () => {
    const focus = vi.fn();
    const unregister = registerChatComposerFocus(focus, 1_000);
    expect(deliverChatComposerFocus(1_000)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    unregister();
  });

  // An unmounting composer must not keep the registration, or a request lands
  // on a screen that is gone and the keyboard never comes back.
  it("forgets a composer that unregisters", () => {
    const focus = vi.fn();
    registerChatComposerFocus(focus, 1_000)();
    expect(requestChatComposerFocus(1_000)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  // A later composer replacing an earlier one must win; the earlier one's own
  // cleanup must not then clear the new registration.
  it("keeps the newest composer when an older one cleans up", () => {
    const older = vi.fn();
    const unregisterOlder = registerChatComposerFocus(older, 1_000);
    const newer = vi.fn();
    const unregisterNewer = registerChatComposerFocus(newer, 1_000);
    unregisterOlder();
    expect(requestChatComposerFocus(1_000)).toBe(true);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
    unregisterNewer();
  });
});
