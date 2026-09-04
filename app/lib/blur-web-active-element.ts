import { Keyboard, Platform } from "react-native";

export function blurWebActiveElement() {
  if (Platform.OS !== "web") {
    Keyboard.dismiss();
    return;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}
