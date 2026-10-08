import { useEffect, useState } from "react";
import { Platform } from "react-native";

import {
  getNativeHardwareKeyboardConnected,
  subscribeNativeAppCommands,
} from "./native-app-commands";

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

/// How much of the layout viewport the visual viewport is not showing.
///
/// A soft keyboard shrinks the visual viewport and leaves the layout viewport
/// alone, so the gap between them is the keyboard. Measuring against the
/// tallest the viewport had been instead would survive no rotation and no
/// window resize: shrinking a desktop window past the threshold would read as
/// a keyboard forever.
///
/// It cannot see a floating or split on-screen keyboard, which overlays the
/// page and takes nothing from it. `shouldSubmitComposerKey` catches those
/// from the event's empty `code` instead.
export function softKeyboardOccludes(viewportHeight: number, layoutHeight: number): boolean {
  return layoutHeight - viewportHeight >= SOFT_KEYBOARD_MIN_OCCLUSION_PX;
}

function finePointerQuery(): MediaQueryList | undefined {
  if (Platform.OS !== "web" || typeof window === "undefined") return undefined;
  return window.matchMedia?.(FINE_POINTER_QUERY);
}

export function useHasHardwareKeyboard(): boolean {
  // Nothing is known before the first measurement, and an unknown must take
  // the soft-keyboard path: starting false costs a desktop a newline on an
  // Enter pressed before the effect runs, where starting true would send on a
  // phone and eat the line break.
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const viewport = window.visualViewport;
    const query = finePointerQuery();
    const apply = () => {
      // Scaled because a pinch zoom shrinks the visual viewport with nothing
      // covering it, and that gap is not a keyboard.
      const occludes = viewport
        ? softKeyboardOccludes(viewport.height * viewport.scale, window.innerHeight)
        : null;
      setConnected(
        hasHardwareKeyboard({
          platform: "web",
          finePointerWithHover: Boolean(query?.matches),
          softKeyboardOccludes: occludes,
        }),
      );
    };
    apply();
    // iOS Safari offsets the visual viewport for the keyboard as well as
    // resizing it, and does not always report both.
    viewport?.addEventListener("resize", apply);
    viewport?.addEventListener("scroll", apply);
    query?.addEventListener?.("change", apply);
    return () => {
      viewport?.removeEventListener("resize", apply);
      viewport?.removeEventListener("scroll", apply);
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
    const refresh = () => {
      void getNativeHardwareKeyboardConnected().then((nativeConnected) => {
        if (active) setConnected(hasHardwareKeyboard({ platform: "native", nativeConnected }));
      });
    };
    refresh();
    // A keyboard attached after launch moves no keyboard frame and raises no
    // keyboard event, so the native side says when it happens instead.
    const unsubscribe = subscribeNativeAppCommands((command) => {
      if (command === "hardwareKeyboardChanged") refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return connected;
}
