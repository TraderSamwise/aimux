import React from "react";
import { View } from "react-native";
import { useAtomValue } from "jotai";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AuthMenu } from "@/components/AuthMenu";
import { RelayIndicator } from "@/components/RelayIndicator";
import { resolveChromeTopInset } from "@/lib/native-safe-area";
import { Text } from "@/components/ui/text";
import { relayConfiguredAtom } from "@/stores/relay";

export function TopBar({ left }: { left?: React.ReactNode }) {
  const relayConfigured = useAtomValue(relayConfiguredAtom);
  const insets = useSafeAreaInsets();
  const topInset = resolveChromeTopInset(insets.top);

  return (
    <View
      className="z-30 flex-row items-center justify-between border-b border-border bg-card px-4"
      style={{ height: 56 + topInset, paddingTop: topInset }}
    >
      {left ? <View className="-ml-1 mr-2">{left}</View> : null}
      <Text className="font-mono text-[17px] font-bold text-foreground">aimux</Text>
      <View className="flex-1" />
      {relayConfigured ? (
        <View className="mr-3">
          <RelayIndicator />
        </View>
      ) : null}
      <AuthMenu />
    </View>
  );
}
