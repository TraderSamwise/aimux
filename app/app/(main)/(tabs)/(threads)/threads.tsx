import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useGlobalSearchParams, useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { ThreadWorkflowActions } from "@/components/workflow-actions";
import { useAuth } from "@/lib/auth";
import { listThreads, type ThreadSummaryResponse } from "@/lib/api";
import { useSerializedProjectApiRefresh } from "@/lib/project-api-refresh";
import { useRouteProject } from "@/lib/use-route-project";
import { buildViewHref, cleanSearchValue } from "@/lib/view-location";
import { projectApiViewRefreshNonceAtom } from "@/stores/projectViews";
import { cn } from "@/lib/utils";

export default function ThreadsScreen() {
  const { project, projectPath, endpoint } = useRouteProject();
  const refreshNonce = useAtomValue(projectApiViewRefreshNonceAtom);
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  const router = useRouter();
  const searchParams = useGlobalSearchParams<{ threadId?: string | string[] }>();
  const selectedThreadId = cleanSearchValue(searchParams.threadId);
  const [threads, setThreads] = useState<ThreadSummaryResponse[]>([]);
  const [threadsKey, setThreadsKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const endpointRef = useRef(endpoint);
  const endpointKeyRef = useRef<string | null>(null);
  const refreshSeqRef = useRef(0);
  const endpointHost = endpoint?.host;
  const endpointPort = endpoint?.port;
  const endpointKey =
    endpointHost && endpointPort ? `${projectPath ?? ""}|${endpointHost}:${endpointPort}` : null;
  const visibleThreads = threadsKey === endpointKey ? threads : [];
  const visibleError = errorKey === endpointKey ? error : null;

  useEffect(() => {
    getTokenRef.current = getToken;
    endpointRef.current = endpoint;
    endpointKeyRef.current = endpointKey;
    refreshSeqRef.current += 1;
    return () => {
      refreshSeqRef.current += 1;
    };
  }, [endpoint, endpointKey, getToken]);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const currentEndpoint = endpointRef.current;
    const currentEndpointKey = endpointKeyRef.current;
    if (!currentEndpoint || !currentEndpointKey) {
      setThreads([]);
      setThreadsKey(null);
      setError(null);
      setErrorKey(null);
      return;
    }
    try {
      const token = await getTokenRef.current();
      const data = await listThreads(currentEndpoint, undefined, { token });
      if (seq !== refreshSeqRef.current) return;
      setThreads(Array.isArray(data) ? data : []);
      setThreadsKey(currentEndpointKey);
      setError(null);
      setErrorKey(null);
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setErrorKey(currentEndpointKey);
    }
  }, []);

  const serializedRefresh = useSerializedProjectApiRefresh(refresh);

  useEffect(() => {
    void serializedRefresh();
  }, [endpointKey, refreshNonce, serializedRefresh]);

  return (
    <Page>
      <PageHeader
        eyebrow="Project"
        title="Threads"
        subtitle={
          project
            ? `${project.name}${project.path ? ` · ${project.path}` : ""}`
            : "No project selected"
        }
      />
      {!project ? (
        <PageStateCard title="No project selected" body="Pick a project from the sidebar." />
      ) : !endpoint ? (
        <PageStateCard
          title="Project host offline"
          body="Start the project host to load threads."
        />
      ) : visibleError ? (
        <PageStateCard title="Unable to load threads" body={visibleError} tone="danger" />
      ) : visibleThreads.length === 0 ? (
        <PageStateCard title="No threads" body="Thread conversations will appear here." />
      ) : (
        visibleThreads.map((t) => {
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
        })
      )}
    </Page>
  );
}
