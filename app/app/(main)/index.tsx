import React from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { Text } from "@/components/ui/text";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { selectedProjectFromState, useProjectsStore } from "@/stores/projects";

export default function DashboardIndex() {
  const project = useProjectsStore(selectedProjectFromState);
  const selectSession = useProjectsStore((s) => s.selectSession);
  const router = useRouter();

  return (
    <View className="flex-1 bg-background">
      {Platform.OS !== "web" ? <ProjectSidebar /> : null}
      <ScrollView className="flex-1 p-6">
        <Text className="text-2xl font-bold text-foreground mb-1">{project?.name ?? "Aimux"}</Text>
        <Text className="text-sm text-muted-foreground mb-4">
          {project?.path ?? "Select a project to begin"}
        </Text>

        {project ? (
          <>
            <Text className="text-xs uppercase tracking-wider text-muted-foreground mt-4 mb-2">
              Sessions ({project.sessions.length})
            </Text>
            {project.sessions.length === 0 ? (
              <Text className="text-sm text-muted-foreground">
                No active sessions. Run `aimux spawn` to create one.
              </Text>
            ) : (
              project.sessions.map((session) => (
                <Pressable
                  key={session.id}
                  onPress={() => {
                    selectSession(session.id);
                    router.push({
                      pathname: "/(main)/agent/[sessionId]/chat",
                      params: { sessionId: session.id },
                    });
                  }}
                  className="rounded-lg border border-border bg-card p-3 mb-2 active:bg-accent"
                >
                  <Text className="text-base font-medium text-foreground">
                    {session.label || session.id}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {session.tool} · {session.status}
                    {session.worktreePath ? ` · ${session.worktreePath}` : ""}
                  </Text>
                  {session.headline ? (
                    <Text className="text-sm text-foreground mt-1" numberOfLines={2}>
                      {session.headline}
                    </Text>
                  ) : null}
                </Pressable>
              ))
            )}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
