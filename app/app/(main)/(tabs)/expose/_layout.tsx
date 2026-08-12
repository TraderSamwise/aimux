import React from "react";
import { Stack } from "expo-router";

export default function ExposeStackLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="service/[serviceId]" />
    </Stack>
  );
}
