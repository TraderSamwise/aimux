import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = join(__dirname, "..");
const SKIP = new Set(["node_modules", ".expo", "dist", "ios", "android", ".git"]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

/** Every `keyboardDismissMode=...` in the app, with the file it came from. */
function dismissModeUses(): { file: string; expression: string }[] {
  const uses: { file: string; expression: string }[] = [];
  for (const file of sourceFiles(APP_ROOT)) {
    const source = readFileSync(file, "utf8");
    let cursor = 0;
    for (;;) {
      const at = source.indexOf("keyboardDismissMode", cursor);
      if (at === -1) break;
      // Enough to carry a ternary across the line breaks prettier adds.
      uses.push({
        file: file.slice(APP_ROOT.length + 1),
        expression: source.slice(at, at + 220),
      });
      cursor = at + 1;
    }
  }
  return uses;
}

/**
 * The measured bug, and the one the first version of this gate missed.
 *
 * react-native-web's ScrollView calls `dismissKeyboard()` from `_handleScroll`
 * whenever `keyboardDismissMode === "on-drag"` -- on EVERY scroll event, with
 * no drag detection (node_modules/react-native-web/dist/exports/ScrollView/
 * index.js `_handleScroll`, and `ScrollViewBase` calls the handler
 * unconditionally on the first scroll event, bypassing scrollEventThrottle).
 * On web `dismissKeyboard()` is only `blurTextInput()`. Captured in a real
 * browser as
 *
 *   blur <- blurTextInput <- dismissKeyboard <- ScrollView._handleScroll
 *
 * with the textarea STILL MOUNTED and activeElement falling to BODY, which is
 * what ruled out the remount this was twice blamed on.
 *
 * The first version of this gate counted string literals in the chat screen
 * alone. A review found a live second instance it could not see --
 * `PageLayout.tsx`, whose `Platform.OS === "ios" ? ... : "on-drag"` resolves
 * to "on-drag" on web, under thirteen screens including one with a text
 * input. So the rule is now app-wide and about reachability, not spelling:
 * wherever the prop is set, web must be excluded.
 */
describe("no scroll surface dismisses the keyboard on web", () => {
  it("finds the uses it is meant to be checking", () => {
    // If the prop vanished entirely the rule below would pass vacuously.
    expect(dismissModeUses().length).toBeGreaterThanOrEqual(4);
  });

  it("never lets a web render reach on-drag", () => {
    for (const { file, expression } of dismissModeUses()) {
      if (!expression.includes("on-drag")) continue;
      expect(
        expression.includes('Platform.OS === "web"'),
        `${file} can resolve keyboardDismissMode to "on-drag" on web, where react-native-web blurs the focused field on every scroll event`,
      ).toBe(true);
    }
  });

  it("keeps the native chat panes dismissing, where a keyboard exists", () => {
    // The inverse, so the fix cannot be "achieved" by deleting keyboard
    // handling everywhere: dismissing as you drag is correct on a phone.
    const screen = readFileSync(join(APP_ROOT, "components/screens/AgentChatScreen.tsx"), "utf8");
    expect(screen.split('keyboardDismissMode="interactive"').length - 1).toBe(2);
  });
});
