import { describe, expect, it, vi } from "vitest";

// The rule under test is pure; the module it lives in reaches for `Keyboard`
// and `Platform` for the hook beside it, and react-native itself will not parse
// here. Same shape as `native-app-commands.test.ts`.
vi.mock("react-native", () => ({
  Keyboard: { addListener: () => ({ remove: () => {} }), isVisible: () => false },
  NativeEventEmitter: class {},
  NativeModules: {},
  Platform: { OS: "web" },
}));

import { hasHardwareKeyboard } from "@/lib/hardware-keyboard";

describe("hardware keyboard", () => {
  it("reads a precise pointer as a keyboard on web", () => {
    expect(hasHardwareKeyboard({ platform: "web", finePointer: true })).toBe(true);
    expect(hasHardwareKeyboard({ platform: "web", finePointer: false })).toBe(false);
  });

  it("takes iOS at its word", () => {
    expect(hasHardwareKeyboard({ platform: "ios", nativeConnected: true })).toBe(true);
    expect(hasHardwareKeyboard({ platform: "ios", nativeConnected: false })).toBe(false);
  });

  it("only calls Android a hardware keyboard once no soft one has arrived", () => {
    const android = {
      platform: "android" as const,
      composerFocused: true,
      settled: true,
      softKeyboardVisible: false,
    };
    expect(hasHardwareKeyboard(android)).toBe(true);
    // A soft keyboard that is up answers the question on its own.
    expect(hasHardwareKeyboard({ ...android, softKeyboardVisible: true })).toBe(false);
    // Before the settle window closes the answer is not yet known, and an
    // unknown must take the soft-keyboard path or Enter eats the line break.
    expect(hasHardwareKeyboard({ ...android, settled: false })).toBe(false);
    // Nothing asked for a keyboard, so nothing can be concluded from its
    // absence.
    expect(hasHardwareKeyboard({ ...android, composerFocused: false })).toBe(false);
  });
});
