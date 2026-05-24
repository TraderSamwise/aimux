import React from "react";
import { Tabs } from "expo-router";
import { MobileTabBar } from "@/components/MobileTabBar";

export const unstable_settings = {
  initialRouteName: "(dashboard)",
};

export default function MainTabsLayout() {
  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        headerShown: false,
        freezeOnBlur: true,
      }}
      tabBar={(props) => <MobileTabBar {...props} />}
    >
      <Tabs.Screen name="(dashboard)" />
      <Tabs.Screen name="(inbox)" />
      <Tabs.Screen name="(threads)" />
      <Tabs.Screen name="(settings)" />
    </Tabs>
  );
}
