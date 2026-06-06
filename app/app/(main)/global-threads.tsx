import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { MessageSquare, RotateCw } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { listThreads, type ThreadSummaryResponse } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { buildViewHref } from "@/lib/view-location";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import { projectsAtom } from "@/stores/projects";

interface GlobalThreadRow {
  projectName: string;
  projectPath: string;
  thread: ThreadSummaryResponse;
}

function sortThreadRows(a: GlobalThreadRow, b: GlobalThreadRow): number {
  const aTime = Date.parse(a.thread.lastMessage?.createdAt ?? "");
  const bTime = Date.parse(b.thread.lastMessage?.createdAt ?? "");
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return bTime - aTime;
  if (Number.isFinite(aTime)) return -1;
  if (Number.isFinite(bTime)) return 1;
  return a.projectName.localeCompare(b.projectName);
}

export default function GlobalThreadsScreen() {
  const router = useRouter();
  const projects = useAtomValue(projectsAtom);
  const { getToken } = useAuth();
  const [rows, setRows] = useState<GlobalThreadRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const onlineProjects = useMemo(
    () => projects.filter((project) => getProjectServiceEndpoint(project)),
    [projects],
  );
  const onlineProjectKey = useMemo(
    () =>
      onlineProjects
        .map((project) => {
          const endpoint = getProjectServiceEndpoint(project);
          return `${project.path}:${endpoint?.host ?? ""}:${endpoint?.port ?? ""}`;
        })
        .join("|"),
    [onlineProjects],
  );
  const onlineProjectsRef = useRef(onlineProjects);

  useEffect(() => {
    onlineProjectsRef.current = onlineProjects;
  }, [onlineProjects]);

  const refresh = useCallback(async () => {
    const projectSnapshot = onlineProjectsRef.current;
    setLoading(true);
    setErrors([]);
    try {
      const token = await getToken();
      const results = await Promise.allSettled(
        projectSnapshot.map(async (project) => {
          const endpoint = getProjectServiceEndpoint(project);
          if (!endpoint) return [];
          const threads = await listThreads(endpoint, undefined, { token });
          return threads.map((thread) => ({
            projectName: project.name,
            projectPath: project.path,
            thread,
          }));
        }),
      );
      const nextRows: GlobalThreadRow[] = [];
      const nextErrors: string[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          nextRows.push(...result.value);
        } else {
          nextErrors.push(`${projectSnapshot[index]?.name ?? "Project"}: ${String(result.reason)}`);
        }
      });
      setRows(nextRows.sort(sortThreadRows));
      setErrors(nextErrors);
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    void refresh();
  }, [onlineProjectKey, refresh]);

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="px-4 py-5 md:px-8">
      <View className="mx-auto w-full max-w-5xl">
        <View className="mb-5 flex-row items-start justify-between gap-3">
          <View className="min-w-0 flex-1">
            <Text className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              All Projects
            </Text>
            <Text className="mt-1 text-2xl font-bold text-foreground">Threads</Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              {rows.length} thread{rows.length === 1 ? "" : "s"} across {onlineProjects.length}{" "}
              online project{onlineProjects.length === 1 ? "" : "s"}
            </Text>
          </View>
          <Button
            variant="outline"
            size="icon"
            disabled={loading}
            onPress={() => void refresh()}
            accessibilityLabel="Refresh global threads"
          >
            <RotateCw size={18} color="#fafafa" />
          </Button>
        </View>

        {errors.length > 0 ? (
          <Card className="mb-4 rounded-lg border-amber-500/40 bg-amber-500/10">
            <Text className="text-sm font-semibold text-foreground">Some projects failed</Text>
            <Text className="mt-1 text-xs text-muted-foreground">{errors.join("\n")}</Text>
          </Card>
        ) : null}

        {rows.length === 0 ? (
          <Card className="rounded-lg p-5">
            <Text className="text-base font-semibold text-foreground">
              {loading ? "Loading threads..." : "No threads"}
            </Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              Project-scoped thread conversations will appear here once they exist.
            </Text>
          </Card>
        ) : (
          rows.map((row) => (
            <Pressable
              key={`${row.projectPath}:${row.thread.thread.id}`}
              onPress={() =>
                router.navigate(buildViewHref("/threads", { project: row.projectPath }))
              }
              className="mb-2"
            >
              <Card className="rounded-lg p-3 active:bg-accent/60">
                <View className="flex-row items-start gap-3">
                  <View className="mt-0.5 rounded-md border border-border bg-background p-2">
                    <MessageSquare size={16} color="#a1a1aa" />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text className="text-base font-medium text-foreground" numberOfLines={2}>
                      {row.thread.thread.title || row.thread.thread.id}
                    </Text>
                    <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>
                      {row.projectName} · {row.thread.thread.kind ?? "thread"} ·{" "}
                      {row.thread.thread.status ?? "open"}
                    </Text>
                    {row.thread.lastMessage?.body ? (
                      <Text className="mt-2 text-sm text-foreground/90" numberOfLines={2}>
                        {row.thread.lastMessage.body}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </Card>
            </Pressable>
          ))
        )}
      </View>
    </ScrollView>
  );
}
