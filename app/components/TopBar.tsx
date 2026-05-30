import React from "react";
import { Image, View } from "react-native";
import { useAtomValue } from "jotai";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AuthMenu } from "@/components/AuthMenu";
import { NotificationBellButton } from "@/components/NotificationBellButton";
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
      <View className="flex-row items-center">
        <Image
          source={require("@/assets/images/icon.png")}
          className="h-6 w-6 rounded-md mr-2"
          resizeMode="contain"
          accessibilityLabel="aimux logo"
        />
        <Text className="font-mono text-[17px] font-bold text-foreground">aimux</Text>
      </View>
      <View className="flex-1" />
      {relayConfigured ? (
        <View className="mr-3">
          <RelayIndicator />
        </View>
      ) : null}
      <View className="mr-3">
        <NotificationBellButton compact />
      </View>
      <AuthMenu />
    </View>
  );
}
