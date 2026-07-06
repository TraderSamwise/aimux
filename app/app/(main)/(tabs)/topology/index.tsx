import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Pressable, View } from "react-native";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Box, GitBranch, Network, Rows3, Table2 } from "lucide-react-native";
import { Card } from "@/components/ui/card";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Text } from "@/components/ui/text";
import { StatusDot, StatusPill } from "@/components/status-dot";
import { getProjectTopology, type ProjectTopologyResponse } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useSerializedProjectApiRefresh } from "@/lib/project-api-refresh";
import { useRouteProject } from "@/lib/use-route-project";
import { cn } from "@/lib/utils";
import { projectApiViewRefreshNonceFamily } from "@/stores/projectViews";
import { selectedSessionIdAtom } from "@/stores/projects";
import {
  applyTopologyFailureAtom,
  applyTopologySuccessAtom,
  beginTopologyRefreshAtom,
  clearTopologyResourceAtom,
  isCurrentTopologyRequest,
  topologyResourceFamily,
  type TopologyRequestScope,
} from "@/stores/topology";
import { buildViewHref, cleanSearchValue, detailHrefForPath } from "@/lib/view-location";

type TopologyViewMode = "map" | "tree" | "table";
type ProjectTopologyModel = ProjectTopologyResponse["topology"];
type TopologyRow = ProjectTopologyModel["rows"][number];
type TopologyHealth = ProjectTopologyModel["health"];

const VIEW_OPTIONS = [
  { value: "map", label: "Map" },
  { value: "tree", label: "Tree" },
  { value: "table", label: "Table" },
] satisfies { value: TopologyViewMode; label: string }[];

function resolveTopologyMode(value: string | null): TopologyViewMode {
  return value === "tree" || value === "table" ? value : "map";
}

function healthColor(health: TopologyHealth): string {
  switch (health) {
    case "active":
      return "#22c55e";
    case "attention":
      return "#f59e0b";
    case "offline":
      return "#71717a";
    case "idle":
      return "#38bdf8";
  }
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: TopologyHealth;
}) {
  return (
    <Card className="mr-2 mb-2 min-w-[112px] flex-1 rounded-lg p-3">
      <Text className="text-[22px] font-bold leading-tight text-foreground">{value}</Text>
      <View className="mt-1 flex-row items-center">
        {tone ? (
          <View
            className="mr-1.5 h-2 w-2 rounded-full"
            style={{ backgroundColor: healthColor(tone) }}
          />
        ) : null}
        <Text className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          {label}
        </Text>
      </View>
    </Card>
  );
}

function rowKey(row: TopologyRow, index: number): string {
  return row.sessionId ?? row.serviceId ?? row.worktreePath ?? `${row.kind}:${row.label}:${index}`;
}

function RowCard({
  row,
  index,
  onPickAgent,
  onPickService,
}: {
  row: TopologyRow;
  index: number;
  onPickAgent: (id: string) => void;
  onPickService: (id: string) => void;
}) {
  const canOpen = Boolean(row.sessionId || row.serviceId);
  return (
    <Pressable
      key={rowKey(row, index)}
      disabled={!canOpen}
      onPress={() => {
        if (row.sessionId) onPickAgent(row.sessionId);
        if (row.serviceId) onPickService(row.serviceId);
      }}
      className={cn(
        "flex-row items-center px-3 py-3 active:bg-accent",
        index > 0 && "border-t border-border",
        row.depth > 0 && "pl-8",
      )}
    >
      <View className="mr-3">
        <StatusDot status={row.status ?? row.health} size="sm" />
      </View>
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center">
          <Text className="flex-1 text-[13px] font-semibold text-foreground" numberOfLines={1}>
            {row.label}
          </Text>
          <Text className="ml-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            {row.kind}
          </Text>
        </View>
        {row.detail || row.status ? (
          <Text className="mt-1 text-[11px] text-muted-foreground" numberOfLines={1}>
            {[row.detail, row.status].filter(Boolean).join(" · ")}
          </Text>
        ) : null}
      </View>
      {row.status ? (
        <View className="ml-2">
          <StatusPill status={row.status} />
        </View>
      ) : null}
    </Pressable>
  );
}

function WorktreeCards({ topology }: { topology: ProjectTopologyModel }) {
  if (topology.worktrees.length === 0) {
    return (
      <Card className="items-center rounded-xl p-6">
        <Box size={22} color="#a1a1aa" />
        <Text className="mt-2 text-sm text-muted-foreground">No worktrees yet</Text>
      </Card>
    );
  }
  return (
    <View className="gap-3">
      {topology.worktrees.map((worktree) => (
        <Card key={worktree.path ?? worktree.name} className="rounded-lg p-4">
          <View className="flex-row items-center">
            <View
              className="mr-2 h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: healthColor(worktree.health) }}
            />
            <Text className="flex-1 text-[14px] font-semibold text-foreground" numberOfLines={1}>
              {worktree.name}
            </Text>
            <Text className="text-[11px] text-muted-foreground">
              {worktree.agents + worktree.services} nodes
            </Text>
          </View>
          {worktree.branch ? (
            <View className="mt-2 flex-row items-center self-start rounded border border-border bg-background px-2 py-1">
              <GitBranch size={11} color="#a1a1aa" />
              <Text className="ml-1.5 text-[11px] font-mono text-muted-foreground">
                {worktree.branch}
              </Text>
            </View>
          ) : null}
        </Card>
      ))}
    </View>
  );
}

function RowsList({
  rows,
  onPickAgent,
  onPickService,
}: {
  rows: TopologyRow[];
  onPickAgent: (id: string) => void;
  onPickService: (id: string) => void;
}) {
  if (rows.length === 0) {
    return <Text className="text-sm text-muted-foreground">No agents or services yet.</Text>;
  }
  return (
    <Card className="overflow-hidden rounded-xl p-0">
      {rows.map((row, index) => (
        <RowCard
          key={rowKey(row, index)}
          row={row}
          index={index}
          onPickAgent={onPickAgent}
          onPickService={onPickService}
        />
      ))}
    </Card>
  );
}

export default function TopologyScreen() {
  const { project, projectPath, endpoint, projectLoading } = useRouteProject();
  const projectPathKey = projectPath ?? "__aimux_no_selected_project__";
  const topologyRefreshNonce = useAtomValue(projectApiViewRefreshNonceFamily("topology"));
  const resource = useAtomValue(topologyResourceFamily(projectPathKey));
  const beginTopologyRefresh = useSetAtom(beginTopologyRefreshAtom);
  const applyTopologySuccess = useSetAtom(applyTopologySuccessAtom);
  const applyTopologyFailure = useSetAtom(applyTopologyFailureAtom);
  const clearTopologyResource = useSetAtom(clearTopologyResourceAtom);
  const searchParams = useGlobalSearchParams<{
    mode?: string | string[];
    project?: string | string[];
  }>();
  const endpointKey = endpoint ? `${endpoint.host}:${endpoint.port}` : null;
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const router = useRouter();
  const pathname = usePathname();
  const { getToken } = useAuth();
  const mode = resolveTopologyMode(cleanSearchValue(searchParams.mode));
  const getTokenRef = useRef(getToken);
  const endpointRef = useRef(endpoint);
  const endpointKeyRef = useRef(endpointKey);
  const projectPathRef = useRef(projectPathKey);
  const refreshSeqRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const requestScopeRef = useRef<TopologyRequestScope>({
    projectPath: projectPathKey,
    endpointKey,
    generation: 0,
  });

  useEffect(() => {
    getTokenRef.current = getToken;
    endpointRef.current = endpoint;
  }, [endpoint, getToken]);

  useEffect(() => {
    refreshGenerationRef.current += 1;
    endpointKeyRef.current = endpointKey;
    projectPathRef.current = projectPathKey;
    requestScopeRef.current = {
      projectPath: projectPathKey,
      endpointKey,
      generation: refreshGenerationRef.current,
    };
  }, [endpointKey, projectPathKey]);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const currentEndpoint = endpointRef.current;
    const currentProjectPath = projectPathRef.current;
    const requestScope = {
      projectPath: currentProjectPath,
      endpointKey: endpointKeyRef.current,
      generation: refreshGenerationRef.current,
    };
    if (!currentEndpoint) {
      clearTopologyResource(currentProjectPath);
      return;
    }
    beginTopologyRefresh(currentProjectPath);
    try {
      const token = await getTokenRef.current();
      const response = await getProjectTopology(currentEndpoint, { token });
      if (seq !== refreshSeqRef.current) return;
      if (!isCurrentTopologyRequest(requestScope, requestScopeRef.current)) return;
      applyTopologySuccess({
        projectPath: currentProjectPath,
        topology: {
          ...response.topology,
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      if (!isCurrentTopologyRequest(requestScope, requestScopeRef.current)) return;
      applyTopologyFailure({
        projectPath: currentProjectPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [applyTopologyFailure, applyTopologySuccess, beginTopologyRefresh, clearTopologyResource]);
  const serializedRefresh = useSerializedProjectApiRefresh(refresh);

  useEffect(() => {
    const timer = setTimeout(() => {
      void serializedRefresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [endpointKey, projectPathKey, serializedRefresh, topologyRefreshNonce]);

  const visibleTopology = resource.value;
  const visibleError = resource.error;
  const leafRows = useMemo(
    () => visibleTopology?.rows.filter((row) => row.kind !== "worktree") ?? [],
    [visibleTopology],
  );
  const activeCount = leafRows.filter((row) => row.health === "active").length;
  const attentionCount = leafRows.filter((row) => row.health === "attention").length;
  const offlineCount = leafRows.filter((row) => row.health === "offline").length;

  function handlePickAgent(sessionId: string) {
    selectSession(sessionId);
    router.push(detailHrefForPath(pathname, "agent", sessionId, projectPath));
  }

  function handlePickService(serviceId: string) {
    router.push(detailHrefForPath(pathname, "service", serviceId, projectPath));
  }

  return (
    <Page contentClassName="px-4 py-5 md:px-8 md:py-7">
      {projectLoading ? (
        <PageStateCard title="Loading project..." body="Fetching project state from the daemon." />
      ) : !project ? (
        <PageStateCard
          title="No project selected"
          body="Pick a project from the sidebar to view topology."
        />
      ) : !endpoint ? (
        <PageStateCard
          title="Project host not running"
          body="Start the host to see worktree and agent topology."
        />
      ) : visibleError && !resource.value && !resource.pending ? (
        <PageStateCard title="Unable to load topology" body={visibleError} tone="danger" />
      ) : !visibleTopology ? (
        <PageStateCard
          title={resource.pending ? "Loading topology..." : "No topology"}
          body="Fetching project runtime state."
        />
      ) : (
        <>
          <PageHeader eyebrow="Topology" title={project.name} subtitle={project.path} />

          <View className="mb-5 flex-row flex-wrap">
            <SummaryTile label="Worktrees" value={visibleTopology.counts.worktrees} />
            <SummaryTile label="Agents" value={visibleTopology.counts.agents} />
            <SummaryTile label="Services" value={visibleTopology.counts.services} />
            <SummaryTile label="Active" value={activeCount} tone="active" />
            <SummaryTile label="Attention" value={attentionCount} tone="attention" />
            <SummaryTile label="Offline" value={offlineCount} tone="offline" />
          </View>

          <View className="mb-4 flex-row items-center justify-between">
            <View className="flex-row items-center">
              {mode === "map" ? <Network size={16} color="#a1a1aa" /> : null}
              {mode === "tree" ? <Rows3 size={16} color="#a1a1aa" /> : null}
              {mode === "table" ? <Table2 size={16} color="#a1a1aa" /> : null}
              <Text className="ml-2 text-[13px] font-semibold text-foreground">
                {mode === "map"
                  ? "Relationship Map"
                  : mode === "tree"
                    ? "Worktree Tree"
                    : "Node Table"}
              </Text>
            </View>
            <SegmentedControl
              options={VIEW_OPTIONS}
              value={mode}
              onChange={(nextMode) =>
                router.replace(buildViewHref("/topology", { project: projectPath, mode: nextMode }))
              }
              className="ml-3"
            />
          </View>

          {mode === "map" ? (
            <View>
              <WorktreeCards topology={visibleTopology} />
              <View className="mt-4">
                <RowsList
                  rows={leafRows}
                  onPickAgent={handlePickAgent}
                  onPickService={handlePickService}
                />
              </View>
            </View>
          ) : null}
          {mode === "tree" ? (
            <RowsList
              rows={visibleTopology.rows}
              onPickAgent={handlePickAgent}
              onPickService={handlePickService}
            />
          ) : null}
          {mode === "table" ? (
            <RowsList
              rows={leafRows}
              onPickAgent={handlePickAgent}
              onPickService={handlePickService}
            />
          ) : null}
        </>
      )}
    </Page>
  );
}
