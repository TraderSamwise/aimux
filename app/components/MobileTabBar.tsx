import React from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useAtomValue } from "jotai";
import { Bell, FolderKanban, Home, MessageSquare, Network, Settings } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { resolveChromeBottomInset } from "@/lib/native-safe-area";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { MAIN_TAB_ROUTES, type MainTabId } from "@/lib/main-tabs";
import { notificationUnreadCountFamily } from "@/stores/notifications";
import { selectedProjectPathAtom } from "@/stores/projects";
import { securityUnreadCountAtom } from "@/stores/security";

const TABS = [
  { id: "dashboard", label: "Dashboard", Icon: Home },
  { id: "topology", label: "Topology", Icon: Network },
  { id: "project", label: "Project", Icon: FolderKanban },
  { id: "inbox", label: "Inbox", Icon: Bell },
  { id: "threads", label: "Threads", Icon: MessageSquare },
  { id: "settings", label: "Settings", Icon: Settings },
] as const;

const EMPTY_PROJECT_PATH = "__aimux_no_selected_project__";

function formatCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function MobileTabBar({ state, navigation }: BottomTabBarProps) {
  const { width } = useWindowDimensions();
  const isMobile = width < 640;
  const insets = useSafeAreaInsets();
  const bottomInset = resolveChromeBottomInset(insets.bottom);
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const unreadCount = useAtomValue(
    notificationUnreadCountFamily(selectedProjectPath ?? EMPTY_PROJECT_PATH),
  );
  const securityUnreadCount = useAtomValue(securityUnreadCountAtom);
  const inboxUnreadCount = unreadCount + securityUnreadCount;

  if (!isMobile) return null;

  return (
    <View
      className="flex-row border-t border-border bg-card"
      style={{ height: 56 + bottomInset, paddingBottom: bottomInset }}
    >
      {TABS.map(({ id, label, Icon }) => {
        const tabId = id as MainTabId;
        const tabRoute = MAIN_TAB_ROUTES[tabId];
        const route = state.routes.find((candidate) => candidate.name === tabRoute.screen);
        if (!route) return null;
        const active = state.routes[state.index]?.key === route.key;
        return (
          <Pressable
            key={id}
            onPress={() => {
              const event = navigation.emit({
                type: "tabPress",
                target: route.key,
                canPreventDefault: true,
              });
              if (!active && !event.defaultPrevented) {
                navigation.navigate(route.name, route.params);
              }
            }}
            className="flex-1 items-center justify-center active:bg-accent/50"
          >
            {active ? <View className="absolute top-0 h-0.5 w-full bg-foreground" /> : null}
            <View>
              <Icon size={20} color="#a1a1aa" />
              {id === "inbox" && inboxUnreadCount > 0 ? (
                <View className="absolute -right-2 -top-1 min-w-[17px] rounded-full bg-emerald-500 px-1">
                  <Text className="text-center text-[9px] font-bold leading-none text-black">
                    {formatCount(inboxUnreadCount)}
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
