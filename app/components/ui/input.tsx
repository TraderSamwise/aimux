import * as React from "react";
import { TextInput, type TextInputProps } from "react-native";
import { cn } from "@/lib/utils";

/**
 * The browser draws its own focus ring on a focused field, at the field's own
 * rounding. Inside a container that draws the border itself — the chat composer,
 * where the field is borderless and the card is the visible object — that lands as
 * a second rounded rectangle inset within the first. Suppress it and let whatever
 * owns the border own the focus state too.
 *
 * `outlineStyle` is react-native-web's, and is dropped on native, where there is no
 * focus ring to begin with.
 */
export const NO_BROWSER_FOCUS_RING = {
  outlineStyle: "none",
  outlineWidth: 0,
} as unknown as TextInputProps["style"];

const Input = React.forwardRef<TextInput, TextInputProps>(({ className, style, ...props }, ref) => {
  return (
    <TextInput
      ref={ref}
      className={cn(
        // Own focus ring in place of the browser's: a border tint at the field's
        // real rounding, so nothing is drawn inside it.
        "h-11 rounded-lg border border-border bg-background px-3 py-0 text-base text-foreground placeholder:text-muted-foreground focus:border-ring",
        className,
      )}
      // Caller styles last: this used to spread props after `style`, so any style a
      // caller passed silently replaced the line height rather than adding to it.
      style={[{ lineHeight: 16 }, NO_BROWSER_FOCUS_RING, style]}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
