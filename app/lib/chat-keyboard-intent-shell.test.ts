import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import {
  chatKeyboardIntent,
  createChatKeyboardEdgeWatcher,
  recordChatKeyboardHidden,
  recordComposerFocusIntent,
  resetChatKeyboardIntent,
} from "@/lib/chat-keyboard-intent";

// Resolved against this file, not the cwd: a run rooted at the repo instead of
// `app/` would otherwise fail on a path rather than on the invariant.
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Comments stripped: `toContain` is happy to match a call that has been
// commented out, which is one keystroke from a dead feature.
function strippedSource(relative: string): string {
  const path = join(APP_ROOT, relative);
  expect(existsSync(path), `${path} is readable`).toBe(true);
  return readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
}

function chatScreenSource(): string {
  return strippedSource("components/screens/AgentChatScreen.tsx");
}

/**
 * The module's rules are proven in `chat-keyboard-intent.test.ts`. All this
 * claims is that the chat screen still runs them -- every finding against this
 * feature has been in the glue, where deleting a call breaks nothing else.
 */
describe("the chat screen runs the keyboard memory", () => {
  it("watches keyboard visibility per mount rather than from a module", () => {
    expect(chatScreenSource(), "one watcher per mounted chat, like the sidebar's").toMatch(
      /useState\(\s*\(\) => createChatKeyboardEdgeWatcher\(keyboardVisible\),?\s*\)/,
    );
  });

  it("clears the want on the hide edge and re-arms it on the show edge", () => {
    const source = chatScreenSource();
    expect(source, "a keyboard that went away without a blur").toContain(
      "recordChatKeyboardHidden(where)",
    );
    // The other edge: an interactive dismiss the reader abandons fires a hide
    // and then a show, and without this the carry quietly stops.
    expect(source, "and one that came back").toMatch(
      /recordComposerFocusIntent\(\s*true,\s*\{[^}]*\.\.\.where[^}]*hasHardwareKeyboard/,
    );
  });

  // Both facts are defaulted in the module, so deleting either line stays
  // green everywhere else. `[^}]` rather than `[\s\S]`: an unbounded gap
  // walked out of the object and matched the other call site's fields.
  it("tells the memory where each report came from", () => {
    const source = chatScreenSource();
    expect(source, "the edge path").toMatch(
      /const where = \{[^}]*appVisible: isAppVisible\(\)[^}]*screenFocused: screenFocusedRef\.current[^}]*\}/,
    );
    expect(source, "and the focus-change path").toMatch(
      /recordComposerFocusIntent\(\s*focused,\s*\{[^}]*appVisible: isAppVisible\(\)[^}]*screenFocused: screenFocusedRef\.current/,
    );
  });

  // One helper owns the whole open-time rule, so the screen must hand it all
  // three facts. The shorthand, not just the name: `hasHardwareKeyboard:
  // false` reads the same to a looser pattern and answers the question wrong.
  it("asks the memory whether an opening chat takes the keyboard", () => {
    expect(chatScreenSource()).toMatch(
      /shouldFocusComposerOnOpen\(\{[^}]*hasComposer: showComposerFooter[^}]*hasHardwareKeyboard\s*,[^}]*intent: chatKeyboardIntent\(\)[^}]*\}/,
    );
  });

  // Marked in the one shared dismissal rather than at each of its thirteen
  // call sites, so this is where the claim has to hold.
  it("marks every dismissal nobody asked for", () => {
    expect(strippedSource("lib/blur-web-active-element.ts")).toMatch(
      /markProgrammaticComposerBlur\(\);[\s\S]*?Platform\.OS/,
    );
  });

  // A single module slot holds the composer owed a restore, so a mount-scoped
  // registration let a pushed chat overwrite the one behind it and left that
  // chat unable to receive the restore after a pop.
  it("registers the composer for the sidebar's restore on focus", () => {
    expect(chatScreenSource()).toMatch(
      /useFocusEffect\(\s*useCallback\(\(\) => registerChatComposerFocus\(/,
    );
  });

  it("does not shadow the memory with locals of the same name", () => {
    expect(chatScreenSource()).not.toMatch(
      /(const|let|var|function)\s+(chatKeyboardIntent|recordChatKeyboardHidden|recordComposerFocusIntent|createChatKeyboardEdgeWatcher)\b/,
    );
  });
});

/**
 * The sequence the screen produces, played through the public API, so the
 * contract the source assertions above point at is also executed.
 */
describe("an interactive dismiss the reader abandons", () => {
  beforeEach(() => {
    resetChatKeyboardIntent();
  });

  it("leaves the want intact once the keyboard comes back", () => {
    const edge = createChatKeyboardEdgeWatcher(true);
    recordComposerFocusIntent(true);
    expect(edge(false)).toBe("hidden");
    recordChatKeyboardHidden();
    expect(chatKeyboardIntent(), "cleared while the keyboard is down").toBe(false);
    expect(edge(true)).toBe("raised");
    recordComposerFocusIntent(true);
    expect(chatKeyboardIntent(), "and re-armed when it snaps back").toBe(true);
  });
});
