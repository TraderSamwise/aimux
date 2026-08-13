import React from "react";
import { Stack } from "expo-router";
import { useAppStackScreenOptions } from "@/lib/navigation";

export default function LoopsStackLayout() {
  const stackScreenOptions = useAppStackScreenOptions();
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" />
    </Stack>
  );
}
