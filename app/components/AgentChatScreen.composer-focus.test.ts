import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = join(__dirname, "..");
const SKIP = new Set(["node_modules", ".expo", "dist", "ios", "android", ".git"]);
/** The one file allowed to name the mode that blurs on web. */
const DECIDER = "lib/keyboard-dismiss-mode.ts";

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      // Plain JS counts: a scroll surface written in .jsx blurs just the same.
    } else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.test\.(tsx?|jsx?)$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

const files = () =>
  sourceFiles(APP_ROOT).map((path) => ({
    name: relative(APP_ROOT, path),
    source: readFileSync(path, "utf8"),
  }));

/**
 * The measured bug, pinned by making one place decide it.
 *
 * react-native-web's ScrollView calls `dismissKeyboard()` from `_handleScroll`
 * whenever `keyboardDismissMode === "on-drag"` — on every scroll event, with
 * no drag detection, and `ScrollViewBase` calls the handler unconditionally
 * on the first event, bypassing `scrollEventThrottle`. On web
 * `dismissKeyboard()` is only `blurTextInput()`. Captured in a real browser:
 *
 *   blur <- blurTextInput <- dismissKeyboard <- ScrollView._handleScroll
 *
 * with the textarea STILL MOUNTED and activeElement falling to BODY, which is
 * what ruled out the remount this was twice blamed on.
 *
 * Two earlier versions of this gate were wrong, and how they were wrong is
 * the reason for this one:
 *
 *  - counting a literal in ONE file missed `PageLayout.tsx`, a live second
 *    instance under thirteen screens;
 *  - requiring each use to mention `Platform.OS === "web"` accepted the
 *    inverted bug verbatim (`=== "web" ? "on-drag" : undefined`), rejected
 *    the CORRECT `!== "web"`, and could be walked around entirely by
 *    assigning the mode to a variable somewhere else.
 *
 * So the rule is not about how a call site spells its platform check. There
 * is one decider, and "on-drag" may not appear anywhere else — which no
 * amount of indirection evades, because the literal has to exist somewhere.
 */
describe("only one place decides whether a scroll surface dismisses the keyboard", () => {
  it("has the surfaces it is meant to be guarding", () => {
    // Counts real prop uses, not prose: an earlier floor was satisfied by a
    // comment that happened to mention the prop.
    const uses = files().reduce(
      (total, file) => total + (file.source.split("keyboardDismissMode=").length - 1),
      0,
    );
    expect(uses, "the scroll surfaces this gate exists for").toBeGreaterThanOrEqual(3);
  });

  it("names on-drag in exactly one file", () => {
    const naming = files()
      .filter((file) => file.source.includes('"on-drag"') || file.source.includes("'on-drag'"))
      .map((file) => file.name);
    expect(
      naming,
      'only lib/keyboard-dismiss-mode.ts may name "on-drag"; on web it makes react-native-web blur the focused field on every scroll event',
    ).toEqual([DECIDER]);
  });

  it("keeps web out of the decision", () => {
    const decider = files().find((file) => file.name === DECIDER);
    expect(decider, "the decider must exist").toBeDefined();
    expect(
      decider?.source.includes('Platform.OS === "web" ? undefined'),
      "web must resolve to no dismissal at all",
    ).toBe(true);
  });

  it("keeps the native chat panes dismissing, where a keyboard exists", () => {
    // The inverse, so the fix cannot be "achieved" by removing keyboard
    // handling everywhere: dismissing as you drag is correct on a phone.
    const screen = readFileSync(join(APP_ROOT, "components/screens/AgentChatScreen.tsx"), "utf8");
    expect(screen.split('keyboardDismissMode="interactive"').length - 1).toBe(2);
  });
});
