import React, { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { ApiError, getPlan, putPlan } from "@/lib/api";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import { singleRouteParam } from "@/lib/route-params";
import { selectedProjectAtom } from "@/stores/projects";

export default function PlanEditorScreen() {
  const params = useLocalSearchParams<{ sessionId?: string | string[] }>();
  const sessionId = singleRouteParam(params.sessionId);
  const project = useAtomValue(selectedProjectAtom);
  const { getToken } = useAuth();
  const router = useRouter();

  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const serviceEndpoint = getProjectServiceEndpoint(project);
  const serviceEndpointHost = serviceEndpoint?.host;
  const serviceEndpointPort = serviceEndpoint?.port;

  useEffect(() => {
    if (!serviceEndpointHost || !serviceEndpointPort || !sessionId) return;
    const currentEndpoint = { host: serviceEndpointHost, port: serviceEndpointPort };
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const token = await getToken();
        const res = await getPlan(currentEndpoint, sessionId, { token });
        if (cancelled) return;
        setContent(res.content);
        setOriginalContent(res.content);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setContent("");
          setOriginalContent("");
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serviceEndpointHost, serviceEndpointPort, sessionId, getToken]);

  async function handleSave() {
    if (!serviceEndpoint || !sessionId) return;
    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      await putPlan(serviceEndpoint, sessionId, content, { token });
      setOriginalContent(content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const dirty = content !== originalContent;

  return (
    <View className="flex-1 bg-background">
      <View className="border-b border-border px-4 py-3 flex-row items-center justify-between">
        <View className="flex-1">
          <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
            Plan: {sessionId ?? "Unknown session"}
          </Text>
          {dirty ? <Text className="text-xs text-amber-500">Unsaved changes</Text> : null}
        </View>
        <View className="flex-row gap-2">
          <Button variant="ghost" size="sm" label="Back" onPress={() => router.back()} />
          <Button
            size="sm"
            label={saving ? "Saving…" : "Save"}
            onPress={handleSave}
            disabled={saving || !dirty || !serviceEndpoint}
          />
        </View>
      </View>

      {!serviceEndpoint ? (
        <View className="p-4">
          <Text className="text-sm text-muted-foreground">
            Project service not running. Start the project host to edit plans.
          </Text>
        </View>
      ) : loading ? (
        <View className="p-4">
          <ActivityIndicator />
        </View>
      ) : (
        <ScrollView className="flex-1">
          {error ? (
            <View className="px-4 py-2">
              <Text className="text-xs text-destructive">{error}</Text>
            </View>
          ) : null}
          <TextInput
            className="m-4 min-h-[400px] rounded-lg border border-border bg-background px-3 py-2 text-foreground font-mono text-sm"
            value={content}
            onChangeText={setContent}
            multiline
            textAlignVertical="top"
            placeholder="# Plan\n\nWrite the plan here…"
            placeholderTextColor="#9ca3af"
          />
        </ScrollView>
      )}
    </View>
  );
}
