import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  metrics: null as { height?: number; screenY?: number } | null,
  platform: { OS: "ios" as string },
}));

vi.mock("react-native", () => ({
  Keyboard: { addListener: () => ({ remove: () => {} }), metrics: () => mocks.metrics },
  Platform: mocks.platform,
  useWindowDimensions: () => ({ height: 900, width: 400 }),
}));

import { keyboardVisibleAtMount } from "./use-keyboard-visible";

/**
 * The hide edge is the only sign a reader put the keyboard away without
 * blurring the composer, and an always-down seed turns that hide into a level
 * that never changed -- so a chat mounting under a live keyboard heard nothing.
 */
describe("what a chat mounting under a live keyboard starts from", () => {
  beforeEach(() => {
    mocks.platform.OS = "ios";
    mocks.metrics = null;
  });

  it("reads the keyboard that is already up", () => {
    mocks.metrics = { height: 336, screenY: 500 };
    expect(keyboardVisibleAtMount(true)).toBe(true);
  });

  it("reads no keyboard as none", () => {
    expect(keyboardVisibleAtMount(true)).toBe(false);
  });

  // A keyboard reported off the bottom of the screen is one that is leaving,
  // and it still reports its full height.
  it("does not count a keyboard that has left the screen", () => {
    mocks.metrics = { height: 336, screenY: 0 };
    expect(keyboardVisibleAtMount(true)).toBe(false);
  });

  it("asks nothing when the caller has the hook disabled", () => {
    mocks.metrics = { height: 336, screenY: 500 };
    expect(keyboardVisibleAtMount(false)).toBe(false);
  });

  // Android has no `Keyboard.metrics()`, so the gap stays open there and the
  // seed must not pretend otherwise.
  it("answers down on android, which cannot be asked", () => {
    mocks.platform.OS = "android";
    mocks.metrics = { height: 336, screenY: 500 };
    expect(keyboardVisibleAtMount(true)).toBe(false);
  });
});
