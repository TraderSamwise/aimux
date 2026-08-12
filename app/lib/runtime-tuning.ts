import { Platform, useWindowDimensions } from "react-native";
import { useAtomValue } from "jotai";
import { desktopAppZoomAtom, desktopAppZoomScale } from "@/stores/settings";

const DESKTOP_NATIVE_WIDTH = 900;
const DESKTOP_NATIVE_SHORT_EDGE = 700;

export function isDesktopNativeRuntime(width: number, height: number) {
  return (
    Platform.OS !== "web" &&
    width >= DESKTOP_NATIVE_WIDTH &&
    Math.min(width, height) >= DESKTOP_NATIVE_SHORT_EDGE
  );
}

export function useRuntimeTuning() {
  const { width, height } = useWindowDimensions();
  const desktopAppZoom = useAtomValue(desktopAppZoomAtom);
  const isDesktopNative = isDesktopNativeRuntime(width, height);

  return {
    isDesktopNative,
    uiScale: isDesktopNative ? desktopAppZoomScale(desktopAppZoom) : 1,
  };
}
