import * as React from "react";
import { View, type ViewProps } from "react-native";
import { cn } from "@/lib/utils";

interface SeparatorProps extends ViewProps {
  orientation?: "horizontal" | "vertical";
}

const Separator = React.forwardRef<View, SeparatorProps>(
  ({ className, orientation = "horizontal", ...props }, ref) => (
    <View
      ref={ref}
      className={cn(
        "bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  ),
);
Separator.displayName = "Separator";

export { Separator };
