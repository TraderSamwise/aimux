import { useMemo } from "react";
import { Platform, useWindowDimensions } from "react-native";

const DESKTOP_WIDTH = 900;

export function useAppStackScreenOptions() {
  const { width } = useWindowDimensions();
  const isDesktopPresentation = Platform.OS === "web" && width >= DESKTOP_WIDTH;

  return useMemo(
    () => ({
      headerShown: false,
      ...(isDesktopPresentation ? { animation: "none" as const } : {}),
    }),
    [isDesktopPresentation],
  );
}
