import React from "react";
import { Image, Platform, View } from "react-native";
import { Text } from "@/components/ui/text";

const FEATURES: Array<{ title: string; description: string }> = [
  {
    title: "Remote visibility",
    description: "Monitor agent sessions from your phone or another machine.",
  },
  {
    title: "Multi-project",
    description: "Switch between projects. Each with its own worktrees, agents, and services.",
  },
  {
    title: "Real-time",
    description: "Live status updates via SSE. See what your agents are doing right now.",
  },
];

interface BrandPanelProps {
  variant: "side" | "compact";
}

export function BrandPanel({ variant }: BrandPanelProps) {
  if (variant === "compact") {
    return (
      <View className="items-center mb-8">
        <Image
          source={require("@/assets/images/icon.png")}
          className="h-14 w-14 rounded-2xl mb-3"
          resizeMode="contain"
          accessibilityLabel="aimux logo"
        />
        <Text className="font-mono text-[32px] font-bold text-foreground tracking-tight">
          aimux
        </Text>
        <Text className="text-[14px] text-muted-foreground mt-2 text-center">
          Manage your AI agents from anywhere.
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-secondary px-12 py-16 justify-between">
      <View>
        <View className="flex-row items-center">
          <Image
            source={require("@/assets/images/icon.png")}
            className="h-12 w-12 rounded-xl mr-3"
            resizeMode="contain"
            accessibilityLabel="aimux logo"
          />
          <Text className="font-mono text-[44px] font-bold text-foreground tracking-tight">
            aimux
          </Text>
        </View>
        <Text className="text-[18px] text-muted-foreground mt-5 leading-relaxed max-w-[360px]">
          Manage your AI agents from anywhere. One dashboard for Claude, Codex, and shell sessions.
        </Text>

        <View className="mt-12">
          {FEATURES.map((feature) => (
            <View key={feature.title} className="flex-row items-start mb-5 max-w-[380px]">
              <View className="w-1.5 h-1.5 rounded-full bg-emerald-500 mt-2 mr-3" />
              <View className="flex-1">
                <Text className="text-[14px] font-semibold text-foreground">{feature.title}</Text>
                <Text className="text-[13px] text-muted-foreground mt-0.5 leading-snug">
                  {feature.description}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>

      {Platform.OS === "web" ? (
        <View className="rounded-md border border-border bg-background/60 px-4 py-3 max-w-[360px]">
          <Text className="font-mono text-[12px] text-muted-foreground">$ aimux serve</Text>
          <Text className="text-[11px] text-muted-foreground/70 mt-1">
            Run locally to connect your agents.
          </Text>
        </View>
      ) : null}
    </View>
  );
}
