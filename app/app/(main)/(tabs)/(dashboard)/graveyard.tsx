import React, { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useAtomValue, useSetAtom } from "jotai";
import { RotateCcw } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { listGraveyard, resurrectGraveyardAgent, type GraveyardEntryResponse } from "@/lib/api";
import { kickDesktopStateRefreshAtom } from "@/stores/desktopState";
import { selectedProjectAtom } from "@/stores/projects";

type GraveyardState = {
  endpointKey: string | null;
  entries: GraveyardEntryResponse[];
  error: string | null;
};

export default function GraveyardScreen() {
  const project = useAtomValue(selectedProjectAtom);
  const { getToken } = useAuth();
  const [graveyardState, setGraveyardState] = useState<GraveyardState>({
    endpointKey: null,
    entries: [],
    error: null,
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const kickRefresh = useSetAtom(kickDesktopStateRefreshAtom);

  const endpoint = project?.serviceEndpoint ?? null;
  const endpointHost = endpoint?.host;
  const endpointPort = endpoint?.port;
  const endpointKey = endpointHost && endpointPort ? `${endpointHost}:${endpointPort}` : null;
  const entries = graveyardState.endpointKey === endpointKey ? graveyardState.entries : [];
  const error = graveyardState.endpointKey === endpointKey ? graveyardState.error : null;

  useEffect(() => {
    if (!endpointHost || !endpointPort || !endpointKey) return;
    const currentEndpoint = { host: endpointHost, port: endpointPort };
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        const data = await listGraveyard(currentEndpoint, { token });
        if (cancelled) return;
        setGraveyardState({
          endpointKey,
          entries: Array.isArray(data.entries) ? data.entries : [],
          error: null,
        });
      } catch (err) {
        if (!cancelled) {
          setGraveyardState({
            endpointKey,
            entries: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpointHost, endpointKey, endpointPort, getToken]);

  async function resurrect(entry: GraveyardEntryResponse) {
    if (!endpoint || !endpointKey || busyId) return;
    setBusyId(entry.id);
    setGraveyardState((current) =>
      current.endpointKey === endpointKey ? { ...current, error: null } : current,
    );
    try {
      const token = await getToken();
      await resurrectGraveyardAgent(endpoint, entry.id, { token });
      setGraveyardState((current) =>
        current.endpointKey === endpointKey
          ? { ...current, entries: current.entries.filter((item) => item.id !== entry.id) }
          : current,
      );
      kickRefresh();
    } catch (err) {
      setGraveyardState((current) =>
        current.endpointKey === endpointKey
          ? { ...current, error: err instanceof Error ? err.message : String(err) }
          : current,
      );
    } finally {
      setBusyId(null);
    }
  }

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
              <View className="flex-row items-center justify-between gap-3">
                <View className="min-w-0 flex-1">
                  <Text className="text-base font-medium text-foreground">
                    {entry.label || entry.id}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {entry.tool ?? "?"}
                    {entry.diedAt ? ` · died ${entry.diedAt}` : ""}
                  </Text>
                </View>
                <Button
                  accessibilityLabel={`Resurrect ${entry.label || entry.id}`}
                  size="icon"
                  variant="outline"
                  disabled={!endpoint || busyId !== null}
                  onPress={() => resurrect(entry)}
                >
                  <RotateCcw size={16} color="#a1a1aa" />
                </Button>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
