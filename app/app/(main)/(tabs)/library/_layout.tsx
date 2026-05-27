import React from "react";
import { Stack } from "expo-router";

export default function LibraryStackLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="agent/[sessionId]/chat" />
      <Stack.Screen name="service/[serviceId]" />
    </Stack>
  );
}
