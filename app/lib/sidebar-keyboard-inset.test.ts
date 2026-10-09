import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { keyboardHeightFromEvent, webKeyboardHeight } from "@/lib/use-keyboard-visible";

// Resolved against this file, not the cwd: a run rooted at the repo instead of
// `app/` would otherwise fail on a path rather than on the invariant.
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourcePath(relative: string): string {
  return join(APP_ROOT, relative);
}

vi.mock("react-native", () => ({
  Keyboard: { addListener: () => ({ remove: () => {} }) },
  Platform: { OS: "ios" },
}));

describe("keyboardHeightFromEvent", () => {
  it("reports the covered strip, not a window subtraction", () => {
    expect(keyboardHeightFromEvent({ endCoordinates: { height: 336 } })).toBe(336);
    expect(keyboardHeightFromEvent({ endCoordinates: { height: 335.6 } })).toBe(336);
  });

  // A frame change that slides the keyboard off the bottom still reports its
  // full height -- the interactive dismiss drag ends exactly there. Reading
  // only `height` would leave the list padded for a keyboard that has gone.
  it("covers nothing once the keyboard is off the bottom of the screen", () => {
    expect(keyboardHeightFromEvent({ endCoordinates: { height: 336, screenY: 0 } })).toBe(0);
    expect(keyboardHeightFromEvent({ endCoordinates: { height: 336, screenY: -40 } })).toBe(0);
    expect(keyboardHeightFromEvent({ endCoordinates: { height: 336, screenY: 520 } })).toBe(336);
  });

  it("covers nothing when the event says nothing", () => {
    expect(keyboardHeightFromEvent({})).toBe(0);
    expect(keyboardHeightFromEvent({ endCoordinates: null })).toBe(0);
    expect(keyboardHeightFromEvent({ endCoordinates: {} })).toBe(0);
    expect(keyboardHeightFromEvent({ endCoordinates: { height: Number.NaN } })).toBe(0);
    expect(keyboardHeightFromEvent({ endCoordinates: { height: -12 } })).toBe(0);
  });
});

describe("webKeyboardHeight", () => {
  // iPad Safari landscape is 1024pt, so it draws the PERSISTENT sidebar, and
  // its keyboard overlays the page rather than resizing the layout viewport.
  it("reports the gap between the two viewports", () => {
    expect(webKeyboardHeight(560, 900)).toBe(340);
    expect(webKeyboardHeight(559.6, 900)).toBe(340);
  });

  // The same threshold `hasHardwareKeyboard` uses, so a toolbar sliding away
  // does not pad the list by a toolbar.
  it("treats a gap too small to be a keyboard as nothing", () => {
    expect(webKeyboardHeight(900, 900)).toBe(0);
    expect(webKeyboardHeight(800, 900)).toBe(0);
    expect(webKeyboardHeight(920, 900)).toBe(0);
    expect(webKeyboardHeight(Number.NaN, 900)).toBe(0);
    expect(webKeyboardHeight(560, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("every sidebar gives the covered strip back", () => {
  // Source rather than render: these are 700-line components with a dozen
  // atoms each, and the question is only whether every list they scroll
  // receives the inset. A new ScrollView added without one is the regression,
  // and so is a fourth sidebar that answers the question its own way.
  const SIDEBARS = ["ProjectSidebar.tsx", "SharedSidebar.tsx", "MonitorSidebar.tsx"];

  it("covers every sidebar the shell can render", () => {
    const shell = readFileSync(sourcePath("components/AppShell.tsx"), "utf8");
    const imported = [...shell.matchAll(/from "@\/components\/(\w+Sidebar)"/g)];
    expect(
      new Set(imported.map((match) => `${match[1]}.tsx`)),
      "a sidebar the shell renders but this gate does not read",
    ).toEqual(new Set(SIDEBARS));
  });

  it.each(SIDEBARS)("passes the inset to every list %s scrolls", (sidebar) => {
    const path = sourcePath(`components/${sidebar}`);
    expect(existsSync(path), `${path} is readable`).toBe(true);
    const source = readFileSync(path, "utf8");

    // `[\s\S]` not `[^>]`, so a tag prettier wrapped over several lines is
    // still one match; and every scrolling primitive, not just ScrollView,
    // because the next list added here is the one that forgets.
    const tags = source.match(/<(ScrollView|FlatList|SectionList|FlashList)[\s\S]*?>/g) ?? [];
    expect(tags.length, `${sidebar} still scrolls something`).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag, "every scrolled list must inset past the keyboard").toContain(
        "contentContainerStyle={sidebarListInset}",
      );
      // The default swallows the first tap to dismiss the keyboard, so a row
      // the inset just made reachable would need two -- and the first collapses
      // the inset, sliding a different row under the second.
      expect(tag, "and must not swallow the tap that reaches a row").toContain(
        'keyboardShouldPersistTaps="handled"',
      );
    }
    expect(source, "and the inset must be the shared one, not a local copy").toContain(
      "useSidebarListInset()",
    );
  });
});
