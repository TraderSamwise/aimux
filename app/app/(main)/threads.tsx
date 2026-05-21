import React, { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useAtomValue } from "jotai";
import { Text } from "@/components/ui/text";
import { useAuth } from "@/lib/auth";
import { listThreads } from "@/lib/api";
import { selectedProjectAtom } from "@/stores/projects";

interface ThreadSummary {
  thread: { id: string; title?: string; status?: string; kind?: string };
  lastMessage?: { body?: string; createdAt?: string };
}

export default function ThreadsScreen() {
  const project = useAtomValue(selectedProjectAtom);
  const { getToken } = useAuth();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
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
        const data = (await listThreads(endpoint, undefined, { token })) as ThreadSummary[];
        if (cancelled) return;
        setThreads(Array.isArray(data) ? data : []);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint?.host, endpoint?.port, getToken]);

  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-border px-4 py-3">
        <Text className="text-base font-semibold text-foreground">Threads</Text>
      </View>
      <ScrollView className="flex-1 p-4">
        {error ? <Text className="text-xs text-destructive mb-2">{error}</Text> : null}
        {threads.length === 0 ? (
          <Text className="text-sm text-muted-foreground">No threads</Text>
        ) : (
          threads.map((t) => (
            <View key={t.thread.id} className="rounded-lg border border-border bg-card p-3 mb-2">
              <Text className="text-base font-medium text-foreground">
                {t.thread.title || t.thread.id}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t.thread.kind ?? "thread"} · {t.thread.status ?? ""}
              </Text>
              {t.lastMessage?.body ? (
                <Text className="text-sm text-foreground mt-1" numberOfLines={2}>
                  {t.lastMessage.body}
                </Text>
              ) : null}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
