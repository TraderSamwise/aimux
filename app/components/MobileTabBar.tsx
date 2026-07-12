import React from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useGlobalSearchParams } from "expo-router";
import { useAtomValue } from "jotai";
import { Bell, BookOpen, FolderKanban, Network } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { resolveChromeBottomInset } from "@/lib/native-safe-area";
import { useKeyboardVisible } from "@/lib/use-keyboard-visible";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { MAIN_TAB_ROUTES, navigateMainTab, type MainTabId } from "@/lib/main-tabs";
import { projectPathFromSearchOrLocation, type SearchValue } from "@/lib/view-location";
import { selectedProjectPathAtom } from "@/stores/projects";

const TABS = [
  { id: "project", label: "Project", Icon: FolderKanban },
  { id: "coordination", label: "Coord", Icon: Bell },
  { id: "topology", label: "Topology", Icon: Network },
  { id: "library", label: "Library", Icon: BookOpen },
] as const;

export function MobileTabBar({ state, navigation }: BottomTabBarProps) {
  const { width } = useWindowDimensions();
  const isMobile = width < 640;
  const insets = useSafeAreaInsets();
  const bottomInset = resolveChromeBottomInset(insets.bottom);
  const keyboardVisible = useKeyboardVisible();
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const searchParams = useGlobalSearchParams() as Record<string, SearchValue>;
  const currentProjectPath =
    projectPathFromSearchOrLocation(searchParams.project) ?? selectedProjectPath;

  if (!isMobile || keyboardVisible) return null;

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
                navigateMainTab(navigation, tabId, currentProjectPath);
              }
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
