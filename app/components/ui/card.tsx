import * as React from "react";
import { View, type ViewProps, Pressable, type PressableProps } from "react-native";
import { cn } from "@/lib/utils";
import { Text } from "./text";

const Card = React.forwardRef<View, ViewProps>(({ className, ...props }, ref) => (
  <View
    ref={ref}
    className={cn("rounded-xl border border-border bg-card p-3", className)}
    {...props}
  />
));
Card.displayName = "Card";

const PressableCard = React.forwardRef<
  React.ComponentRef<typeof Pressable>,
  PressableProps & { className?: string }
>(({ className, ...props }, ref) => (
  <Pressable
    ref={ref}
    className={cn("rounded-xl border border-border bg-card p-3 active:opacity-80", className)}
    {...props}
  />
));
PressableCard.displayName = "PressableCard";

const CardTitle = React.forwardRef<
  React.ComponentRef<typeof Text>,
  React.ComponentProps<typeof Text>
>(({ className, ...props }, ref) => (
  <Text
    ref={ref}
    className={cn("text-lg font-semibold text-card-foreground", className)}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  React.ComponentRef<typeof Text>,
  React.ComponentProps<typeof Text>
>(({ className, ...props }, ref) => (
  <Text ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

export { Card, PressableCard, CardTitle, CardDescription };
