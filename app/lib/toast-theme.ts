// Colours and placement for both toast renderers. sonner and sonner-native
// take inline style objects rather than classes, so the palette has to be
// concrete rather than a tailwind token.
import { resolveChromeTopInset } from "@/lib/native-safe-area";
export type ToastTheme = "light" | "dark";

/// Which edge banners sit on, once rather than once per platform file.
///
/// At the bottom they sat over the agent transcript you are reading, and an
/// error about a project list covered the sentence you were mid-way through.
export const TOAST_POSITION = "top-center" as const;

/// How far below the top of the window a banner sits on web, where there is no
/// notch to clear.
export const TOAST_WEB_TOP_OFFSET = 28;

/// The same gap on device, measured from whatever the safe area turns out to
/// be.
///
/// `sonner-native`'s positioner computes `top: offset || top || 40`, so an
/// explicit offset REPLACES the safe-area inset instead of adding to it. A
/// flat 28 therefore put the banner under the Dynamic Island -- this repo's
/// own floor for clearing it is `IOS_MIN_TOP_INSET = 54`.
export function toastTopOffset(topInset: number): number {
  return resolveChromeTopInset(topInset) + 12;
}

export type { AppToastOptions } from "@/lib/toast-shared";

export interface ToastPalette {
  background: string;
  foreground: string;
  muted: string;
  border: string;
  success: string;
  error: string;
  warning: string;
  info: string;
}

const PALETTES: Record<ToastTheme, ToastPalette> = {
  dark: {
    background: "#1a1b20",
    foreground: "#edeef0",
    muted: "#a0a2ab",
    border: "#30313a",
    success: "#4ade80",
    error: "#f87171",
    warning: "#fbbf24",
    info: "#60a5fa",
  },
  light: {
    background: "#ffffff",
    foreground: "#111216",
    muted: "#5b5d66",
    border: "#d9dae0",
    success: "#16a34a",
    error: "#dc2626",
    warning: "#b45309",
    info: "#2563eb",
  },
};

export function toastPalette(theme: ToastTheme): ToastPalette {
  return PALETTES[theme] ?? PALETTES.dark;
}
