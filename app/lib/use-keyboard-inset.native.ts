import { useEffect } from "react";
import { Keyboard, Platform, useWindowDimensions, type KeyboardEvent } from "react-native";
import {
  Easing,
  useSharedValue,
  withTiming,
  type EasingFunction,
  type SharedValue,
} from "react-native-reanimated";

const DEFAULT_KEYBOARD_ANIMATION_DURATION_MS = 250;

/**
 * How far the keyboard covers the screen, as a UI-thread value.
 *
 * iOS drives the shared value from native keyboard frame notifications. That
 * keeps movement on the UI thread without relying on Reanimated's keyboard-view
 * CAAnimation probe, which can miss the live animation on newer iOS builds.
 */
export function useKeyboardInset(): SharedValue<number> {
  const { height: windowHeight } = useWindowDimensions();
  const inset = useSharedValue(0);

  useEffect(() => {
    if (Platform.OS !== "ios") {
      inset.value = 0;
      return;
    }

    const updateInset = (event: KeyboardEvent) => {
      inset.value = withTiming(resolveKeyboardInset(event, windowHeight), {
        duration: resolveKeyboardDuration(event),
        easing: resolveKeyboardEasing(event),
      });
    };
    const frameSub = Keyboard.addListener("keyboardWillChangeFrame", updateInset);
    const hideSub = Keyboard.addListener("keyboardWillHide", updateInset);

    return () => {
      frameSub.remove();
      hideSub.remove();
    };
  }, [inset, windowHeight]);

  return inset;
}

function resolveKeyboardInset(event: KeyboardEvent, windowHeight: number): number {
  const { height, screenY } = event.endCoordinates;
  if (height === 0 || screenY <= 0) return 0;
  return Math.max(0, Math.round(windowHeight - screenY));
}

function resolveKeyboardDuration(event: KeyboardEvent): number {
  return Number.isFinite(event.duration) && event.duration > 10
    ? event.duration
    : DEFAULT_KEYBOARD_ANIMATION_DURATION_MS;
}

function resolveKeyboardEasing(event: KeyboardEvent): EasingFunction {
  switch (event.easing) {
    case "linear":
      return Easing.linear;
    case "easeIn":
      return Easing.in(Easing.ease);
    case "easeOut":
      return Easing.out(Easing.ease);
    case "easeInEaseOut":
    case "keyboard":
    default:
      return Easing.inOut(Easing.ease);
  }
}
