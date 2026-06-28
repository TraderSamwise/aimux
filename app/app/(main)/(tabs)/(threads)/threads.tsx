import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useGlobalSearchParams, useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { ThreadWorkflowActions } from "@/components/workflow-actions";
import { useAuth } from "@/lib/auth";
import { listThreads, type ThreadSummaryResponse } from "@/lib/api";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import { useSerializedProjectApiRefresh } from "@/lib/project-api-refresh";
import { buildViewHref, cleanSearchValue } from "@/lib/view-location";
import { projectApiViewRefreshNonceAtom } from "@/stores/projectViews";
import { selectedProjectAtom } from "@/stores/projects";
import { cn } from "@/lib/utils";

export default function ThreadsScreen() {
  const project = useAtomValue(selectedProjectAtom);
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

  const endpoint = getProjectServiceEndpoint(project);
  const endpointHost = endpoint?.host;
  const endpointPort = endpoint?.port;
  const endpointKey =
    endpointHost && endpointPort ? `${project?.path ?? ""}|${endpointHost}:${endpointPort}` : null;
  const visibleThreads = threadsKey === endpointKey ? threads : [];
  const visibleError = errorKey === endpointKey ? error : null;

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const refresh = useCallback(async () => {
    if (!endpointHost || !endpointPort || !endpointKey) {
      setThreads([]);
      setThreadsKey(null);
      setError(null);
      setErrorKey(null);
      return;
    }
    const currentEndpoint = { host: endpointHost, port: endpointPort };
    try {
      const token = await getTokenRef.current();
      const data = await listThreads(currentEndpoint, undefined, { token });
      setThreads(Array.isArray(data) ? data : []);
      setThreadsKey(endpointKey);
      setError(null);
      setErrorKey(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setErrorKey(endpointKey);
    }
  }, [endpointHost, endpointKey, endpointPort]);

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
                      project: project?.path,
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
