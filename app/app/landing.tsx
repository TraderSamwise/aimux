import React from "react";
import { Platform, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

export default function LandingScreen() {
  const router = useRouter();

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-1 items-center justify-center px-8 py-16"
    >
      <View className="max-w-[560px] w-full items-center">
        <Text className="font-mono text-[42px] font-bold text-foreground tracking-tight">
          aimux
        </Text>
        <Text className="text-[18px] text-muted-foreground mt-4 text-center leading-relaxed">
          Manage your AI agents from anywhere.{"\n"}One dashboard for Claude, Codex, and shell
          sessions.
        </Text>

        <View className="mt-10 w-full max-w-[320px]">
          <Button label="Get started" onPress={() => router.push("/sign-up")} />
          <Button
            className="mt-3"
            variant="outline"
            label="Sign in"
            onPress={() => router.push("/sign-in")}
          />
        </View>

        <View className="mt-16 w-full">
          <FeatureRow
            title="Remote visibility"
            description="Monitor agent sessions from your phone or another machine."
          />
          <FeatureRow
            title="Multi-project"
            description="Switch between projects. Each with its own worktrees, agents, and services."
          />
          <FeatureRow
            title="Real-time"
            description="Live status updates via SSE. See what your agents are doing right now."
          />
        </View>

        {Platform.OS === "web" ? (
          <Text className="text-[11px] text-muted-foreground/50 mt-16">
            Run `aimux serve` locally to connect your agents.
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

function FeatureRow({ title, description }: { title: string; description: string }) {
  return (
    <View className="flex-row items-start mb-5">
      <View className="w-1.5 h-1.5 rounded-full bg-emerald-500 mt-2 mr-3" />
      <View className="flex-1">
        <Text className="text-[14px] font-semibold text-foreground">{title}</Text>
        <Text className="text-[13px] text-muted-foreground mt-0.5 leading-snug">{description}</Text>
      </View>
    </View>
  );
}
