import React from "react";
import { Platform } from "react-native";
import { Tabs } from "expo-router";
import { MobileTabBar } from "@/components/MobileTabBar";

export const unstable_settings = {
  initialRouteName: "project",
};

export default function MainTabsLayout() {
  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        freezeOnBlur: Platform.OS !== "web",
      }}
      tabBar={(props) => <MobileTabBar {...props} />}
    >
      <Tabs.Screen name="(dashboard)" />
      <Tabs.Screen name="coordination" />
      <Tabs.Screen name="topology" />
      <Tabs.Screen name="project" />
      <Tabs.Screen name="library" />
      <Tabs.Screen name="notifications" />
      <Tabs.Screen name="threads" />
      <Tabs.Screen name="(settings)" />
    </Tabs>
  );
}
