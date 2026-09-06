import { NativeEventEmitter, NativeModules, Platform } from "react-native";

export const NATIVE_APP_COMMANDS = [
  "desktopZoomIn",
  "desktopZoomOut",
  "desktopZoomReset",
  "chatSend",
  "chatInterrupt",
] as const;

export type NativeAppCommand = (typeof NATIVE_APP_COMMANDS)[number];
export type DesktopZoomCommand = Extract<
  NativeAppCommand,
  "desktopZoomIn" | "desktopZoomOut" | "desktopZoomReset"
>;

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
      if (typeof payload.command === "string" && isNativeAppCommand(payload.command)) {
        handler(payload.command);
      }
    },
  );

  return () => subscription.remove();
}

export function isNativeAppCommand(command: string): command is NativeAppCommand {
  return NATIVE_APP_COMMANDS.includes(command as NativeAppCommand);
}

export function isDesktopZoomCommand(command: NativeAppCommand): command is DesktopZoomCommand {
  return (
    command === "desktopZoomIn" || command === "desktopZoomOut" || command === "desktopZoomReset"
  );
}
