import React from "react";
import { Platform, Pressable, View, useWindowDimensions } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useGlobalSearchParams } from "expo-router";
import { useAtomValue } from "jotai";
import { Bell, BookOpen, FolderKanban, Network } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { resolveChromeBottomInset } from "@/lib/native-safe-area";
import { useKeyboardInset } from "@/lib/use-keyboard-inset";
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
  const collapses = Platform.OS === "ios";
  const keyboardVisible = useKeyboardVisible(!collapses);
  const keyboardInset = useKeyboardInset();
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const searchParams = useGlobalSearchParams() as Record<string, SearchValue>;
  const currentProjectPath =
    projectPathFromSearchOrLocation(searchParams.project) ?? selectedProjectPath;

  const barHeight = 56 + bottomInset;
  // Give the bar's height back to the keyboard as it rises, so whatever sits above
  // the bar stays a constant max(bar, keyboard) from the bottom of the screen. Drop
  // the bar outright instead and that content falls the bar's height before the
  // keyboard lifts it again, which is the jump this replaces.
  const collapse = useAnimatedStyle(() => ({
    height: Math.max(0, barHeight - keyboardInset.value),
  }));
  if (!isMobile || (!collapses && keyboardVisible)) return null;

  return (
    // Animated.View carries plain styles only; NativeWind does not interop it. It
    // clips rather than squashes, so the icons slide away at full size.
    <Animated.View style={[{ height: barHeight, overflow: "hidden" }, collapses ? collapse : null]}>
      <View
        className="flex-row border-t border-border bg-card"
        style={{ height: barHeight, paddingBottom: bottomInset }}
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
    </Animated.View>
  );
}
