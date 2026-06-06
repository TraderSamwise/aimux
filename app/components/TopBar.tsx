import React from "react";
import { Image, Pressable, View } from "react-native";
import { usePathname, useRouter, type Href } from "expo-router";
import { useAtomValue } from "jotai";
import { Bell, MessageSquare } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AuthMenu } from "@/components/AuthMenu";
import { RelayIndicator } from "@/components/RelayIndicator";
import { resolveChromeTopInset } from "@/lib/native-safe-area";
import { cn } from "@/lib/utils";
import { Text } from "@/components/ui/text";
import { relayConfiguredAtom } from "@/stores/relay";

function TopBarRouteButton({
  href,
  activePrefix,
  label,
  icon: Icon,
}: {
  href: Href;
  activePrefix: string;
  label: string;
  icon: typeof MessageSquare;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const active = pathname.startsWith(activePrefix);

  return (
    <Pressable
      accessibilityLabel={label}
      onPress={() => {
        if (!active) router.navigate(href);
      }}
      className={cn(
        "h-9 w-9 items-center justify-center rounded-lg border border-border active:bg-accent",
        active ? "bg-accent" : "bg-transparent",
      )}
    >
      <Icon size={17} color={active ? "#fafafa" : "#a1a1aa"} />
    </Pressable>
  );
}

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
          style={{ width: 24, height: 24, borderRadius: 6, marginRight: 8 }}
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
      <View className="mr-2">
        <TopBarRouteButton
          href={"/global-threads" as Href}
          activePrefix="/global-threads"
          label="Global threads"
          icon={MessageSquare}
        />
      </View>
      <View className="mr-3">
        <TopBarRouteButton
          href={"/global-notifications" as Href}
          activePrefix="/global-notifications"
          label="Global inbox"
          icon={Bell}
        />
      </View>
      <AuthMenu />
    </View>
  );
}
