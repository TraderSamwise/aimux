import React from "react";
import { View } from "react-native";
import { AuthMenu } from "@/components/AuthMenu";
import { Text } from "@/components/ui/text";

export function TopBar({ left }: { left?: React.ReactNode }) {
  return (
    <View className="z-30 h-14 flex-row items-center justify-between border-b border-border bg-card px-4">
      {left ? <View className="-ml-1 mr-2">{left}</View> : null}
      <Text className="font-mono text-[17px] font-bold text-foreground">aimux</Text>
      <View className="flex-1" />
      <AuthMenu />
    </View>
  );
}
