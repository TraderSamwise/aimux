import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  NativeEventEmitter: class {},
  NativeModules: {},
  Platform: { OS: "ios" },
}));

import {
  isDesktopZoomCommand,
  isNativeAppCommand,
  NATIVE_APP_COMMANDS,
} from "@/lib/native-app-commands";

describe("native app commands", () => {
  it("accepts desktop and chat commands emitted by the native bridge", () => {
    expect([...NATIVE_APP_COMMANDS].sort()).toEqual(
      ["chatInterrupt", "chatSend", "desktopZoomIn", "desktopZoomOut", "desktopZoomReset"].sort(),
    );
    expect(isNativeAppCommand("chatSend")).toBe(true);
    expect(isNativeAppCommand("chatInterrupt")).toBe(true);
    expect(isNativeAppCommand("unknown")).toBe(false);
  });

  it("keeps chat commands out of the desktop zoom handler", () => {
    expect(isDesktopZoomCommand("desktopZoomIn")).toBe(true);
    expect(isDesktopZoomCommand("desktopZoomOut")).toBe(true);
    expect(isDesktopZoomCommand("desktopZoomReset")).toBe(true);
    expect(isDesktopZoomCommand("chatSend")).toBe(false);
    expect(isDesktopZoomCommand("chatInterrupt")).toBe(false);
  });
});
