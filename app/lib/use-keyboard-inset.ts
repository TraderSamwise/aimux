import { useSharedValue, type SharedValue } from "react-native-reanimated";

/**
 * How far the keyboard covers the screen — the resting answer, for web.
 *
 * The browser scrolls its own focused field into view, so there is nothing to
 * apply. `use-keyboard-inset.native.ts` overrides this on device; Metro prefers
 * the platform file, so this is what web and the test runner get. Split rather
 * than branched because `useAnimatedKeyboard` warns on web instead of returning
 * a resting value.
 */
export function useKeyboardInset(): SharedValue<number> {
  return useSharedValue(0);
}
