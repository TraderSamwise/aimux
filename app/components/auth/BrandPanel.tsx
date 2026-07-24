import React from "react";
import { Image, Platform, View } from "react-native";
import { Text } from "@/components/ui/text";

const FEATURES: Array<{ title: string; description: string }> = [
  {
    title: "Native terminals",
    description: "Claude, Codex, Aider, and shell sessions keep their own TUIs.",
  },
  {
    title: "Project control",
    description: "Switch across projects, worktrees, agents, services, and teammates.",
  },
  {
    title: "Remote check-ins",
    description: "Use web or mobile as clients of the same local daemon.",
  },
];
const WEB_INSTALL_COMMAND =
  "$ curl -fsSL https://raw.githubusercontent.com/TraderSamwise/aimux/master/scripts/install.sh | sh";

interface BrandPanelProps {
  variant: "side" | "compact";
}

export function BrandPanel({ variant }: BrandPanelProps) {
  if (variant === "compact") {
    return (
      <View className="items-center mb-8">
        <Image
          source={require("@/assets/images/icon.png")}
          style={{ width: 56, height: 56, borderRadius: 16, marginBottom: 12 }}
          resizeMode="contain"
          accessibilityLabel="aimux logo"
        />
        <Text className="font-mono text-[32px] font-bold text-foreground tracking-tight">
          aimux
        </Text>
        <Text className="text-[14px] text-muted-foreground mt-2 text-center">
          Local control plane for AI coding agents.
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
            style={{ width: 48, height: 48, borderRadius: 12, marginRight: 12 }}
            resizeMode="contain"
            accessibilityLabel="aimux logo"
          />
          <Text className="font-mono text-[44px] font-bold text-foreground tracking-tight">
            aimux
          </Text>
        </View>
        <Text className="text-[18px] text-muted-foreground mt-5 leading-relaxed max-w-[360px]">
          Multiplex long-running AI coding agents without replacing their terminals. One dashboard
          for Claude, Codex, Aider, shell sessions, and worktrees.
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
          <Text className="font-mono text-[12px] text-muted-foreground">{WEB_INSTALL_COMMAND}</Text>
          <Text className="font-mono text-[12px] text-muted-foreground/70 mt-1">$ aimux login</Text>
        </View>
      ) : null}
    </View>
  );
}
