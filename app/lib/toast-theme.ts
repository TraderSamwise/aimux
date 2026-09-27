// Colours for both toast renderers. sonner and sonner-native take inline style
// objects rather than classes, so the palette has to be concrete rather than a
// tailwind token.
export type ToastTheme = "light" | "dark";

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
