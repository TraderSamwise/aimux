import { Platform } from "react-native";

// Expo dev-client reloads can briefly report zero iOS safe-area insets.
// These floors keep chrome clear of the Dynamic Island and home indicator
// until react-native-safe-area-context reports real device metrics.
export const IOS_MIN_TOP_INSET = 54;
export const IOS_MIN_BOTTOM_INSET = 24;

export function resolveChromeTopInset(
  topInset: number,
  options: { reserveTopSafeArea?: boolean } = {},
): number {
  if (options.reserveTopSafeArea === false) return 0;
  if (Platform.OS === "web") return 0;
  if (Platform.OS === "ios") return Math.max(topInset, IOS_MIN_TOP_INSET);
  return topInset;
}

export function resolveChromeBottomInset(bottomInset: number): number {
  if (Platform.OS === "web") return 0;
  if (Platform.OS === "ios") return Math.max(bottomInset, IOS_MIN_BOTTOM_INSET);
  return bottomInset;
}

/// How far below the top of the window a banner sits on device.
///
/// `sonner-native`'s positioner computes `top: offset || top || 40`, so an
/// explicit offset REPLACES the safe-area inset instead of adding to it. A flat
/// 28 therefore put the banner under the Dynamic Island -- the same complaint
/// that moved it off the bottom, arriving at the other end of the screen.
///
/// It lives here rather than beside the palette so the web renderer, which has
/// no notch and never calls this, keeps no reason to reach for `Platform`.
export function resolveToastTopOffset(topInset: number): number {
  return resolveChromeTopInset(topInset) + TOAST_GAP_BELOW_CHROME;
}

const TOAST_GAP_BELOW_CHROME = 12;
