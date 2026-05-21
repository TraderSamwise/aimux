import * as React from "react";
import { TextInput, type TextInputProps } from "react-native";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<TextInput, TextInputProps>(({ className, ...props }, ref) => {
  return (
    <TextInput
      ref={ref}
      className={cn(
        "h-11 rounded-lg border border-border bg-background px-3 py-0 text-base text-foreground placeholder:text-muted-foreground",
        className,
      )}
      style={{ lineHeight: 16 }}
      {...props}
    />
  );
});
Input.displayName = "Input";

export { Input };
