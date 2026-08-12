import { NativeEventEmitter, NativeModules, Platform } from "react-native";

export type NativeAppCommand = "desktopZoomIn" | "desktopZoomOut" | "desktopZoomReset";

interface NativeCommandPayload {
  command?: unknown;
}

export function subscribeNativeAppCommands(handler: (command: NativeAppCommand) => void) {
  if (Platform.OS === "web") return () => {};
  const module = NativeModules.AimuxNativeCommands;
  if (!module) return () => {};

  const emitter = new NativeEventEmitter(module);
  const subscription = emitter.addListener(
    "AimuxNativeCommand",
    (payload: NativeCommandPayload) => {
      if (
        payload.command === "desktopZoomIn" ||
        payload.command === "desktopZoomOut" ||
        payload.command === "desktopZoomReset"
      ) {
        handler(payload.command);
      }
    },
  );

  return () => subscription.remove();
}
