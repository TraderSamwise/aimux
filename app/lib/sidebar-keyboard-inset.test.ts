import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { keyboardHeightFromEvent } from "@/lib/use-keyboard-visible";

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

describe("the sidebar gives the covered strip back", () => {
  // Source rather than render: the sidebar is a 700-line component with a dozen
  // atoms, and the question is only whether every list it scrolls receives the
  // inset. A new ScrollView added without one is the regression.
  it("passes the inset to every list it scrolls", () => {
    const path = "components/ProjectSidebar.tsx";
    expect(existsSync(path), `${path} is readable from the test cwd`).toBe(true);
    const source = readFileSync(path, "utf8");

    // `[\s\S]` not `[^>]`, so a tag prettier wrapped over several lines is
    // still one match; and every scrolling primitive, not just ScrollView,
    // because the next list added here is the one that forgets.
    const tags = source.match(/<(ScrollView|FlatList|SectionList|FlashList)[\s\S]*?>/g) ?? [];
    expect(tags.length, "the sidebar still scrolls something").toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag, "every scrolled list must inset past the keyboard").toContain(
        "contentContainerStyle={listBottomInset}",
      );
    }
    expect(source, "and the inset must come from the keyboard, not a constant").toContain(
      "useKeyboardHeight()",
    );
  });
});
