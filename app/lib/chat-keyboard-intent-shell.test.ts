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

function chatScreenSource(): string {
  const path = join(APP_ROOT, "components/screens/AgentChatScreen.tsx");
  expect(existsSync(path), `${path} is readable`).toBe(true);
  // Comments stripped first: `toContain` is happy to match a call that has
  // been commented out, which is one keystroke from a dead feature.
  return readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
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

  // Both facts are defaulted in the module, so deleting either line from the
  // screen leaves every other gate green while backgrounding the app silently
  // forgets the want again. `[^}]` rather than `[\s\S]`: an unbounded gap
  // walked out of the object and found the other call site's fields.
  it("tells the memory where each report came from", () => {
    const source = chatScreenSource();
    expect(source, "the edge path").toMatch(
      /const where = \{[^}]*appVisible: isAppVisible\(\)[^}]*screenFocused: screenFocusedRef\.current[^}]*\}/,
    );
    expect(source, "and the focus-change path").toMatch(
      /recordComposerFocusIntent\(\s*focused,\s*\{[^}]*appVisible: isAppVisible\(\)[^}]*screenFocused: screenFocusedRef\.current/,
    );
  });

  it("asks the memory whether an opening chat takes the keyboard", () => {
    expect(chatScreenSource()).toMatch(/intent:\s*chatKeyboardIntent\(\)/);
  });

  it("tells the memory when a dismissal was not the reader's", () => {
    expect(chatScreenSource(), "the re-seed blur must not read as a dismissal").toContain(
      "markProgrammaticComposerBlur()",
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
