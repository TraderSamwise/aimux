import { useEffect, useMemo, useState } from "react";
import { Keyboard, Platform } from "react-native";

import { SOFT_KEYBOARD_MIN_OCCLUSION_PX } from "@/lib/hardware-keyboard";

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
    const apply = () =>
      setHeight(webKeyboardHeight(viewport.height * viewport.scale, window.innerHeight));
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
    };
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
 * How much of the page a web keyboard covers, from the two viewports.
 *
 * Below `SOFT_KEYBOARD_MIN_OCCLUSION_PX` nothing is treated as a keyboard, the
 * same threshold `hasHardwareKeyboard` uses, so browser chrome sliding away
 * does not pad the list by a toolbar.
 */
export function webKeyboardHeight(viewportHeight: number, layoutHeight: number): number {
  if (!Number.isFinite(viewportHeight) || !Number.isFinite(layoutHeight)) return 0;
  const covered = layoutHeight - viewportHeight;
  return covered >= SOFT_KEYBOARD_MIN_OCCLUSION_PX ? Math.round(covered) : 0;
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
  const keyboardHeight = useKeyboardHeight();
  return useMemo(() => ({ paddingBottom: keyboardHeight }), [keyboardHeight]);
}
