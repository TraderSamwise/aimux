import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  useProjectApiRelayPolling,
  useSerializedProjectApiRefresh,
} from "@/lib/project-api-relay-polling";
import { cn } from "@/lib/utils";
import { projectApiViewRefreshNonceAtom } from "@/stores/projectViews";
import {
  projectsAtom,
  selectedProjectAtom,
  selectedProjectEndpointAtom,
  selectedSessionIdAtom,
} from "@/stores/projects";
import {
  buildViewHref,
  cleanSearchValue,
  detailHrefForPath,
  projectPathFromSearchOrLocation,
} from "@/lib/view-location";

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
  const projects = useAtomValue(projectsAtom);
  const selectedProject = useAtomValue(selectedProjectAtom);
  const selectedProjectEndpoint = useAtomValue(selectedProjectEndpointAtom);
  const projectViewRefreshNonce = useAtomValue(projectApiViewRefreshNonceAtom);
  const searchParams = useGlobalSearchParams<{
    mode?: string | string[];
    project?: string | string[];
  }>();
  const urlProjectPath = projectPathFromSearchOrLocation(searchParams.project);
  const project = urlProjectPath
    ? projects.find((item) => item.path === urlProjectPath)
    : selectedProject;
  const endpoint =
    project?.serviceEndpoint ??
    (project?.path === selectedProject?.path ? selectedProjectEndpoint : undefined);
  const endpointKey = endpoint ? `${endpoint.host}:${endpoint.port}` : null;
  const viewKey = endpointKey ? `${project?.path ?? ""}|${endpointKey}` : null;
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const router = useRouter();
  const pathname = usePathname();
  const { getToken } = useAuth();
  const mode = resolveTopologyMode(cleanSearchValue(searchParams.mode));
  const [topology, setTopology] = useState<ProjectTopologyModel | null>(null);
  const [topologyKey, setTopologyKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const getTokenRef = useRef(getToken);
  const endpointRef = useRef(endpoint);
  const viewKeyRef = useRef(viewKey);
  const refreshSeqRef = useRef(0);

  useEffect(() => {
    getTokenRef.current = getToken;
    endpointRef.current = endpoint;
    viewKeyRef.current = viewKey;
  }, [endpoint, getToken, viewKey]);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const currentEndpoint = endpointRef.current;
    const currentViewKey = viewKeyRef.current;
    if (!currentEndpoint) {
      setTopology(null);
      setTopologyKey(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const token = await getTokenRef.current();
      const response = await getProjectTopology(currentEndpoint, { token });
      if (seq !== refreshSeqRef.current) return;
      setTopology(response.topology);
      setTopologyKey(currentViewKey);
      setError(null);
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === refreshSeqRef.current) setLoading(false);
    }
  }, []);
  const serializedRefresh = useSerializedProjectApiRefresh(refresh);

  useEffect(() => {
    const timer = setTimeout(() => {
      void serializedRefresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [endpointKey, projectViewRefreshNonce, serializedRefresh]);

  useProjectApiRelayPolling(endpointKey, serializedRefresh);

  const visibleTopology = topologyKey === viewKey ? topology : null;
  const leafRows = useMemo(
    () => visibleTopology?.rows.filter((row) => row.kind !== "worktree") ?? [],
    [visibleTopology],
  );
  const activeCount = leafRows.filter((row) => row.health === "active").length;
  const attentionCount = leafRows.filter((row) => row.health === "attention").length;
  const offlineCount = leafRows.filter((row) => row.health === "offline").length;

  function handlePickAgent(sessionId: string) {
    selectSession(sessionId);
    router.push(detailHrefForPath(pathname, "agent", sessionId, project?.path));
  }

  function handlePickService(serviceId: string) {
    router.push(detailHrefForPath(pathname, "service", serviceId, project?.path));
  }

  return (
    <Page contentClassName="px-4 py-5 md:px-8 md:py-7">
      {!project ? (
        <PageStateCard
          title="No project selected"
          body="Pick a project from the sidebar to view topology."
        />
      ) : !endpoint ? (
        <PageStateCard
          title="Project host not running"
          body="Start the host to see worktree and agent topology."
        />
      ) : error ? (
        <PageStateCard title="Unable to load topology" body={error} tone="danger" />
      ) : !visibleTopology ? (
        <PageStateCard
          title={loading ? "Loading topology..." : "No topology"}
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
                router.replace(
                  buildViewHref("/topology", { project: project.path, mode: nextMode }),
                )
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
