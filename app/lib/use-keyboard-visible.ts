import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

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
