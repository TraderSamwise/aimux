import React, { useEffect, useRef } from "react";
import { Platform, View } from "react-native";
import { Stack } from "expo-router";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { listProjects } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useProjectsStore } from "@/stores/projects";

const POLL_INTERVAL_MS = 2000;

export default function MainLayout() {
  const setProjects = useProjectsStore((s) => s.setProjects);
  const { getToken } = useAuth();
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function loop() {
      if (cancelled) return;
      try {
        const token = await getToken();
        if (!cancelled) tokenRef.current = token;
        const projects = await listProjects({ token });
        if (!cancelled) setProjects(projects);
      } catch (err) {
        // Failed fetches report inline per-operation; no global UI per task description.
        if (!cancelled) console.warn("project list refresh failed:", err);
      }
      if (cancelled) return;
      timer = setTimeout(loop, POLL_INTERVAL_MS);
    }

    void loop();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [getToken, setProjects]);

  return (
    <View
      className="flex-1 bg-background"
      style={Platform.OS === "web" ? { flexDirection: "row" } : undefined}
    >
      {Platform.OS === "web" ? <ProjectSidebar /> : null}
      <View className="flex-1">
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="agent/[sessionId]/chat" />
          <Stack.Screen name="plans/[sessionId]" />
          <Stack.Screen name="threads" />
          <Stack.Screen name="graveyard" />
        </Stack>
      </View>
    </View>
  );
}
