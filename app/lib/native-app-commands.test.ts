import { describe, expect, it, vi } from "vitest";

const nativeCommandsModule = vi.hoisted(() => ({
  getHardwareKeyboardConnected: vi.fn(),
}));

vi.mock("react-native", () => ({
  NativeEventEmitter: class {},
  NativeModules: { AimuxNativeCommands: nativeCommandsModule },
  Platform: { OS: "ios" },
}));

import {
  getNativeHardwareKeyboardConnected,
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

  it("reads hardware keyboard presence from the native bridge", async () => {
    nativeCommandsModule.getHardwareKeyboardConnected.mockResolvedValueOnce(true);
    await expect(getNativeHardwareKeyboardConnected()).resolves.toBe(true);

    nativeCommandsModule.getHardwareKeyboardConnected.mockResolvedValueOnce(false);
    await expect(getNativeHardwareKeyboardConnected()).resolves.toBe(false);
  });

  it("treats native hardware keyboard bridge errors as not connected", async () => {
    nativeCommandsModule.getHardwareKeyboardConnected.mockRejectedValueOnce(
      new Error("native down"),
    );
    await expect(getNativeHardwareKeyboardConnected()).resolves.toBe(false);
  });
});
