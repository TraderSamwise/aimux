import { describe, expect, it, vi } from "vitest";

// The rules under test are pure; the module they live in reaches for `Platform`
// for the hook beside them, and react-native itself will not parse here. Same
// shape as `native-app-commands.test.ts`.
vi.mock("react-native", () => ({
  NativeEventEmitter: class {},
  NativeModules: {},
  Platform: { OS: "web" },
}));

import {
  hasHardwareKeyboard,
  SOFT_KEYBOARD_MIN_OCCLUSION_PX,
  softKeyboardOccludes,
} from "@/lib/hardware-keyboard";

describe("hardware keyboard", () => {
  it("takes a native platform at its word", () => {
    expect(hasHardwareKeyboard({ platform: "native", nativeConnected: true })).toBe(true);
    expect(hasHardwareKeyboard({ platform: "native", nativeConnected: false })).toBe(false);
  });

  it("believes the measurement over the device class on web", () => {
    // The two cases the device-class guess got backwards. A phone with a
    // stylus reports a fine pointer and must still not send on a soft return;
    // a keyboard folio with no trackpad reports none and must send.
    expect(
      hasHardwareKeyboard({
        platform: "web",
        finePointerWithHover: true,
        softKeyboardOccludes: true,
      }),
    ).toBe(false);
    expect(
      hasHardwareKeyboard({
        platform: "web",
        finePointerWithHover: false,
        softKeyboardOccludes: false,
      }),
    ).toBe(true);
  });

  it("falls back to the pointer only where there is nothing to measure", () => {
    expect(
      hasHardwareKeyboard({
        platform: "web",
        finePointerWithHover: true,
        softKeyboardOccludes: null,
      }),
    ).toBe(true);
    expect(
      hasHardwareKeyboard({
        platform: "web",
        finePointerWithHover: false,
        softKeyboardOccludes: null,
      }),
    ).toBe(false);
  });

  it("reads a keyboard-sized bite out of the viewport, not browser chrome", () => {
    expect(softKeyboardOccludes(900, 900)).toBe(false);
    // An address bar sliding in and out is tens of pixels, not hundreds.
    expect(softKeyboardOccludes(900 - 60, 900)).toBe(false);
    expect(softKeyboardOccludes(900 - SOFT_KEYBOARD_MIN_OCCLUSION_PX, 900)).toBe(true);
    expect(softKeyboardOccludes(560, 900)).toBe(true);
  });
});
