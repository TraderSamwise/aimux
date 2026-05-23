import { Platform } from "react-native";

// Expo dev-client reloads can briefly report zero iOS safe-area insets.
// These floors keep chrome clear of the Dynamic Island and home indicator
// until react-native-safe-area-context reports real device metrics.
export const IOS_MIN_TOP_INSET = 54;
export const IOS_MIN_BOTTOM_INSET = 24;

export function resolveChromeTopInset(topInset: number): number {
  if (Platform.OS === "web") return 0;
  if (Platform.OS === "ios") return Math.max(topInset, IOS_MIN_TOP_INSET);
  return topInset;
}

export function resolveChromeBottomInset(bottomInset: number): number {
  if (Platform.OS === "web") return 0;
  if (Platform.OS === "ios") return Math.max(bottomInset, IOS_MIN_BOTTOM_INSET);
  return bottomInset;
}
