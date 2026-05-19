import React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { Text } from "@/components/ui/text";
import { useProjectsStore } from "@/stores/projects";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, string> = {
  running: "text-emerald-500",
  idle: "text-zinc-400",
  waiting: "text-amber-500",
  offline: "text-zinc-500",
};

export function ProjectSidebar() {
  const projects = useProjectsStore((s) => s.projects);
  const selectedProjectPath = useProjectsStore((s) => s.selectedProjectPath);
  const selectedSessionId = useProjectsStore((s) => s.selectedSessionId);
  const selectProject = useProjectsStore((s) => s.selectProject);
  const selectSession = useProjectsStore((s) => s.selectSession);
  const router = useRouter();

  const selectedProject = projects.find((p) => p.path === selectedProjectPath) ?? null;

  return (
    <View className="w-72 border-r border-border bg-background">
      <ScrollView className="flex-1">
        <View className="px-4 pt-6 pb-2">
          <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Projects
          </Text>
        </View>
        {projects.length === 0 ? (
          <View className="px-4 py-3">
            <Text className="text-sm text-muted-foreground">No projects detected</Text>
          </View>
        ) : (
          projects.map((project) => {
            const isSelected = project.path === selectedProjectPath;
            return (
              <Pressable
                key={project.path}
                onPress={() => selectProject(project.path)}
                className={cn("px-4 py-2", isSelected ? "bg-accent" : "active:bg-accent/50")}
              >
                <Text
                  className={cn(
                    "text-sm",
                    isSelected ? "text-accent-foreground font-medium" : "text-foreground",
                  )}
                >
                  {project.name}
                </Text>
                <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                  {project.path}
                </Text>
              </Pressable>
            );
          })
        )}

        {selectedProject ? (
          <>
            <View className="px-4 pt-6 pb-2">
              <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Sessions
              </Text>
            </View>
            {selectedProject.sessions.length === 0 ? (
              <View className="px-4 py-3">
                <Text className="text-sm text-muted-foreground">No active sessions</Text>
              </View>
            ) : (
              selectedProject.sessions.map((session) => {
                const isSelected = session.id === selectedSessionId;
                const tone = STATUS_TONE[session.status] ?? "text-zinc-400";
                return (
                  <Pressable
                    key={session.id}
                    onPress={() => {
                      selectSession(session.id);
                      router.push({
                        pathname: "/(main)/agent/[sessionId]/chat",
                        params: { sessionId: session.id },
                      });
                    }}
                    className={cn("px-4 py-2", isSelected ? "bg-accent" : "active:bg-accent/50")}
                  >
                    <View className="flex-row items-center gap-2">
                      <Text className={cn("text-xs", tone)}>●</Text>
                      <Text
                        className={cn(
                          "text-sm flex-1",
                          isSelected ? "text-accent-foreground font-medium" : "text-foreground",
                        )}
                        numberOfLines={1}
                      >
                        {session.label || session.id}
                      </Text>
                    </View>
                    <Text className="text-xs text-muted-foreground ml-4" numberOfLines={1}>
                      {session.tool} · {session.status}
                    </Text>
                  </Pressable>
                );
              })
            )}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
