import React from "react";
import { Stack } from "expo-router";

export default function TopologyStackLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="agent/[sessionId]/chat" />
      <Stack.Screen name="service/[serviceId]" />
    </Stack>
  );
}
