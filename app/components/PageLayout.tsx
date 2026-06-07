import React from "react";
import { ScrollView, View } from "react-native";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export function Page({
  children,
  className,
  contentClassName,
}: {
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <ScrollView
      className={cn("flex-1 bg-background", className)}
      contentContainerClassName={cn("px-4 py-5 md:px-8", contentClassName)}
    >
      <View className="w-full">{children}</View>
    </ScrollView>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  className,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string | null;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <View className={cn("mb-5 flex-row items-start justify-between gap-3", className)}>
      <View className="min-w-0 flex-1">
        {eyebrow ? (
          <Text className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
            {eyebrow}
          </Text>
        ) : null}
        <Text
          className="mt-1 text-[28px] font-bold leading-tight text-foreground"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {title}
        </Text>
        {subtitle ? (
          <Text className="mt-1 text-sm text-muted-foreground" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {actions ? <View>{actions}</View> : null}
    </View>
  );
}

export function PageStateCard({
  title,
  body,
  tone = "default",
  className,
}: {
  title: string;
  body?: string;
  tone?: "default" | "warning" | "danger";
  className?: string;
}) {
  return (
    <Card
      className={cn(
        "rounded-lg p-5",
        tone === "warning" && "border-amber-500/40 bg-amber-500/10",
        tone === "danger" && "border-destructive/50 bg-destructive/10",
        className,
      )}
    >
      <Text className="text-base font-semibold text-foreground">{title}</Text>
      {body ? <Text className="mt-1 text-sm text-muted-foreground">{body}</Text> : null}
    </Card>
  );
}
