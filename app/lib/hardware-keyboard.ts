import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

import { getNativeHardwareKeyboardConnected } from "./native-app-commands";

/// The web platform exposes no keyboard query at all, so a pointer that can
/// hover and aim precisely -- a mouse or a trackpad -- is the nearest honest
/// proxy for a machine that also has keys.
export const FINE_POINTER_QUERY = "(any-pointer: fine)";

/// How long Android is given to raise a soft keyboard after the composer takes
/// focus before its absence is read as a hardware one.
export const SOFT_KEYBOARD_SETTLE_MS = 350;

export type HardwareKeyboardSignal =
  | { platform: "web"; finePointer: boolean }
  | { platform: "ios"; nativeConnected: boolean }
  | {
      platform: "android";
      composerFocused: boolean;
      settled: boolean;
      softKeyboardVisible: boolean;
    };

/// One rule per platform, in one place, because each platform answers a
/// different question: iOS can be asked directly (`GCKeyboard`), web cannot be
/// asked at all, and Android is inferred from the soft keyboard never arriving.
export function hasHardwareKeyboard(signal: HardwareKeyboardSignal): boolean {
  switch (signal.platform) {
    case "web":
      return signal.finePointer;
    case "ios":
      return signal.nativeConnected;
    case "android":
      return signal.composerFocused && signal.settled && !signal.softKeyboardVisible;
  }
}

function finePointerQuery(): MediaQueryList | undefined {
  if (Platform.OS !== "web" || typeof window === "undefined") return undefined;
  return window.matchMedia?.(FINE_POINTER_QUERY);
}

/// Whether keys are arriving from a real keyboard rather than a glass one.
///
/// `composerFocused` is only read on Android, where the inference needs to know
/// that something asked for a keyboard and none came up.
export function useHasHardwareKeyboard(composerFocused: boolean): boolean {
  const [connected, setConnected] = useState(
    () => Platform.OS === "web" && Boolean(finePointerQuery()?.matches),
  );

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const query = finePointerQuery();
    if (!query) return;
    const apply = () =>
      setConnected(hasHardwareKeyboard({ platform: "web", finePointer: query.matches }));
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let active = true;
    const refresh = () => {
      void getNativeHardwareKeyboardConnected().then((nativeConnected) => {
        if (active) setConnected(hasHardwareKeyboard({ platform: "ios", nativeConnected }));
      });
    };
    refresh();
    // `keyboardWillChangeFrame` is the one event that reports a keyboard
    // attaching or detaching mid-session, the same reason `useKeyboardHeight`
    // listens to it rather than to `keyboardWillShow`.
    const subscriptions = [
      Keyboard.addListener("keyboardWillChangeFrame", refresh),
      Keyboard.addListener("keyboardWillHide", refresh),
    ];
    return () => {
      active = false;
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android" || !composerFocused) return;
    let settled = false;
    const apply = () =>
      setConnected(
        hasHardwareKeyboard({
          platform: "android",
          composerFocused: true,
          settled,
          softKeyboardVisible: Keyboard.isVisible(),
        }),
      );
    // Unsettled reads as a soft keyboard, so the input keeps its newline
    // behaviour until the absence of one has actually been observed.
    const timer = setTimeout(() => {
      settled = true;
      apply();
    }, SOFT_KEYBOARD_SETTLE_MS);
    const subscriptions = [
      Keyboard.addListener("keyboardDidShow", apply),
      Keyboard.addListener("keyboardDidHide", apply),
    ];
    return () => {
      clearTimeout(timer);
      for (const subscription of subscriptions) subscription.remove();
      // Losing focus discards the inference, so the next focus settles again
      // instead of starting from the last answer.
      setConnected(false);
    };
  }, [composerFocused]);

  return connected;
}
