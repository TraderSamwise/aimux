import { useMemo } from "react";
import { Platform, useWindowDimensions } from "react-native";
import { isDesktopNativeRuntime } from "@/lib/runtime-tuning";

const DESKTOP_WIDTH = 900;

export function useAppStackScreenOptions() {
  const { width, height } = useWindowDimensions();
  const isDesktopPresentation =
    Platform.OS === "web" ? width >= DESKTOP_WIDTH : isDesktopNativeRuntime(width, height);

  return useMemo(
    () => ({
      headerShown: false,
      ...(isDesktopPresentation ? { animation: "none" as const } : {}),
    }),
    [isDesktopPresentation],
  );
}
