import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { MessageSquare, RotateCw } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { listThreads, type ThreadSummaryResponse } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { buildViewHref, buildViewPath } from "@/lib/view-location";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import { projectsAtom, selectProjectAtom } from "@/stores/projects";

interface GlobalThreadRow {
  projectName: string;
  projectPath: string;
  thread: ThreadSummaryResponse;
}

function sortThreadRows(a: GlobalThreadRow, b: GlobalThreadRow): number {
  const aTime = Date.parse(a.thread.latestMessage?.ts ?? "");
  const bTime = Date.parse(b.thread.latestMessage?.ts ?? "");
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return bTime - aTime;
  if (Number.isFinite(aTime)) return -1;
  if (Number.isFinite(bTime)) return 1;
  return a.projectName.localeCompare(b.projectName);
}

export default function GlobalThreadsScreen() {
  const router = useRouter();
  const selectProject = useSetAtom(selectProjectAtom);
  const projects = useAtomValue(projectsAtom);
  const { getToken } = useAuth();
  const [rows, setRows] = useState<GlobalThreadRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const getTokenRef = useRef(getToken);

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
  const refreshSeqRef = useRef(0);

  useEffect(() => {
    onlineProjectsRef.current = onlineProjects;
    getTokenRef.current = getToken;
  }, [getToken, onlineProjects]);

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const hasFetchError = errors.length > 0;

  const refresh = useCallback(async () => {
    const requestId = ++refreshSeqRef.current;
    const projectSnapshot = onlineProjectsRef.current;
    setLoading(true);
    setErrors([]);
    try {
      const token = await getTokenRef.current();
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
      if (refreshSeqRef.current !== requestId) return;
      nextRows.sort(sortThreadRows);
      setRows(nextRows);
      setErrors(nextErrors);
    } catch (error) {
      if (refreshSeqRef.current !== requestId) return;
      setErrors([
        `Unable to refresh threads: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    } finally {
      if (refreshSeqRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [onlineProjectKey, refresh]);

  return (
    <Page>
      <PageHeader
        eyebrow="All Projects"
        title="Threads"
        subtitle={`${rows.length} thread${rows.length === 1 ? "" : "s"} across ${
          onlineProjects.length
        } online project${onlineProjects.length === 1 ? "" : "s"}`}
        actions={
          <Button
            variant="outline"
            size="icon"
            disabled={loading}
            onPress={() => void refresh()}
            accessibilityLabel="Refresh global threads"
          >
            <RotateCw size={18} color="#fafafa" />
          </Button>
        }
      />

      {hasFetchError ? (
        <Card className="mb-4 rounded-lg border-amber-500/40 bg-amber-500/10">
          <Text className="text-sm font-semibold text-foreground">Some projects failed</Text>
          <Text className="mt-1 text-xs text-muted-foreground">{errors.join("\n")}</Text>
        </Card>
      ) : null}

      {rows.length === 0 && hasFetchError && !loading ? (
        <PageStateCard
          title="Unable to load threads"
          body="Fix the failed project connection or refresh to try again."
          tone="warning"
        />
      ) : rows.length === 0 ? (
        <PageStateCard
          title={loading ? "Loading threads..." : "No threads"}
          body="Project-scoped thread conversations will appear here once they exist."
        />
      ) : (
        rows.map((row) => (
          <Pressable
            key={`${row.projectPath}:${row.thread.thread.id}`}
            onPress={() => {
              selectProject(row.projectPath);
              const webHref = buildViewPath("/threads", {
                project: row.projectPath,
                threadId: row.thread.thread.id,
              });
              if (Platform.OS === "web" && typeof window !== "undefined") {
                window.location.assign(String(webHref));
                return;
              }
              router.navigate(
                buildViewHref("/threads", {
                  project: row.projectPath,
                  threadId: row.thread.thread.id,
                }),
              );
            }}
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
                  {row.thread.latestMessage?.body ? (
                    <Text className="mt-2 text-sm text-foreground/90" numberOfLines={2}>
                      {row.thread.latestMessage.body}
                    </Text>
                  ) : null}
                </View>
              </View>
            </Card>
          </Pressable>
        ))
      )}
    </Page>
  );
}
