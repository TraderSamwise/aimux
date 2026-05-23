import React from "react";
import { Pressable, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { Bell, Home, MessageSquare, Settings } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { resolveChromeBottomInset } from "@/lib/native-safe-area";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { notificationUnreadCountFamily } from "@/stores/notifications";
import { selectedProjectPathAtom } from "@/stores/projects";

const TABS = [
  { label: "Dashboard", route: "/", Icon: Home },
  { label: "Inbox", route: "/notifications", Icon: Bell },
  { label: "Threads", route: "/threads", Icon: MessageSquare },
  { label: "Settings", route: "/settings", Icon: Settings },
] as const;

const EMPTY_PROJECT_PATH = "__aimux_no_selected_project__";

function isActive(pathname: string, route: string): boolean {
  if (route === "/") return pathname === "/" || pathname === "/(main)";
  return pathname.startsWith(route);
}

function formatCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function MobileTabBar() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const bottomInset = resolveChromeBottomInset(insets.bottom);
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const unreadCount = useAtomValue(
    notificationUnreadCountFamily(selectedProjectPath ?? EMPTY_PROJECT_PATH),
  );

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
            <View>
              <Icon size={20} color="#a1a1aa" />
              {route === "/notifications" && unreadCount > 0 ? (
                <View className="absolute -right-2 -top-1 min-w-[17px] rounded-full bg-emerald-500 px-1">
                  <Text className="text-center text-[9px] font-bold leading-none text-black">
                    {formatCount(unreadCount)}
                  </Text>
                </View>
              ) : null}
            </View>
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
