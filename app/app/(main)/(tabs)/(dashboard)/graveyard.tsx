import React, { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useAtomValue } from "jotai";
import { Text } from "@/components/ui/text";
import { useAuth } from "@/lib/auth";
import { listGraveyard, type GraveyardEntryResponse } from "@/lib/api";
import { selectedProjectAtom } from "@/stores/projects";

export default function GraveyardScreen() {
  const project = useAtomValue(selectedProjectAtom);
  const { getToken } = useAuth();
  const [entries, setEntries] = useState<GraveyardEntryResponse[]>([]);
  const [error, setError] = useState<string | null>(null);

  const endpoint = project?.serviceEndpoint ?? null;

  useEffect(() => {
    // Project switched away (or host went offline): drop stale data + error
    // so we don't render the previous project's graveyard.
    if (!endpoint) {
      setEntries([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const token = await getToken();
        const data = await listGraveyard(endpoint, { token });
        if (cancelled) return;
        if (Array.isArray(data.entries)) {
          setEntries(data.entries);
        } else {
          setEntries([]);
        }
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setEntries([]);
          setError(err instanceof Error ? err.message : String(err));
        }
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
