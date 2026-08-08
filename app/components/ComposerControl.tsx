import type { ReactNode } from "react";
import { Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** Square when icon-only, so a narrow composer keeps a round tap target. */
export const COMPOSER_CONTROL_SIZE = 34;
/** Below this the labels come off; three labelled pills stop fitting beside the text. */
export const COMPOSER_CONTROL_LABEL_WIDTH = 640;

/**
 * One button in the composer's control row.
 *
 * `wide` carries the label as well as the icon. The accessibility label is
 * separate and says what actually happens, so the visible word can stay short
 * enough to fit.
 */
export function ComposerControl({
  icon,
  label,
  accessibilityLabel,
  wide,
  brand = false,
  disabled = false,
  onPress,
}: {
  icon: ReactNode;
  label: string;
  accessibilityLabel: string;
  wide: boolean;
  brand?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={
        wide
          ? { height: COMPOSER_CONTROL_SIZE }
          : { width: COMPOSER_CONTROL_SIZE, height: COMPOSER_CONTROL_SIZE }
      }
      className={cn(
        "flex-row items-center justify-center gap-1.5 rounded-full border active:opacity-80",
        wide && "px-3.5",
        brand ? "border-primary bg-primary" : "border-border bg-secondary",
        disabled && "opacity-40",
      )}
    >
      {icon}
      {wide ? (
        <Text
          className={cn("text-sm", brand ? "text-primary-foreground" : "text-secondary-foreground")}
        >
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}
