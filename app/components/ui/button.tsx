import * as React from "react";
import { Pressable, type PressableProps } from "react-native";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Text } from "./text";

const buttonVariants = cva("flex-row items-center justify-center rounded-lg", {
  variants: {
    variant: {
      default: "bg-primary",
      secondary: "bg-secondary",
      outline: "border border-border bg-transparent",
      ghost: "bg-transparent",
      destructive: "bg-destructive",
    },
    size: {
      default: "h-11 px-4 py-2",
      sm: "h-9 px-3",
      lg: "h-12 px-6",
      icon: "h-10 w-10",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

const buttonTextVariants = cva("font-medium", {
  variants: {
    variant: {
      default: "text-primary-foreground",
      secondary: "text-secondary-foreground",
      outline: "text-foreground",
      ghost: "text-foreground",
      destructive: "text-destructive-foreground",
    },
    size: {
      default: "text-base",
      sm: "text-sm",
      lg: "text-lg",
      icon: "text-base",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

interface ButtonProps extends PressableProps, VariantProps<typeof buttonVariants> {
  label?: string;
  children?: React.ReactNode;
}

const Button = React.forwardRef<React.ComponentRef<typeof Pressable>, ButtonProps>(
  ({ className, variant, size, label, children, ...props }, ref) => {
    return (
      <Pressable
        ref={ref}
        className={cn(buttonVariants({ variant, size }), props.disabled && "opacity-50", className)}
        {...props}
      >
        {children ?? <Text className={cn(buttonTextVariants({ variant, size }))}>{label}</Text>}
      </Pressable>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants, buttonTextVariants };
