import { Platform } from "react-native";
import { useAnimatedKeyboard, useDerivedValue, type SharedValue } from "react-native-reanimated";

/**
 * How far the keyboard covers the screen, as a UI-thread value.
 *
 * Deliberately not React state. The state version re-rendered on every keyboard
 * frame and moved things with `Keyboard.scheduleLayoutAnimation`, which animates
 * every view whose frame changed in that commit — so the composer rising and the
 * tab bar vanishing became two animations of the same thing. iOS also fires both
 * `keyboardWillChangeFrame` and `keyboardWillHide` on dismissal, and a second
 * `configureNext` restarts the running animation from wherever it had got to.
 * That restart is the bounce.
 *
 * iOS only: Android resizes the window itself under the default `resize` soft-input
 * mode, so adding an inset there would offset the composer twice.
 */
export function useKeyboardInset(): SharedValue<number> {
  const keyboard = useAnimatedKeyboard();
  const applies = Platform.OS === "ios";
  return useDerivedValue(() => (applies ? keyboard.height.value : 0));
}
