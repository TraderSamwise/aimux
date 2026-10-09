import { useEffect, useState } from "react";

import { type SidebarPresentation } from "@/lib/app-shell-layout";
import { blurWebActiveElement } from "@/lib/blur-web-active-element";
import { requestChatComposerFocus } from "@/lib/chat-composer-focus";
import { useHasHardwareKeyboard } from "@/lib/hardware-keyboard";
import { useKeyboardHeight, useKeyboardVisible } from "@/lib/use-keyboard-visible";

export type SidebarKeyboardState = {
  hasHardwareKeyboard: boolean;
  keyboardVisible: boolean;
  open: boolean;
  presentation: SidebarPresentation;
};

export type SidebarKeyboardHandlers = { dismiss: () => void; restore: () => boolean };

export type SidebarKeyboardAction = "dismissed" | "restored" | null;

type Memory = { previouslyOpen: boolean; restorable: boolean };

/**
 * Decision and act together, so an inverted guard fails a spy instead of
 * hiding in a branch the caller owns. Returns what it did.
 *
 * A hardware keyboard vetoes the dismissal: there is no soft keyboard to put
 * away, so it would only cost the composer its focus.
 *
 * `restorable` is recorded at the dismissal, not re-measured at the close --
 * by then the keyboard is already gone, so the only honest answer to "was it
 * visible before?" is the one taken while it still was.
 */
export function actOnSidebarKeyboard(
  state: SidebarKeyboardState,
  memory: Memory,
  handlers: SidebarKeyboardHandlers,
): SidebarKeyboardAction {
  if (state.open && !memory.previouslyOpen) {
    if (state.hasHardwareKeyboard) return null;
    if (state.presentation !== "drawer") return null;
    handlers.dismiss();
    // Only a keyboard that was up is owed back. Tapping the hamburger with
    // nothing focused must not raise one the user never had.
    memory.restorable = state.keyboardVisible;
    return "dismissed";
  }
  if (!state.open && memory.previouslyOpen) {
    const owed = memory.restorable;
    memory.restorable = false;
    return owed && handlers.restore() ? "restored" : null;
  }
  return null;
}

/**
 * EDGE, not level. An iPhone Pro Max is 932pt in landscape, so rotating it to
 * portrait crosses the 900pt breakpoint with the sidebar still open and
 * `drawer && open` turns true having opened nothing -- and the drawer's own
 * default is open, so a level rule blurs on every mount. The sequence lives
 * here so a test can replay both.
 */
export function createSidebarKeyboard() {
  // Mount opened nothing, whatever `open` says -- and seeding this from `open`
  // instead is provably the same, since a first render can only act when
  // `open && !previouslyOpen`, which `open` as the seed can never satisfy.
  const memory: Memory = { previouslyOpen: true, restorable: false };
  return (state: SidebarKeyboardState, handlers: SidebarKeyboardHandlers) => {
    const action = actOnSidebarKeyboard(state, memory, handlers);
    memory.previouslyOpen = state.open;
    return action;
  };
}

/// Module constants so the effect is not re-run by a fresh object identity.
const DEFAULT_HANDLERS: SidebarKeyboardHandlers = {
  dismiss: blurWebActiveElement,
  restore: () => requestChatComposerFocus(),
};

/** The sidebar's whole keyboard behaviour, so no caller holds half of it. */
export function useSidebarKeyboard(
  open: boolean,
  presentation: SidebarPresentation,
  handlers: SidebarKeyboardHandlers = DEFAULT_HANDLERS,
): void {
  const hasHardwareKeyboard = useHasHardwareKeyboard();
  // Both, because neither platform answers alone: `useKeyboardVisible` is the
  // native signal and reports nothing on web, `useKeyboardHeight` measures web
  // and iOS. A false reading only declines to restore, which is the safe side.
  const nativeKeyboardVisible = useKeyboardVisible();
  const measuredKeyboardHeight = useKeyboardHeight();
  const keyboardVisible = nativeKeyboardVisible || measuredKeyboardHeight > 0;
  // A lazy initialiser rather than a ref seeded during render: it runs once,
  // allocates nothing on later renders, and leaves no nullable watcher for a
  // `?.` to turn into "nothing to do".
  const [actOnSidebar] = useState(createSidebarKeyboard);

  useEffect(() => {
    actOnSidebar({ hasHardwareKeyboard, keyboardVisible, open, presentation }, handlers);
  }, [actOnSidebar, handlers, hasHardwareKeyboard, keyboardVisible, open, presentation]);
}
