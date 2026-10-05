import { existsSync, readFileSync } from "node:fs";
import { Platform } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IOS_MIN_TOP_INSET, resolveToastTopOffset } from "@/lib/native-safe-area";
import { TOAST_POSITION, TOAST_WEB_TOP_OFFSET } from "@/lib/toast-theme";

// The same stand-in `native-safe-area.test.ts` uses: the placement rule is
// arithmetic over an inset, and pulling the real React Native in to assert it
// would be the only hard part of the test.
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

beforeEach(() => {
  (Platform as { OS: typeof Platform.OS }).OS = "ios";
});

/// The two renderers are separate implementations of one decision, so they are
/// asserted together: a banner moved on web and left at the bottom on device is
/// the same report arriving twice.
const SURFACES = ["lib/toast.tsx", "lib/toast.web.tsx"] as const;

describe("toast placement", () => {
  it("is one decision both platforms read rather than a literal in each", () => {
    expect(TOAST_POSITION).toBe("top-center");
    for (const surface of SURFACES) {
      // Relative to the app root, which is where vitest runs. Asserted rather
      // than assumed, so a cwd surprise fails loudly instead of reading an
      // empty string and passing.
      expect(existsSync(surface), `${surface} is readable from the test cwd`).toBe(true);
      const source = readFileSync(surface, "utf8");
      expect(source, `${surface} must take its position from the shared constant`).toContain(
        "position={TOAST_POSITION}",
      );
      expect(source, `${surface} must not hardcode an edge of its own`).not.toMatch(
        /position="(top|bottom)-center"/,
      );
    }
  });

  // `sonner-native`'s positioner computes `top: offset || top || 40`, so an
  // explicit offset REPLACES the safe-area inset rather than adding to it. A
  // flat 28 put the banner under the Dynamic Island -- the same complaint that
  // moved it off the bottom, arriving at the other end of the screen.
  it("clears the island on iOS, at every inset the device may report", () => {
    for (const reported of [0, 20, 47, 54, 59, 62]) {
      const offset = resolveToastTopOffset(reported);
      expect(
        offset,
        `an inset of ${reported} must still clear the island floor of ${IOS_MIN_TOP_INSET}`,
      ).toBeGreaterThan(IOS_MIN_TOP_INSET);
      expect(offset).toBeGreaterThan(reported);
    }
  });

  // Android has no floor, because its reported inset is the status bar and is
  // trustworthy. The guarantee there is weaker and worth saying out loud: the
  // banner sits below whatever the platform reports, never on top of it.
  it("sits below the reported inset on Android, which has no floor of its own", () => {
    (Platform as { OS: typeof Platform.OS }).OS = "android";
    for (const reported of [0, 24, 48]) {
      expect(resolveToastTopOffset(reported)).toBeGreaterThan(reported);
    }
  });

  it("does not reserve a notch on web, where there is none", () => {
    expect(TOAST_WEB_TOP_OFFSET).toBeLessThan(resolveToastTopOffset(0));
  });

  it("gives an error a way out on both platforms", () => {
    for (const surface of SURFACES) {
      const source = readFileSync(surface, "utf8");
      // An error shows for eight seconds and can land over a screen's top bar.
      expect(source, `${surface} must let an error be dismissed`).toMatch(
        /(?<!\w)closeButton(?!\s*=\s*\{false\})/,
      );
    }
  });
});
