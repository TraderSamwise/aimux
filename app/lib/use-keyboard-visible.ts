import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";
import type { KeyboardEvent } from "react-native";

type KeyboardState = {
  visible: boolean;
  inset: number;
};

export function useKeyboardState() {
  const [state, setState] = useState<KeyboardState>({ visible: false, inset: 0 });

  useEffect(() => {
    if (Platform.OS === "web") return;

    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvent, (event: KeyboardEvent) => {
      Keyboard.scheduleLayoutAnimation(event);
      setState({ visible: true, inset: event.endCoordinates.height });
    });
    const hideSub = Keyboard.addListener(hideEvent, (event: KeyboardEvent) => {
      Keyboard.scheduleLayoutAnimation(event);
      setState({ visible: false, inset: 0 });
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return state;
}

export function useKeyboardInset() {
  return useKeyboardState().inset;
}

export function useKeyboardVisible() {
  return useKeyboardState().visible;
}
