import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const screenSource = readFileSync(join(__dirname, "screens", "AgentChatScreen.tsx"), "utf8");

const occurrences = (needle: string) => screenSource.split(needle).length - 1;

/**
 * The measured bug, pinned on the one prop value that caused it.
 *
 * react-native-web's ScrollView calls `dismissKeyboard()` from `_handleScroll`
 * whenever `keyboardDismissMode === "on-drag"` -- on EVERY scroll event, with
 * no drag detection at all (node_modules/react-native-web/dist/exports/
 * ScrollView/index.js, `_handleScroll`). On web `dismissKeyboard()` is just
 * `blurTextInput()`. Both chat panes scroll themselves to the end on every
 * agent output tick, so every tick blurred the composer under whoever was
 * typing into it. Captured in a real browser as
 *
 *   blur <- blurTextInput <- dismissKeyboard <- ScrollView._handleScroll
 *
 * with the textarea STILL MOUNTED and `document.activeElement` falling to
 * BODY -- which is also what ruled out the remount this was twice blamed on,
 * and why two shipped fixes aimed at remounting changed nothing.
 *
 * "on-drag" was only ever set on the two web panes and "interactive" only on
 * the two native ones, so counting the two spellings says exactly what
 * matters and nothing else. The file holds seven ScrollViews, so parsing
 * elements instead reads the wrong pane's props -- an earlier version of this
 * gate did precisely that and failed on a clean tree.
 */
describe("the web chat panes do not dismiss the keyboard on scroll", () => {
  it("never dismisses on scroll, which on web only means blurring the composer", () => {
    expect(
      occurrences('keyboardDismissMode="on-drag"'),
      'a pane set keyboardDismissMode="on-drag": react-native-web blurs the focused composer on every scroll event, which is the focus-theft bug',
    ).toBe(0);
  });

  it("keeps the native panes dismissing, where a keyboard exists", () => {
    // The inverse, so the fix cannot be "achieved" by deleting keyboard
    // handling everywhere: dismissing as you drag is correct on a phone.
    expect(
      occurrences('keyboardDismissMode="interactive"'),
      "both native panes still dismiss the keyboard",
    ).toBe(2);
  });

  it("still has the two web panes this is about", () => {
    // Guards the gate itself: if the web branches were deleted or renamed,
    // the assertion above would pass for the wrong reason.
    expect(occurrences("<KeyboardChatScrollView")).toBe(2);
    expect(occurrences('Platform.OS !== "web"')).toBeGreaterThanOrEqual(2);
  });
});
