import React from "react";
import { Platform, Pressable, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { Home, MessageSquare, Settings } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const TABS = [
  { label: "Dashboard", route: "/", Icon: Home },
  { label: "Threads", route: "/threads", Icon: MessageSquare },
  { label: "Settings", route: "/settings", Icon: Settings },
] as const;

function isActive(pathname: string, route: string): boolean {
  if (route === "/") return pathname === "/" || pathname === "/(main)";
  return pathname.startsWith(route);
}

export function MobileTabBar() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const bottomInset =
    Platform.OS === "web"
      ? 0
      : Platform.OS === "ios"
        ? Math.max(insets.bottom, 24)
        : insets.bottom;

  return (
    <View
      className="flex-row border-t border-border bg-card"
      style={{ height: 56 + bottomInset, paddingBottom: bottomInset }}
    >
      {TABS.map(({ label, route, Icon }) => {
        const active = isActive(pathname, route);
        return (
          <Pressable
            key={route}
            onPress={() => {
              if (!active) router.replace(route);
            }}
            className="flex-1 items-center justify-center active:bg-accent/50"
          >
            {active ? <View className="absolute top-0 h-0.5 w-full bg-foreground" /> : null}
            <Icon size={20} color="#a1a1aa" />
            <Text
              className={cn(
                "mt-0.5 text-[10px]",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
