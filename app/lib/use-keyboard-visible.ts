import { useEffect, useState } from "react";
import { Dimensions, Keyboard, Platform } from "react-native";
import type { KeyboardEvent } from "react-native";

type KeyboardState = {
  visible: boolean;
  inset: number;
};

export function useKeyboardState() {
  const [state, setState] = useState<KeyboardState>({ visible: false, inset: 0 });

  useEffect(() => {
    if (Platform.OS === "web") return;

    const frameEvent = Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const applyKeyboardFrame = (event: KeyboardEvent) => {
      Keyboard.scheduleLayoutAnimation(event);
      const screenHeight = Dimensions.get("window").height;
      const inset =
        Platform.OS === "ios"
          ? Math.max(0, screenHeight - event.endCoordinates.screenY)
          : event.endCoordinates.height;
      setState({ visible: inset > 0, inset });
    };
    const showSub = Keyboard.addListener(frameEvent, applyKeyboardFrame);
    const hideSub = Keyboard.addListener(hideEvent, applyKeyboardFrame);

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
