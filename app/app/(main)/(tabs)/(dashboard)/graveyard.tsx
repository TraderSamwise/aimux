import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { useAtomValue, useSetAtom } from "jotai";
import { GitBranch, RotateCcw, Trash2 } from "lucide-react-native";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
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
import { projectApiViewRefreshNonceFamily } from "@/stores/projectViews";

type GraveyardState = {
  endpointKey: string | null;
  entries: GraveyardEntryResponse[];
  worktrees: WorktreeGraveyardEntryResponse[];
  error: string | null;
};

export default function GraveyardScreen() {
  const { project, projectPath, endpoint, projectLoading } = useRouteProject();
  const { getToken } = useAuth();
  const [graveyardState, setGraveyardState] = useState<GraveyardState>({
    endpointKey: null,
    entries: [],
    worktrees: [],
    error: null,
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const kickRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const graveyardRefreshNonce = useAtomValue(projectApiViewRefreshNonceFamily("graveyard"));

  const endpointHost = endpoint?.host;
  const endpointPort = endpoint?.port;
  const endpointKey = endpointHost && endpointPort ? `${endpointHost}:${endpointPort}` : null;
  const entries = graveyardState.endpointKey === endpointKey ? graveyardState.entries : [];
  const worktrees = graveyardState.endpointKey === endpointKey ? graveyardState.worktrees : [];
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
          worktrees: Array.isArray(data.worktrees) ? data.worktrees : [],
          error: null,
        });
      } catch (err) {
        if (!cancelled) {
          setGraveyardState({
            endpointKey,
            entries: [],
            worktrees: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpointHost, endpointKey, endpointPort, getToken, graveyardRefreshNonce]);

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

  async function resurrectWorktree(entry: WorktreeGraveyardEntryResponse) {
    if (!endpoint || !endpointKey || busyId) return;
    setBusyId(`worktree:${entry.path}`);
    setGraveyardState((current) =>
      current.endpointKey === endpointKey ? { ...current, error: null } : current,
    );
    try {
      const token = await getToken();
      await resurrectGraveyardWorktree(endpoint, entry.path, { token });
      setGraveyardState((current) =>
        current.endpointKey === endpointKey
          ? { ...current, worktrees: current.worktrees.filter((item) => item.path !== entry.path) }
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

  async function deleteWorktree(entry: WorktreeGraveyardEntryResponse) {
    if (!endpoint || !endpointKey || busyId) return;
    setBusyId(`delete-worktree:${entry.path}`);
    setGraveyardState((current) =>
      current.endpointKey === endpointKey ? { ...current, error: null } : current,
    );
    try {
      const token = await getToken();
      await deleteGraveyardWorktree(endpoint, entry.path, { token });
      setGraveyardState((current) =>
        current.endpointKey === endpointKey
          ? { ...current, worktrees: current.worktrees.filter((item) => item.path !== entry.path) }
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
      ) : error ? (
        <PageStateCard title="Unable to load graveyard" body={error} tone="danger" />
      ) : entries.length === 0 && worktrees.length === 0 ? (
        <PageStateCard
          title="No dead agents or worktrees"
          body="Stopped resources will appear here when available."
        />
      ) : (
        <>
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
