import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { ApiError, getPlan, putPlan } from "@/lib/api";
import { createProjectResourceRequestTracker } from "@/lib/project-resource-request-tracker";
import { singleRouteParam } from "@/lib/route-params";
import { useRouteProject } from "@/lib/use-route-project";
import {
  applyProjectPlanActionFailureAtom,
  applyProjectPlanFailureAtom,
  applyProjectPlanSaveSuccessAtom,
  applyProjectPlanSuccessAtom,
  beginProjectPlanRefreshAtom,
  clearProjectPlanResourceAtom,
  editProjectPlanDraftAtom,
  projectPlanResourceFamily,
  projectPlanResourceKey,
  settleProjectPlanRefreshAtom,
} from "@/stores/project";

const NO_PROJECT_PLAN_KEY = "__aimux_no_project__";

export default function PlanEditorScreen() {
  const params = useLocalSearchParams<{ sessionId?: string | string[] }>();
  const sessionId = singleRouteParam(params.sessionId);
  const { endpoint: serviceEndpoint, projectPath } = useRouteProject();
  const { getToken } = useAuth();
  const router = useRouter();

  const serviceEndpointHost = serviceEndpoint?.host ?? null;
  const serviceEndpointPort = serviceEndpoint?.port ?? null;
  const endpointKey =
    serviceEndpointHost && serviceEndpointPort
      ? `${serviceEndpointHost}:${serviceEndpointPort}`
      : null;
  const planKey = useMemo(
    () =>
      projectPath && sessionId
        ? projectPlanResourceKey(projectPath, sessionId)
        : NO_PROJECT_PLAN_KEY,
    [projectPath, sessionId],
  );
  const planResource = useAtomValue(projectPlanResourceFamily(planKey));
  const beginPlanRefresh = useSetAtom(beginProjectPlanRefreshAtom);
  const applyPlanSuccess = useSetAtom(applyProjectPlanSuccessAtom);
  const applyPlanFailure = useSetAtom(applyProjectPlanFailureAtom);
  const applyPlanActionFailure = useSetAtom(applyProjectPlanActionFailureAtom);
  const applyPlanSaveSuccess = useSetAtom(applyProjectPlanSaveSuccessAtom);
  const settlePlanRefresh = useSetAtom(settleProjectPlanRefreshAtom);
  const clearPlanResource = useSetAtom(clearProjectPlanResourceAtom);
  const editPlanDraft = useSetAtom(editProjectPlanDraftAtom);
  const trackerRef = useRef(
    createProjectResourceRequestTracker({
      projectPath: planKey,
      endpointKey,
    }),
  );
  const [savingPlanKey, setSavingPlanKey] = useState<string | null>(null);

  useEffect(() => {
    const tracker = trackerRef.current;
    tracker.update({ projectPath: planKey, endpointKey });
    return () => {
      tracker.invalidateGeneration();
    };
  }, [endpointKey, planKey]);

  const refreshPlan = useCallback(async () => {
    if (!serviceEndpoint || !sessionId || planKey === NO_PROJECT_PLAN_KEY) {
      clearPlanResource(planKey);
      return;
    }

    const marker = trackerRef.current.begin();
    beginPlanRefresh({ planKey, requestKey: marker.requestKey });
    try {
      const token = await getToken();
      const res = await getPlan(serviceEndpoint, sessionId, { token });
      if (!trackerRef.current.isCurrent(marker)) {
        settlePlanRefresh({ planKey, requestKey: marker.requestKey });
        return;
      }
      applyPlanSuccess({
        planKey,
        requestKey: marker.requestKey,
        plan: {
          sessionId,
          content: res.content,
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      if (!trackerRef.current.isCurrent(marker)) {
        settlePlanRefresh({ planKey, requestKey: marker.requestKey });
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        applyPlanSuccess({
          planKey,
          requestKey: marker.requestKey,
          plan: {
            sessionId,
            content: "",
            fetchedAt: new Date().toISOString(),
          },
        });
      } else {
        applyPlanFailure({
          planKey,
          requestKey: marker.requestKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }, [
    applyPlanFailure,
    applyPlanSuccess,
    beginPlanRefresh,
    clearPlanResource,
    getToken,
    planKey,
    serviceEndpoint,
    sessionId,
    settlePlanRefresh,
  ]);

  useEffect(() => {
    const tracker = trackerRef.current;
    void refreshPlan();
    return () => {
      tracker.invalidate();
    };
  }, [endpointKey, planKey, refreshPlan]);

  const handleSave = useCallback(async () => {
    const currentPlan = planResource.value;
    if (!serviceEndpoint || !sessionId || !currentPlan || planKey === NO_PROJECT_PLAN_KEY) {
      return;
    }

    trackerRef.current.invalidate();
    setSavingPlanKey(planKey);
    try {
      const token = await getToken();
      await putPlan(serviceEndpoint, sessionId, currentPlan.content, { token });
      applyPlanSaveSuccess({
        planKey,
        sessionId,
        content: currentPlan.content,
      });
      void refreshPlan();
    } catch (err) {
      applyPlanActionFailure({
        planKey,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingPlanKey((current) => (current === planKey ? null : current));
    }
  }, [
    applyPlanActionFailure,
    applyPlanSaveSuccess,
    getToken,
    planKey,
    planResource.value,
    refreshPlan,
    serviceEndpoint,
    sessionId,
  ]);

  const handleEdit = useCallback(
    (nextContent: string) => {
      if (!sessionId || planKey === NO_PROJECT_PLAN_KEY) return;
      editPlanDraft({ planKey, sessionId, content: nextContent });
    },
    [editPlanDraft, planKey, sessionId],
  );

  const plan = planResource.value;
  const saving = savingPlanKey === planKey;
  const dirty = plan ? plan.content !== plan.savedContent : false;
  const loading = planResource.pending && !plan;
  const error = planResource.error;

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
            disabled={saving || !dirty || !serviceEndpoint || !plan}
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
            value={plan?.content ?? ""}
            onChangeText={handleEdit}
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
