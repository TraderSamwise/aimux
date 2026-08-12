import { useMemo } from "react";
import { Platform, useWindowDimensions } from "react-native";

const DESKTOP_WIDTH = 900;
const TABLET_SHORT_EDGE = 700;

export function useAppStackScreenOptions() {
  const { width, height } = useWindowDimensions();
  const isDesktopPresentation =
    Platform.OS === "web"
      ? width >= DESKTOP_WIDTH
      : Platform.OS === "ios" && Math.min(width, height) >= TABLET_SHORT_EDGE;

  return useMemo(
    () => ({
      headerShown: false,
      ...(isDesktopPresentation ? { animation: "none" as const } : {}),
    }),
    [isDesktopPresentation],
  );
}
