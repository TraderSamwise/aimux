import React from "react";
import { Stack } from "expo-router";
import { useAppStackScreenOptions } from "@/lib/navigation";

export default function SettingsStackLayout() {
  const stackScreenOptions = useAppStackScreenOptions();
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="settings" />
    </Stack>
  );
}
