import { useEffect, useRef } from "react";

import { type SidebarPresentation } from "@/lib/app-shell-layout";
import { blurWebActiveElement } from "@/lib/blur-web-active-element";

export type SidebarOpenState = { open: boolean; presentation: SidebarPresentation };

export type SidebarKeyboardDismiss = (state: SidebarOpenState, dismiss: () => void) => boolean;

/**
 * Decision and act together, so an inverted guard fails a spy instead of
 * hiding in a branch the caller owns. Returns whether it acted.
 */
export function dismissKeyboardForSidebarOpen(
  transition: SidebarOpenState & { previouslyOpen: boolean },
  dismiss: () => void,
): boolean {
  if (transition.presentation !== "drawer") return false;
  if (!transition.open || transition.previouslyOpen) return false;
  dismiss();
  return true;
}

/**
 * EDGE, not level. Rotating an iPad to portrait crosses the 900pt breakpoint
 * with the sidebar still open, so `drawer && open` turns true having opened
 * nothing -- and the drawer's own default is open, so a level rule blurs on
 * every mount. The sequence lives here so a test can replay both.
 */
export function createSidebarKeyboardDismiss(initiallyOpen: boolean): SidebarKeyboardDismiss {
  let previouslyOpen = initiallyOpen;
  return (state, dismiss) => {
    const acted = dismissKeyboardForSidebarOpen({ ...state, previouslyOpen }, dismiss);
    previouslyOpen = state.open;
    return acted;
  };
}

/** The shell's whole sidebar keyboard behaviour, so no caller holds half of it. */
export function useSidebarKeyboardDismiss(
  open: boolean,
  presentation: SidebarPresentation,
  dismiss: () => void = blurWebActiveElement,
): void {
  const dismissOnOpenRef = useRef<SidebarKeyboardDismiss | null>(null);
  dismissOnOpenRef.current ??= createSidebarKeyboardDismiss(open);

  useEffect(() => {
    dismissOnOpenRef.current?.({ open, presentation }, dismiss);
  }, [dismiss, open, presentation]);
}
