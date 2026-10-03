import React, { useCallback, useEffect, useRef, useState } from "react";
import { projectStateKey } from "@/lib/project-key";
import { View } from "react-native";
import { useAtomValue, useSetAtom } from "jotai";
import { GitBranch, RotateCcw, Trash2 } from "lucide-react-native";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { useSerializedProjectApiRefresh } from "@/lib/project-api-refresh";
import { createProjectResourceRequestTracker } from "@/lib/project-resource-request-tracker";
import { useRouteProject } from "@/lib/use-route-project";
import {
  deleteGraveyardWorktree,
  listGraveyard,
  resurrectGraveyardAgent,
  resurrectGraveyardWorktree,
  type GraveyardEntryResponse,
  type WorktreeGraveyardEntryResponse,
} from "@/lib/api";
import { kickDesktopStateRefreshAtom } from "@/stores/desktopState";
import { recordProjectLifecycleTransitionAtom } from "@/stores/lifecycleTransitions";
import {
  applyProjectGraveyardActionFailureAtom,
  applyProjectGraveyardFailureAtom,
  applyProjectGraveyardSuccessAtom,
  beginProjectGraveyardRefreshAtom,
  clearProjectGraveyardResourceAtom,
  projectGraveyardResourceFamily,
  removeProjectGraveyardAgentAtom,
  removeProjectGraveyardWorktreeAtom,
  settleProjectGraveyardRefreshAtom,
} from "@/stores/project";
import { projectApiViewRefreshNonceFamily } from "@/stores/projectViews";
import { serviceEndpointKey } from "@/lib/daemon-url";

export default function GraveyardScreen() {
  const { project, projectPath, projectRef, endpoint, projectLoading } = useRouteProject();
  // Keyed by the pair: two machines' copies of one checkout are two
  // projects, and sharing an atom between them bleeds one host into the
  // other.
  const projectKeyForState = projectStateKey(projectRef);
  const { getToken } = useAuth();
  const resource = useAtomValue(projectGraveyardResourceFamily(projectKeyForState));
  const [busyMarker, setBusyMarker] = useState<string | null>(null);
  const kickRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const beginGraveyardRefresh = useSetAtom(beginProjectGraveyardRefreshAtom);
  const applyGraveyardSuccess = useSetAtom(applyProjectGraveyardSuccessAtom);
  const applyGraveyardFailure = useSetAtom(applyProjectGraveyardFailureAtom);
  const applyGraveyardActionFailure = useSetAtom(applyProjectGraveyardActionFailureAtom);
  const clearGraveyardResource = useSetAtom(clearProjectGraveyardResourceAtom);
  const settleGraveyardRefresh = useSetAtom(settleProjectGraveyardRefreshAtom);
  const removeGraveyardAgent = useSetAtom(removeProjectGraveyardAgentAtom);
  const removeGraveyardWorktree = useSetAtom(removeProjectGraveyardWorktreeAtom);
  const recordTransition = useSetAtom(recordProjectLifecycleTransitionAtom);
  const graveyardRefreshNonce = useAtomValue(projectApiViewRefreshNonceFamily("graveyard"));

  const endpointKey = serviceEndpointKey(endpoint);
  const busyScope = `${projectKeyForState}:${endpointKey ?? "no-endpoint"}`;
  const busyId = busyMarker?.startsWith(`${busyScope}:`)
    ? busyMarker.slice(busyScope.length + 1)
    : null;
  const endpointRef = useRef(endpoint);
  const getTokenRef = useRef(getToken);
  const requestTrackerRef = useRef(
    createProjectResourceRequestTracker({
      projectStateKey: projectKeyForState,
      endpointKey,
    }),
  );
  const entries = resource.value?.entries ?? [];
  const worktrees = resource.value?.worktrees ?? [];
  const error = resource.error;

  useEffect(() => {
    endpointRef.current = endpoint;
    getTokenRef.current = getToken;
  }, [endpoint, getToken]);

  useEffect(() => {
    requestTrackerRef.current.update({
      projectStateKey: projectKeyForState,
      endpointKey,
    });
  }, [endpointKey, projectKeyForState]);

  const refresh = useCallback(async () => {
    const currentEndpoint = endpointRef.current;
    const request = requestTrackerRef.current.begin();
    const currentProjectStateKey = request.scope.projectStateKey;
    const requestKey = request.requestKey;
    if (!currentEndpoint) {
      clearGraveyardResource(currentProjectStateKey);
      return;
    }
    beginGraveyardRefresh({ projectStateKey: currentProjectStateKey, requestKey });
    try {
      const token = await getTokenRef.current();
      const data = await listGraveyard(currentEndpoint, { token });
      if (!requestTrackerRef.current.isCurrent(request)) {
        settleGraveyardRefresh({ projectStateKey: currentProjectStateKey, requestKey });
        return;
      }
      applyGraveyardSuccess({
        projectStateKey: currentProjectStateKey,
        requestKey,
        graveyard: {
          entries: Array.isArray(data.entries) ? data.entries : [],
          worktrees: Array.isArray(data.worktrees) ? data.worktrees : [],
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      if (!requestTrackerRef.current.isCurrent(request)) {
        settleGraveyardRefresh({ projectStateKey: currentProjectStateKey, requestKey });
        return;
      }
      applyGraveyardFailure({
        projectStateKey: currentProjectStateKey,
        requestKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [
    applyGraveyardFailure,
    applyGraveyardSuccess,
    beginGraveyardRefresh,
    clearGraveyardResource,
    settleGraveyardRefresh,
  ]);
  const serializedRefresh = useSerializedProjectApiRefresh(refresh);

  useEffect(() => {
    void serializedRefresh();
  }, [endpointKey, graveyardRefreshNonce, projectKeyForState, serializedRefresh]);

  useEffect(() => {
    const requestTracker = requestTrackerRef.current;
    return () => {
      requestTracker.invalidateGeneration();
    };
  }, []);

  async function resurrect(entry: GraveyardEntryResponse) {
    if (!endpoint || !endpointKey || busyId) return;
    const marker = `${busyScope}:${entry.id}`;
    setBusyMarker(marker);
    try {
      const token = await getToken();
      const response = await resurrectGraveyardAgent(endpoint, entry.id, { token });
      recordTransition({
        projectStateKey: projectKeyForState,
        transition: response.transition,
        label: entry.label ?? entry.id,
        tool: entry.tool,
      });
      requestTrackerRef.current.invalidate();
      removeGraveyardAgent({ projectStateKey: projectKeyForState, id: entry.id });
      kickRefresh();
      void serializedRefresh();
    } catch (err) {
      applyGraveyardActionFailure({
        projectStateKey: projectKeyForState,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyMarker((current) => (current === marker ? null : current));
    }
  }

  async function resurrectWorktree(entry: WorktreeGraveyardEntryResponse) {
    if (!endpoint || !endpointKey || busyId) return;
    const marker = `${busyScope}:worktree:${entry.path}`;
    setBusyMarker(marker);
    try {
      const token = await getToken();
      const response = await resurrectGraveyardWorktree(endpoint, entry.path, { token });
      recordTransition({
        projectStateKey: projectKeyForState,
        transition: response.transition,
        worktreeName: entry.name,
        worktreePath: entry.path,
      });
      requestTrackerRef.current.invalidate();
      removeGraveyardWorktree({ projectStateKey: projectKeyForState, path: entry.path });
      kickRefresh();
      void serializedRefresh();
    } catch (err) {
      applyGraveyardActionFailure({
        projectStateKey: projectKeyForState,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyMarker((current) => (current === marker ? null : current));
    }
  }

  async function deleteWorktree(entry: WorktreeGraveyardEntryResponse) {
    if (!endpoint || !endpointKey || busyId) return;
    const marker = `${busyScope}:delete-worktree:${entry.path}`;
    setBusyMarker(marker);
    try {
      const token = await getToken();
      const response = await deleteGraveyardWorktree(endpoint, entry.path, { token });
      recordTransition({
        projectStateKey: projectKeyForState,
        transition: response.transition,
        worktreeName: entry.name,
        worktreePath: entry.path,
      });
      requestTrackerRef.current.invalidate();
      removeGraveyardWorktree({ projectStateKey: projectKeyForState, path: entry.path });
      kickRefresh();
      void serializedRefresh();
    } catch (err) {
      applyGraveyardActionFailure({
        projectStateKey: projectKeyForState,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyMarker((current) => (current === marker ? null : current));
    }
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Project"
        title="Graveyard"
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
          body="Start the project host to load dead agents and worktrees."
        />
      ) : error && entries.length === 0 && worktrees.length === 0 && !resource.pending ? (
        <PageStateCard title="Unable to load graveyard" body={error} tone="danger" />
      ) : entries.length === 0 && worktrees.length === 0 ? (
        <PageStateCard
          title={resource.pending ? "Loading graveyard..." : "No dead agents or worktrees"}
          body="Stopped resources will appear here when available."
        />
      ) : (
        <>
          {resource.stale && error ? (
            <Card className="mb-4 rounded-lg border-amber-500/40 bg-amber-500/10 p-3">
              <Text className="text-[12px] font-semibold text-amber-700 dark:text-amber-300">
                Graveyard refresh failed
              </Text>
              <Text className="mt-1 text-[12px] text-muted-foreground">
                Showing the last successful graveyard snapshot. {error}
              </Text>
            </Card>
          ) : null}
          {worktrees.length > 0 ? (
            <View className="mb-3">
              <Text className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                Worktrees
              </Text>
              {worktrees.map((entry) => {
                const busy =
                  busyId === `worktree:${entry.path}` || busyId === `delete-worktree:${entry.path}`;
                return (
                  <View
                    key={entry.path}
                    className="mb-2 rounded-lg border border-border bg-card p-3"
                  >
                    <View className="flex-row items-center justify-between gap-3">
                      <View className="min-w-0 flex-1">
                        <View className="flex-row items-center gap-2">
                          <GitBranch size={14} color="#a1a1aa" />
                          <Text className="min-w-0 flex-1 text-base font-medium text-foreground">
                            {entry.name || entry.path}
                          </Text>
                        </View>
                        <Text className="text-xs text-muted-foreground" numberOfLines={2}>
                          {entry.branch ? `${entry.branch} · ` : ""}
                          {entry.graveyardedAt ? `graveyarded ${entry.graveyardedAt}` : entry.path}
                        </Text>
                      </View>
                      <View className="flex-row gap-2">
                        <Button
                          accessibilityLabel={`Resurrect ${entry.name || entry.path}`}
                          size="icon"
                          variant="outline"
                          disabled={!endpoint || busyId !== null}
                          onPress={() => resurrectWorktree(entry)}
                        >
                          <RotateCcw size={16} color="#a1a1aa" />
                        </Button>
                        <Button
                          accessibilityLabel={`Delete ${entry.name || entry.path}`}
                          size="icon"
                          variant="outline"
                          disabled={!endpoint || busyId !== null || busy}
                          onPress={() => deleteWorktree(entry)}
                        >
                          <Trash2 size={16} color="#a1a1aa" />
                        </Button>
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          ) : null}
          {entries.length > 0 ? (
            <View>
              <Text className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                Agents
              </Text>
              {entries.map((entry) => (
                <View key={entry.id} className="mb-2 rounded-lg border border-border bg-card p-3">
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
              ))}
            </View>
          ) : null}
        </>
      )}
    </Page>
  );
}
