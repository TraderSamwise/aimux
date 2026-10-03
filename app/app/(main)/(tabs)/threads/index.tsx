import React, { useCallback, useEffect, useRef } from "react";
import { projectStateKey } from "@/lib/project-key";
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
import { serviceEndpointKey } from "@/lib/daemon-url";

export default function ThreadsScreen() {
  const { project, projectPath, machineId, projectRef, endpoint, projectLoading } =
    useRouteProject();
  // Keyed by the pair: two machines' copies of one checkout are two
  // projects, and sharing an atom between them bleeds one host into the
  // other.
  const projectKeyForState = projectStateKey(projectRef);
  const refreshNonce = useAtomValue(projectApiViewRefreshNonceFamily("threads"));
  const threadsResource = useAtomValue(projectThreadsResourceFamily(projectKeyForState));
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
  const projectStateKeyRef = useRef(projectKeyForState);
  const endpointKeyRef = useRef<string | null>(null);
  const refreshSeqRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const endpointKey = serviceEndpointKey(endpoint);
  const requestScopeRef = useRef<ProjectResourceRequestScope>({
    projectStateKey: projectKeyForState,
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
    projectStateKeyRef.current = projectKeyForState;
    requestScopeRef.current = {
      projectStateKey: projectKeyForState,
      endpointKey,
      generation: refreshGenerationRef.current,
    };
  }, [endpointKey, projectKeyForState]);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const currentEndpoint = endpointRef.current;
    const currentProjectStateKey = projectStateKeyRef.current;
    const requestScope = {
      projectStateKey: currentProjectStateKey,
      endpointKey: endpointKeyRef.current,
      generation: refreshGenerationRef.current,
    };
    const requestKey = projectResourceRequestKey(requestScope);
    if (!currentEndpoint) {
      clearThreadsResource(currentProjectStateKey);
      return;
    }
    beginThreadsRefresh({ projectStateKey: currentProjectStateKey, requestKey });
    try {
      const token = await getTokenRef.current();
      const data = await listThreads(currentEndpoint, undefined, { token });
      if (
        seq !== refreshSeqRef.current ||
        !isCurrentProjectResourceRequest(requestScope, requestScopeRef.current)
      ) {
        settleThreadsRefresh({ projectStateKey: currentProjectStateKey, requestKey });
        return;
      }
      applyThreadsSuccess({
        projectStateKey: currentProjectStateKey,
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
        settleThreadsRefresh({ projectStateKey: currentProjectStateKey, requestKey });
        return;
      }
      applyThreadsFailure({
        projectStateKey: currentProjectStateKey,
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
  }, [endpointKey, projectKeyForState, refreshNonce, serializedRefresh]);

  useEffect(() => {
    return () => {
      refreshSeqRef.current += 1;
      refreshGenerationRef.current += 1;
      requestScopeRef.current = {
        projectStateKey: projectStateKeyRef.current,
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
                        machine: machineId,
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
