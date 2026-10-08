import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import { getNativeHardwareKeyboardConnected } from "./native-app-commands";

/// A soft keyboard takes a quarter of the screen or more. Browser chrome
/// appearing and disappearing moves the viewport by far less than this, and a
/// pinch zoom that trips it reads as a soft keyboard, which is the safe answer.
export const SOFT_KEYBOARD_MIN_OCCLUSION_PX = 120;

/// Only reached where the visual viewport cannot be measured at all. It does
/// not exclude a hovering stylus, so it is the weaker answer and not the
/// primary one.
export const FINE_POINTER_QUERY = "(any-pointer: fine) and (any-hover: hover)";

export type HardwareKeyboardSignal =
  /// `softKeyboardOccludes` is null when the viewport cannot be measured.
  | { platform: "web"; finePointerWithHover: boolean; softKeyboardOccludes: boolean | null }
  | { platform: "native"; nativeConnected: boolean };

/// Whether keys are arriving from a real keyboard rather than a glass one.
///
/// Native platforms are asked. The web cannot be asked, so it is measured: a
/// keyboard occupying part of the window is a keyboard whatever the device
/// class claims, and a device class is what the first version of this guessed
/// from -- which called a stylus a keyboard and a trackpad-less keyboard folio
/// no keyboard.
export function hasHardwareKeyboard(signal: HardwareKeyboardSignal): boolean {
  if (signal.platform === "native") return signal.nativeConnected;
  if (signal.softKeyboardOccludes !== null) return !signal.softKeyboardOccludes;
  return signal.finePointerWithHover;
}

/// How much of the window something is covering, against the tallest the
/// viewport has been. The tallest stands in for "nothing covering it", because
/// whether a soft keyboard also shrinks the layout viewport is the browser's
/// choice and not one this app pins.
export function softKeyboardOccludes(viewportHeight: number, unoccludedHeight: number): boolean {
  return unoccludedHeight - viewportHeight >= SOFT_KEYBOARD_MIN_OCCLUSION_PX;
}

function finePointerQuery(): MediaQueryList | undefined {
  if (Platform.OS !== "web" || typeof window === "undefined") return undefined;
  return window.matchMedia?.(FINE_POINTER_QUERY);
}

function finePointerWithHover(): boolean {
  return Boolean(finePointerQuery()?.matches);
}

/// `softKeyboardVisible` is the screen's own `useKeyboardVisible` value rather
/// than a second subscription to the same events: on iOS a change to it is when
/// a keyboard has been attached or detached, which is when the native answer is
/// worth asking for again. It is unused on web, which measures instead.
export function useHasHardwareKeyboard(softKeyboardVisible: boolean): boolean {
  const [connected, setConnected] = useState(() => Platform.OS === "web" && finePointerWithHover());
  const unoccludedHeight = useRef(0);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const viewport = window.visualViewport;
    const query = finePointerQuery();
    const apply = () => {
      let occludes: boolean | null = null;
      if (viewport) {
        unoccludedHeight.current = Math.max(unoccludedHeight.current, viewport.height);
        occludes = softKeyboardOccludes(viewport.height, unoccludedHeight.current);
      }
      setConnected(
        hasHardwareKeyboard({
          platform: "web",
          finePointerWithHover: Boolean(query?.matches),
          softKeyboardOccludes: occludes,
        }),
      );
    };
    apply();
    viewport?.addEventListener("resize", apply);
    query?.addEventListener?.("change", apply);
    return () => {
      viewport?.removeEventListener("resize", apply);
      query?.removeEventListener?.("change", apply);
    };
  }, []);

  useEffect(() => {
    if (Platform.OS === "web") return;
    let active = true;
    // Android has no such native module yet, so this answers false there and
    // Android keeps Enter as a newline rather than guessing. An inference from
    // the soft keyboard not appearing is not available: under edge-to-edge the
    // keyboard events can go missing entirely, and Android can show a soft
    // keyboard alongside a hardware one.
    void getNativeHardwareKeyboardConnected().then((nativeConnected) => {
      if (active) setConnected(hasHardwareKeyboard({ platform: "native", nativeConnected }));
    });
    return () => {
      active = false;
    };
  }, [softKeyboardVisible]);

  return connected;
}
