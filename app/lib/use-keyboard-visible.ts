import { useEffect, useMemo, useState } from "react";
import { Keyboard, Platform, useWindowDimensions } from "react-native";

import { getSidebarPresentation } from "@/lib/app-shell-layout";
import { softKeyboardOcclusionPx } from "@/lib/hardware-keyboard";

/**
 * Whether the keyboard is up, for chrome that hides rather than moves.
 *
 * No `Keyboard.scheduleLayoutAnimation` here: it configures a LayoutAnimation for
 * the whole next commit, so one hook call animated every view whose frame changed,
 * and two components using this hook scheduled it twice per event. Anything that
 * needs to move with the keyboard should ride {@link useKeyboardInset} instead,
 * which is one continuous value on the UI thread.
 */
export function useKeyboardVisible(enabled = true): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    if (Platform.OS === "web") return;

    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvent, () => setVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setVisible(false));

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [enabled]);

  return enabled ? visible : false;
}

/**
 * How far the keyboard covers the screen, as JS state.
 *
 * {@link useKeyboardInset} is the UI-thread value for chrome that MOVES with
 * the keyboard. This is for layout that has to SNAP to it — a scroll view
 * giving back the covered strip as padding — because AGENTS.md forbids
 * animating layout dimensions in touch-critical scroll surfaces, and a padding
 * that eases is exactly that.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(() =>
    // Mounting while the keyboard is already up is reachable -- the shell
    // swaps which sidebar it renders -- and waiting for the next event would
    // leave that mount a keyboard's worth of rows short.
    Platform.OS === "ios" ? keyboardHeightFromEvent({ endCoordinates: Keyboard.metrics() }) : 0,
  );

  // Web is MEASURED, not asked. iPad Safari in landscape is 1024pt, so it gets
  // the persistent sidebar, and its keyboard overlays the page without
  // resizing the layout viewport -- as does Android Chrome, because
  // `interactive-widget=resizes-visual` in `public/index.html` asks it to.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    // Scaled, because `visualViewport.height` is in CSS pixels of the ZOOMED
    // region while `innerHeight` stays the layout viewport: at 2x a 415pt
    // keyboard-free region reports 207.5, and the unscaled gap would pad 664px.
    const apply = () =>
      setHeight(softKeyboardOcclusionPx(viewport.height * viewport.scale, window.innerHeight));
    apply();
    // `resize` only: the viewport's height cannot change on a scroll, and this
    // is the one event `useHasHardwareKeyboard` watches too.
    viewport.addEventListener("resize", apply);
    return () => viewport.removeEventListener("resize", apply);
  }, []);

  useEffect(() => {
    // iOS only, the same restriction `useKeyboardInset` carries. There the
    // window does not resize for the keyboard, so a view pinned to the bottom
    // keeps its frame and the covered strip has to be given back as content.
    // Under Android's edge-to-edge the window handles it, and adding padding
    // on top would push the list up twice.
    if (Platform.OS !== "ios") return;

    const showSub = Keyboard.addListener("keyboardWillChangeFrame", (event) => {
      setHeight(keyboardHeightFromEvent(event));
    });
    // `keyboardWillChangeFrame` rather than `keyboardWillShow`, matching
    // `useKeyboardInset`: it is the one event that reports every position the
    // keyboard takes, including a resize or a hardware keyboard attaching.
    // `willHide` alone does settle the interactive dismiss drag, so this is
    // coverage rather than a fix for it.
    const hideSub = Keyboard.addListener("keyboardWillHide", () => setHeight(0));

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return height;
}

/**
 * How much of the screen a keyboard event says is covered.
 *
 * `endCoordinates.height` rather than a window subtraction, which reports a
 * strip that is not covered whenever the keyboard is not flush with the bottom
 * edge. Neither is right for a FLOATING iPad keyboard, which covers nothing at
 * the bottom and still reports its full height: that pads dead space. The
 * window maths is worse there and wrong elsewhere too, so this is the better
 * of two, not a correct answer for every keyboard.
 */
export function keyboardHeightFromEvent(event: {
  endCoordinates?: { height?: number; screenY?: number } | null;
}): number {
  const height = event.endCoordinates?.height;
  if (typeof height !== "number" || !Number.isFinite(height)) return 0;
  // A frame change that puts the keyboard off the bottom of the screen is the
  // keyboard leaving, and it still reports its full height. `screenY` is where
  // the top of it sits; at or below zero it is not covering anything.
  const screenY = event.endCoordinates?.screenY;
  if (typeof screenY === "number" && Number.isFinite(screenY) && screenY <= 0) return 0;
  return Math.max(0, Math.round(height));
}

/**
 * The bottom inset every sidebar's scrolled list takes, so the three of them
 * cannot answer it differently. AGENTS.md "One Answer, Many Surfaces".
 */
export function useSidebarListInset(): { paddingBottom: number } {
  const { width } = useWindowDimensions();
  const keyboardHeight = useKeyboardHeight();
  // Persistent only, and derived here so the three sidebars cannot each decide
  // it. The drawer is over the chat and dismisses the keyboard instead, so
  // padding it is dead weight that snaps 336 -> 0 mid-slide, re-laying out the
  // list the user is watching move.
  const covered = getSidebarPresentation(width) === "persistent" ? keyboardHeight : 0;
  return useMemo(() => ({ paddingBottom: covered }), [covered]);
}
