import { Platform } from "react-native";

/**
 * Whether a scroll surface dismisses the keyboard, decided once.
 *
 * Never on web. react-native-web's ScrollView calls `dismissKeyboard()` from
 * `_handleScroll` whenever this is `"on-drag"` — on every scroll event, with
 * no drag detection, and `ScrollViewBase` calls the handler unconditionally
 * on the first event, bypassing `scrollEventThrottle`. On web
 * `dismissKeyboard()` is only `blurTextInput()`, so the sole effect is taking
 * focus away from whoever is typing. The chat transcript scrolls itself to
 * the end on every agent output tick, which is how it stole the composer's
 * focus once per tick; `PageLayout` had the same bug under thirteen screens.
 *
 * On a phone there is a keyboard and dismissing it as you drag is right.
 * iOS gets the interactive drag-down; Android has no such gesture, so it
 * dismisses at the start of the drag.
 *
 * One exported value rather than the rule written at each call site: a
 * surface that spells this out for itself agrees with the others only by
 * luck, and the gate in `AgentChatScreen.composer-focus.test.ts` is written
 * against exactly that — "on-drag" may appear nowhere else in the app.
 */
export const scrollKeyboardDismissMode: "interactive" | "on-drag" | undefined =
  Platform.OS === "web" ? undefined : Platform.OS === "ios" ? "interactive" : "on-drag";
