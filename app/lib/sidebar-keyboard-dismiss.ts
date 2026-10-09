import { useEffect, useState } from "react";

import { type SidebarPresentation } from "@/lib/app-shell-layout";
import { blurWebActiveElement } from "@/lib/blur-web-active-element";
import { useHasHardwareKeyboard } from "@/lib/hardware-keyboard";

export type SidebarOpenState = {
  hasHardwareKeyboard: boolean;
  open: boolean;
  presentation: SidebarPresentation;
};

export type SidebarKeyboardDismiss = (state: SidebarOpenState, dismiss: () => void) => boolean;

/**
 * Decision and act together, so an inverted guard fails a spy instead of
 * hiding in a branch the caller owns. Returns whether it acted.
 *
 * A hardware keyboard vetoes it: there is no soft keyboard to put away, so it
 * would only cost the composer its focus -- and nothing gives that back, since
 * the chat's refocus is keyed on navigation and a drawer is not navigation.
 */
export function dismissKeyboardForSidebarOpen(
  transition: SidebarOpenState & { previouslyOpen: boolean },
  dismiss: () => void,
): boolean {
  if (transition.hasHardwareKeyboard) return false;
  if (transition.presentation !== "drawer") return false;
  if (!transition.open || transition.previouslyOpen) return false;
  dismiss();
  return true;
}

/**
 * EDGE, not level. An iPhone Pro Max is 932pt in landscape, so rotating it to
 * portrait crosses the 900pt breakpoint with the sidebar still open and
 * `drawer && open` turns true having opened nothing -- and the drawer's own
 * default is open, so a level rule blurs on every mount. The sequence lives
 * here so a test can replay both.
 */
export function createSidebarKeyboardDismiss(): SidebarKeyboardDismiss {
  // Mount opened nothing, whatever `open` says -- and seeding this from `open`
  // instead is provably the same, since a first render can only act when
  // `open && !previouslyOpen`, which `open` as the seed can never satisfy.
  let previouslyOpen = true;
  return (state, dismiss) => {
    const acted = dismissKeyboardForSidebarOpen({ ...state, previouslyOpen }, dismiss);
    previouslyOpen = state.open;
    return acted;
  };
}

/** The sidebar's whole dismissal behaviour, so no caller holds half of it. */
export function useSidebarKeyboardDismiss(
  open: boolean,
  presentation: SidebarPresentation,
  dismiss: () => void = blurWebActiveElement,
): void {
  const hasHardwareKeyboard = useHasHardwareKeyboard();
  // A lazy initialiser rather than a ref seeded during render: it runs once,
  // allocates nothing on later renders, and leaves no nullable watcher for a
  // `?.` to turn into "nothing to do".
  const [dismissOnOpen] = useState(createSidebarKeyboardDismiss);

  useEffect(() => {
    dismissOnOpen({ hasHardwareKeyboard, open, presentation }, dismiss);
  }, [dismiss, dismissOnOpen, hasHardwareKeyboard, open, presentation]);
}
