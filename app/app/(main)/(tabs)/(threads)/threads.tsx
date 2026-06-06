import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { useGlobalSearchParams } from "expo-router";
import { useAtomValue } from "jotai";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { useAuth } from "@/lib/auth";
import { listThreads, type ThreadSummaryResponse } from "@/lib/api";
import { cleanSearchValue } from "@/lib/view-location";
import { selectedProjectAtom } from "@/stores/projects";
import { cn } from "@/lib/utils";

export default function ThreadsScreen() {
  const project = useAtomValue(selectedProjectAtom);
  const { getToken } = useAuth();
  const searchParams = useGlobalSearchParams<{ threadId?: string | string[] }>();
  const selectedThreadId = cleanSearchValue(searchParams.threadId);
  const [threads, setThreads] = useState<ThreadSummaryResponse[]>([]);
  const [error, setError] = useState<string | null>(null);

  const endpoint = project?.serviceEndpoint ?? null;

  useEffect(() => {
    // Project switched away (or host went offline): drop stale data + error
    // so we don't render the previous project's threads.
    if (!endpoint) {
      setThreads([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const token = await getToken();
        const data = await listThreads(endpoint, undefined, { token });
        if (cancelled) return;
        setThreads(Array.isArray(data) ? data : []);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setThreads([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint?.host, endpoint?.port, getToken]);

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
      ) : error ? (
        <PageStateCard title="Unable to load threads" body={error} tone="danger" />
      ) : threads.length === 0 ? (
        <PageStateCard title="No threads" body="Thread conversations will appear here." />
      ) : (
        threads.map((t) => {
          const selected = t.thread.id === selectedThreadId;
          return (
            <View
              key={t.thread.id}
              className={cn(
                "mb-2 rounded-lg border border-border bg-card p-3",
                selected && "border-ring bg-secondary",
              )}
            >
              <Text className="text-base font-medium text-foreground">
                {t.thread.title || t.thread.id}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t.thread.kind ?? "thread"} · {t.thread.status ?? ""}
              </Text>
              {t.lastMessage?.body ? (
                <Text className="mt-1 text-sm text-foreground" numberOfLines={2}>
                  {t.lastMessage.body}
                </Text>
              ) : null}
            </View>
          );
        })
      )}
    </Page>
  );
}
