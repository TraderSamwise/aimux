import React, { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Text } from "@/components/ui/text";
import { useAuth } from "@/lib/auth";
import { listGraveyard } from "@/lib/api";
import { selectedProjectFromState, useProjectsStore } from "@/stores/projects";

interface GraveyardEntry {
  id: string;
  tool?: string;
  label?: string;
  diedAt?: string;
}

export default function GraveyardScreen() {
  const project = useProjectsStore(selectedProjectFromState);
  const { getToken } = useAuth();
  const [entries, setEntries] = useState<GraveyardEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const endpoint = project?.serviceEndpoint ?? null;

  useEffect(() => {
    if (!endpoint) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        const data = (await listGraveyard(endpoint, { token })) as
          | GraveyardEntry[]
          | { entries?: GraveyardEntry[] };
        if (cancelled) return;
        if (Array.isArray(data)) {
          setEntries(data);
        } else if (Array.isArray(data?.entries)) {
          setEntries(data.entries);
        } else {
          setEntries([]);
        }
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
        <Text className="text-base font-semibold text-foreground">Graveyard</Text>
      </View>
      <ScrollView className="flex-1 p-4">
        {error ? <Text className="text-xs text-destructive mb-2">{error}</Text> : null}
        {entries.length === 0 ? (
          <Text className="text-sm text-muted-foreground">No dead agents</Text>
        ) : (
          entries.map((entry) => (
            <View key={entry.id} className="rounded-lg border border-border bg-card p-3 mb-2">
              <Text className="text-base font-medium text-foreground">
                {entry.label || entry.id}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {entry.tool ?? "?"}
                {entry.diedAt ? ` · died ${entry.diedAt}` : ""}
              </Text>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
