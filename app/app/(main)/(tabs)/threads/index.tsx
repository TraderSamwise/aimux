import React, { useCallback, useEffect, useRef } from "react";
import { Pressable, View } from "react-native";
import { useGlobalSearchParams, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { ThreadWorkflowActions } from "@/components/workflow-actions";
import { useAuth } from "@/lib/auth";
import { listThreads } from "@/lib/api";
import { useSerializedProjectApiRefresh } from "@/lib/project-api-refresh";
import { useRouteProject } from "@/lib/use-route-project";
import { buildViewHref, cleanSearchValue } from "@/lib/view-location";
import {
  applyProjectThreadsFailureAtom,
  applyProjectThreadsSuccessAtom,
  beginProjectThreadsRefreshAtom,
  clearProjectThreadsResourceAtom,
  isCurrentProjectResourceRequest,
  projectResourceRequestKey,
  projectThreadsResourceFamily,
  settleProjectThreadsRefreshAtom,
  type ProjectResourceRequestScope,
} from "@/stores/project";
import { projectApiViewRefreshNonceFamily } from "@/stores/projectViews";
import { cn } from "@/lib/utils";

export default function ThreadsScreen() {
  const { project, projectPath, endpoint, projectLoading } = useRouteProject();
  const projectPathKey = projectPath ?? "__aimux_no_selected_project__";
  const refreshNonce = useAtomValue(projectApiViewRefreshNonceFamily("threads"));
  const threadsResource = useAtomValue(projectThreadsResourceFamily(projectPathKey));
  const beginThreadsRefresh = useSetAtom(beginProjectThreadsRefreshAtom);
  const applyThreadsSuccess = useSetAtom(applyProjectThreadsSuccessAtom);
  const applyThreadsFailure = useSetAtom(applyProjectThreadsFailureAtom);
  const clearThreadsResource = useSetAtom(clearProjectThreadsResourceAtom);
  const settleThreadsRefresh = useSetAtom(settleProjectThreadsRefreshAtom);
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  const router = useRouter();
  const searchParams = useGlobalSearchParams<{ threadId?: string | string[] }>();
  const selectedThreadId = cleanSearchValue(searchParams.threadId);

  const endpointRef = useRef(endpoint);
  const projectPathRef = useRef(projectPathKey);
  const endpointKeyRef = useRef<string | null>(null);
  const refreshSeqRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const endpointKey = endpoint ? `${endpoint.host}:${endpoint.port}` : null;
  const requestScopeRef = useRef<ProjectResourceRequestScope>({
    projectPath: projectPathKey,
    endpointKey,
    generation: 0,
  });
  const visibleThreads = threadsResource.value?.threads ?? [];
  const visibleError = threadsResource.error;

  useEffect(() => {
    getTokenRef.current = getToken;
    endpointRef.current = endpoint;
  }, [endpoint, getToken]);

  useEffect(() => {
    refreshGenerationRef.current += 1;
    endpointKeyRef.current = endpointKey;
    projectPathRef.current = projectPathKey;
    requestScopeRef.current = {
      projectPath: projectPathKey,
      endpointKey,
      generation: refreshGenerationRef.current,
    };
  }, [endpointKey, projectPathKey]);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const currentEndpoint = endpointRef.current;
    const currentProjectPath = projectPathRef.current;
    const requestScope = {
      projectPath: currentProjectPath,
      endpointKey: endpointKeyRef.current,
      generation: refreshGenerationRef.current,
    };
    const requestKey = projectResourceRequestKey(requestScope);
    if (!currentEndpoint) {
      clearThreadsResource(currentProjectPath);
      return;
    }
    beginThreadsRefresh({ projectPath: currentProjectPath, requestKey });
    try {
      const token = await getTokenRef.current();
      const data = await listThreads(currentEndpoint, undefined, { token });
      if (
        seq !== refreshSeqRef.current ||
        !isCurrentProjectResourceRequest(requestScope, requestScopeRef.current)
      ) {
        settleThreadsRefresh({ projectPath: currentProjectPath, requestKey });
        return;
      }
      applyThreadsSuccess({
        projectPath: currentProjectPath,
        requestKey,
        threads: {
          threads: Array.isArray(data) ? data : [],
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      if (
        seq !== refreshSeqRef.current ||
        !isCurrentProjectResourceRequest(requestScope, requestScopeRef.current)
      ) {
        settleThreadsRefresh({ projectPath: currentProjectPath, requestKey });
        return;
      }
      applyThreadsFailure({
        projectPath: currentProjectPath,
        requestKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [
    applyThreadsFailure,
    applyThreadsSuccess,
    beginThreadsRefresh,
    clearThreadsResource,
    settleThreadsRefresh,
  ]);

  const serializedRefresh = useSerializedProjectApiRefresh(refresh);

  useEffect(() => {
    void serializedRefresh();
  }, [endpointKey, projectPathKey, refreshNonce, serializedRefresh]);

  useEffect(() => {
    return () => {
      refreshSeqRef.current += 1;
      refreshGenerationRef.current += 1;
      requestScopeRef.current = {
        projectPath: projectPathRef.current,
        endpointKey: endpointKeyRef.current,
        generation: refreshGenerationRef.current,
      };
    };
  }, []);

  return (
    <Page>
      <PageHeader
        eyebrow="Project"
        title="Threads"
        subtitle={
          project
            ? `${project.name}${project.path ? ` · ${project.path}` : ""}`
            : projectLoading
              ? `Loading ${projectPath}`
              : "No project selected"
        }
      />
      {projectLoading ? (
        <PageStateCard title="Loading project..." body="Fetching project state from the daemon." />
      ) : !project ? (
        <PageStateCard title="No project selected" body="Pick a project from the sidebar." />
      ) : !endpoint ? (
        <PageStateCard
          title="Project host offline"
          body="Start the project host to load threads."
        />
      ) : visibleError && visibleThreads.length === 0 && !threadsResource.pending ? (
        <PageStateCard title="Unable to load threads" body={visibleError} tone="danger" />
      ) : visibleThreads.length === 0 ? (
        <PageStateCard
          title={threadsResource.pending ? "Loading threads..." : "No threads"}
          body="Thread conversations will appear here."
        />
      ) : (
        <>
          {threadsResource.stale && visibleError ? (
            <Card className="mb-4 rounded-lg border-amber-500/40 bg-amber-500/10 p-3">
              <Text className="text-[12px] font-semibold text-amber-700 dark:text-amber-300">
                Threads refresh failed
              </Text>
              <Text className="mt-1 text-[12px] text-muted-foreground">
                Showing the last successful thread snapshot. {visibleError}
              </Text>
            </Card>
          ) : null}
          {visibleThreads.map((t) => {
            const selected = t.thread.id === selectedThreadId;
            return (
              <View
                key={t.thread.id}
                className={cn(
                  "mb-2 rounded-lg border border-border bg-card p-3",
                  selected && "border-ring bg-secondary",
                )}
              >
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`Open thread ${t.thread.title || t.thread.id}`}
                  accessibilityState={{ selected }}
                  onPress={() =>
                    router.replace(
                      buildViewHref("/threads", {
                        project: projectPath,
                        threadId: t.thread.id,
                      }),
                    )
                  }
                >
                  <Text className="text-base font-medium text-foreground">
                    {t.thread.title || t.thread.id}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {t.thread.kind ?? "thread"} · {t.thread.status ?? ""}
                  </Text>
                  {t.latestMessage?.body ? (
                    <Text className="mt-1 text-sm text-foreground" numberOfLines={2}>
                      {t.latestMessage.body}
                    </Text>
                  ) : null}
                </Pressable>
                {selected ? <ThreadWorkflowActions endpoint={endpoint} thread={t} /> : null}
              </View>
            );
          })}
        </>
      )}
    </Page>
  );
}
