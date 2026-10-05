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
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS === "web") return;

    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvent, (event) => {
      setHeight(keyboardHeightFromEvent(event));
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setHeight(0));

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
 * `endCoordinates.height` rather than a window subtraction: a split or floating
 * iPad keyboard sits away from the bottom edge, so the window maths reports a
 * strip that is not covered and the list would scroll past content that is
 * perfectly visible.
 */
export function keyboardHeightFromEvent(event: {
  endCoordinates?: { height?: number } | null;
}): number {
  const height = event.endCoordinates?.height;
  if (typeof height !== "number" || !Number.isFinite(height)) return 0;
  return Math.max(0, Math.round(height));
}
