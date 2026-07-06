import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Platform, Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { MessageSquare, RotateCw } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { listThreads } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { buildViewHref, buildViewPath } from "@/lib/view-location";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import {
  applyGlobalThreadFailureAtom,
  applyGlobalThreadSuccessAtom,
  beginGlobalThreadRefreshAtom,
  globalInboxRequestKey,
  globalThreadResourceAtom,
  mergeGlobalRowsWithPrevious,
  settleGlobalThreadRefreshAtom,
  type GlobalThreadRow,
} from "@/stores/globalInbox";
import { projectsAtom, selectProjectAtom } from "@/stores/projects";

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
  const resource = useAtomValue(globalThreadResourceAtom);
  const beginRefresh = useSetAtom(beginGlobalThreadRefreshAtom);
  const applySuccess = useSetAtom(applyGlobalThreadSuccessAtom);
  const applyFailure = useSetAtom(applyGlobalThreadFailureAtom);
  const settleRefresh = useSetAtom(settleGlobalThreadRefreshAtom);
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
  const onlineProjectKeyRef = useRef(onlineProjectKey);
  const resourceRef = useRef(resource);
  const refreshSeqRef = useRef(0);
  const rows = resource.value?.rows ?? [];
  const errors = [...(resource.value?.errors ?? []), ...(resource.error ? [resource.error] : [])];
  const loading = resource.pending;

  useEffect(() => {
    onlineProjectsRef.current = onlineProjects;
    onlineProjectKeyRef.current = onlineProjectKey;
    getTokenRef.current = getToken;
    resourceRef.current = resource;
  }, [getToken, onlineProjectKey, onlineProjects, resource]);

  const hasFetchError = errors.length > 0;

  const refresh = useCallback(async () => {
    const requestId = ++refreshSeqRef.current;
    const projectSnapshot = onlineProjectsRef.current;
    const requestSourceKey = onlineProjectKeyRef.current;
    const requestKey = globalInboxRequestKey("threads", requestSourceKey, requestId);
    beginRefresh({ requestKey });
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
      const failedProjectPaths = new Set<string>();
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          nextRows.push(...result.value);
        } else {
          const project = projectSnapshot[index];
          if (project) failedProjectPaths.add(project.path);
          nextErrors.push(`${project?.name ?? "Project"}: ${String(result.reason)}`);
        }
      });
      if (refreshSeqRef.current !== requestId || onlineProjectKeyRef.current !== requestSourceKey) {
        settleRefresh({ requestKey });
        return;
      }
      const mergedRows = mergeGlobalRowsWithPrevious(
        resourceRef.current.value?.rows ?? [],
        nextRows,
        failedProjectPaths,
      ).sort(sortThreadRows);
      applySuccess({
        requestKey,
        value: {
          rows: mergedRows,
          errors: nextErrors,
          projectCount: projectSnapshot.length,
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      if (refreshSeqRef.current !== requestId || onlineProjectKeyRef.current !== requestSourceKey) {
        settleRefresh({ requestKey });
        return;
      }
      applyFailure({
        requestKey,
        error: `Unable to refresh threads: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [applyFailure, applySuccess, beginRefresh, settleRefresh]);

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
