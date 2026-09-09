import { Platform, useWindowDimensions } from "react-native";
import { useAtomValue } from "jotai";
import { isDesktopNativeViewportSize } from "@/lib/responsive-viewport-core";
import { desktopAppZoomAtom, desktopAppZoomScale } from "@/stores/settings";

export function isDesktopNativeRuntime(width: number, height: number) {
  return Platform.OS !== "web" && isDesktopNativeViewportSize(width, height);
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
