import * as React from "react";
import { View, type ViewProps } from "react-native";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Text } from "./text";

const badgeVariants = cva("items-center rounded-full px-2.5 py-0.5", {
  variants: {
    variant: {
      default: "bg-primary",
      secondary: "bg-secondary",
      outline: "border border-border bg-transparent",
      common: "bg-green-100 dark:bg-green-900",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

const badgeTextVariants = cva("text-xs font-medium", {
  variants: {
    variant: {
      default: "text-primary-foreground",
      secondary: "text-secondary-foreground",
      outline: "text-foreground",
      common: "text-green-800 dark:text-green-200",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

interface BadgeProps extends ViewProps, VariantProps<typeof badgeVariants> {
  label: string;
}

function Badge({ className, variant, label, ...props }: BadgeProps) {
  return (
    <View className={cn(badgeVariants({ variant }), className)} {...props}>
      <Text className={cn(badgeTextVariants({ variant }))}>{label}</Text>
    </View>
  );
}

export { Badge, badgeVariants };
