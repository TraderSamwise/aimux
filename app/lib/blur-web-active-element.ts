import { Keyboard, Platform } from "react-native";

import { markProgrammaticComposerBlur } from "@/lib/chat-keyboard-intent";

/// Marked here rather than at each of the thirteen call sites: a dismissal
/// nobody asked for must not read as the reader putting the keyboard away.
export function blurWebActiveElement() {
  markProgrammaticComposerBlur();
  if (Platform.OS !== "web") {
    Keyboard.dismiss();
    return;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}
