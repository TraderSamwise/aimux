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
