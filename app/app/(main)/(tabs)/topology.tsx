import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import Svg, { Circle, Line, Rect, Text as SvgText } from "react-native-svg";
import { useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Box, GitBranch, Network, Rows3, Table2 } from "lucide-react-native";
import { Card, PressableCard } from "@/components/ui/card";
import { RuntimeBadge } from "@/components/RuntimeBadge";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Text } from "@/components/ui/text";
import { StatusDot, StatusPill } from "@/components/status-dot";
import { desktopStateFamily, worktreeGroupsFamily } from "@/stores/desktopState";
import {
  selectedProjectAtom,
  selectedProjectEndpointAtom,
  selectedSessionIdAtom,
} from "@/stores/projects";
import {
  buildProjectTopology,
  type ProjectTopology,
  type TopologyHealth,
  type TopologyNode,
  type TopologyWorktree,
} from "@/lib/openrig-topology";
import { runtimeBrandForKind } from "@/lib/runtime-brand";
import { cn } from "@/lib/utils";

type TopologyViewMode = "map" | "tree" | "table";

const VIEW_OPTIONS = [
  { value: "map", label: "Map" },
  { value: "tree", label: "Tree" },
  { value: "table", label: "Table" },
] satisfies { value: TopologyViewMode; label: string }[];

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

function healthLabel(health: TopologyHealth): string {
  switch (health) {
    case "active":
      return "active";
    case "attention":
      return "attention";
    case "offline":
      return "offline";
    case "idle":
      return "idle";
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
      <Text className="text-[22px] font-bold text-foreground leading-tight">{value}</Text>
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

function NodeCard({ node, onPress }: { node: TopologyNode; onPress?: () => void }) {
  const content = (
    <>
      <View className="flex-row items-center">
        <View
          className="mr-2.5 h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: healthColor(node.health) }}
        />
        <Text
          className="flex-1 text-[14px] font-semibold text-foreground"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {node.label}
        </Text>
        {node.status ? (
          <View className="ml-2 flex-row items-center gap-2">
            {node.kind === "agent" || node.kind === "service" ? (
              <RuntimeBadge brand={runtimeBrandForKind(node.kind, node.command)} compact />
            ) : null}
            <StatusPill status={node.status} />
          </View>
        ) : null}
      </View>
      {node.subtitle ? (
        <Text
          className="mt-1.5 text-[11px] text-muted-foreground"
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {node.subtitle}
        </Text>
      ) : null}
    </>
  );

  if (onPress) {
    return (
      <PressableCard onPress={onPress} className="mb-2 rounded-lg bg-secondary p-3">
        {content}
      </PressableCard>
    );
  }
  return <Card className="mb-2 rounded-lg bg-secondary p-3">{content}</Card>;
}

function TopologyMap({ topology, width }: { topology: ProjectTopology; width: number }) {
  const mapWidth = Math.max(680, width - 64);
  const rowHeight = 112;
  const height = Math.max(240, 92 + topology.worktrees.length * rowHeight);
  const projectX = 86;
  const worktreeX = 286;
  const leafX = 520;
  const centerY = height / 2;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View className="rounded-xl border border-border bg-card">
        <Svg width={mapWidth} height={height}>
          <Line
            x1={projectX + 44}
            y1={centerY}
            x2={worktreeX - 72}
            y2={centerY}
            stroke="#3f3f46"
            strokeWidth={2}
          />
          <Rect
            x={24}
            y={centerY - 36}
            width={124}
            height={72}
            rx={10}
            fill="#18181b"
            stroke={healthColor(topology.project.health)}
            strokeWidth={2}
          />
          <Circle cx={44} cy={centerY - 15} r={5} fill={healthColor(topology.project.health)} />
          <SvgText x={62} y={centerY - 9} fill="#fafafa" fontSize="13" fontWeight="700">
            {topology.project.label.slice(0, 16)}
          </SvgText>
          <SvgText x={44} y={centerY + 15} fill="#a1a1aa" fontSize="10">
            project
          </SvgText>

          {topology.worktrees.map((worktree, index) => {
            const y = 56 + index * rowHeight;
            const leaves = [...worktree.agents, ...worktree.services];
            const leafStep = leaves.length > 1 ? 48 : 0;
            const leafStart = y - ((leaves.length - 1) * leafStep) / 2;
            return (
              <React.Fragment key={worktree.id}>
                <Line
                  x1={worktreeX - 70}
                  y1={centerY}
                  x2={worktreeX - 70}
                  y2={y}
                  stroke="#3f3f46"
                  strokeWidth={1.5}
                />
                <Line
                  x1={worktreeX - 70}
                  y1={y}
                  x2={worktreeX - 12}
                  y2={y}
                  stroke="#3f3f46"
                  strokeWidth={1.5}
                />
                <Rect
                  x={worktreeX - 10}
                  y={y - 28}
                  width={156}
                  height={56}
                  rx={9}
                  fill="#27272a"
                  stroke={healthColor(worktree.health)}
                  strokeWidth={1.5}
                />
                <Circle cx={worktreeX + 10} cy={y - 10} r={4} fill={healthColor(worktree.health)} />
                <SvgText x={worktreeX + 24} y={y - 5} fill="#fafafa" fontSize="12" fontWeight="700">
                  {worktree.name.slice(0, 18)}
                </SvgText>
                <SvgText x={worktreeX + 10} y={y + 15} fill="#a1a1aa" fontSize="9">
                  {worktree.branch ? worktree.branch.slice(0, 22) : "worktree"}
                </SvgText>
                {leaves.map((node, leafIndex) => {
                  const leafY = leafStart + leafIndex * leafStep;
                  return (
                    <React.Fragment key={node.id}>
                      <Line
                        x1={worktreeX + 146}
                        y1={y}
                        x2={leafX - 14}
                        y2={leafY}
                        stroke="#3f3f46"
                        strokeWidth={1.5}
                      />
                      <Rect
                        x={leafX}
                        y={leafY - 20}
                        width={132}
                        height={40}
                        rx={8}
                        fill="#18181b"
                        stroke={healthColor(node.health)}
                        strokeWidth={1.25}
                      />
                      <Circle
                        cx={leafX + 15}
                        cy={leafY - 5}
                        r={3.5}
                        fill={healthColor(node.health)}
                      />
                      <SvgText
                        x={leafX + 26}
                        y={leafY}
                        fill="#fafafa"
                        fontSize="11"
                        fontWeight="700"
                      >
                        {node.label.slice(0, 15)}
                      </SvgText>
                      <SvgText x={leafX + 15} y={leafY + 13} fill="#a1a1aa" fontSize="8">
                        {node.kind}
                      </SvgText>
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            );
          })}
        </Svg>
      </View>
    </ScrollView>
  );
}

function WorktreeTreeSection({
  worktree,
  onPickAgent,
  onPickService,
}: {
  worktree: TopologyWorktree;
  onPickAgent: (id: string) => void;
  onPickService: (id: string) => void;
}) {
  return (
    <Card className="mb-4 overflow-hidden rounded-xl p-0">
      <View className="flex-row items-stretch border-b border-border bg-card">
        <View className="w-1.5" style={{ backgroundColor: healthColor(worktree.health) }} />
        <View className="flex-1 px-4 py-3.5">
          <View className="flex-row items-center">
            <Text
              className="flex-1 text-[17px] font-bold text-foreground"
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {worktree.name}
            </Text>
            <Text className="ml-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              {healthLabel(worktree.health)}
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
        </View>
      </View>
      <View className="p-3">
        {worktree.agents.length > 0 ? (
          <View className={cn(worktree.services.length > 0 && "mb-4")}>
            <Text className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Agents · {worktree.agents.length}
            </Text>
            {worktree.agents.map((agent) => (
              <NodeCard
                key={agent.id}
                node={agent}
                onPress={() => agent.sourceId && onPickAgent(agent.sourceId)}
              />
            ))}
          </View>
        ) : null}
        {worktree.services.length > 0 ? (
          <View>
            <Text className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Services · {worktree.services.length}
            </Text>
            {worktree.services.map((service) => (
              <NodeCard
                key={service.id}
                node={service}
                onPress={() => service.sourceId && onPickService(service.sourceId)}
              />
            ))}
          </View>
        ) : null}
        {worktree.agents.length === 0 && worktree.services.length === 0 ? (
          <Text className="py-2 text-[12px] italic text-muted-foreground">empty worktree</Text>
        ) : null}
      </View>
    </Card>
  );
}

function TopologyTable({
  topology,
  onPickAgent,
  onPickService,
}: {
  topology: ProjectTopology;
  onPickAgent: (id: string) => void;
  onPickService: (id: string) => void;
}) {
  const rows = topology.worktrees.flatMap((worktree) =>
    [...worktree.agents, ...worktree.services].map((node) => ({ worktree, node })),
  );

  if (rows.length === 0) {
    return <Text className="text-sm text-muted-foreground">No agents or services yet.</Text>;
  }

  return (
    <Card className="overflow-hidden rounded-xl p-0">
      {rows.map(({ worktree, node }, index) => (
        <Pressable
          key={node.id}
          onPress={() => {
            if (node.kind === "agent" && node.sourceId) onPickAgent(node.sourceId);
            if (node.kind === "service" && node.sourceId) onPickService(node.sourceId);
          }}
          className={cn(
            "flex-row items-center px-3 py-3 active:bg-accent",
            index > 0 && "border-t border-border",
          )}
        >
          <View className="mr-3">
            <StatusDot status={node.status ?? node.health} size="sm" />
          </View>
          <View className="min-w-0 flex-1">
            <View className="flex-row items-center">
              <Text className="flex-1 text-[13px] font-semibold text-foreground" numberOfLines={1}>
                {node.label}
              </Text>
              <Text className="ml-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {node.kind}
              </Text>
            </View>
            <Text className="mt-1 text-[11px] text-muted-foreground" numberOfLines={1}>
              {worktree.name}
              {node.subtitle ? ` · ${node.subtitle}` : ""}
            </Text>
          </View>
        </Pressable>
      ))}
    </Card>
  );
}

export default function TopologyScreen() {
  const [mode, setMode] = useState<TopologyViewMode>("map");
  const { width } = useWindowDimensions();
  const project = useAtomValue(selectedProjectAtom);
  const endpoint = useAtomValue(selectedProjectEndpointAtom);
  const desktopState = useAtomValue(desktopStateFamily(project?.path ?? ""));
  const groups = useAtomValue(worktreeGroupsFamily(project?.path ?? ""));
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const router = useRouter();

  const topology = useMemo(
    () => (project ? buildProjectTopology(project, groups, desktopState) : null),
    [desktopState, groups, project],
  );

  function handlePickAgent(sessionId: string) {
    selectSession(sessionId);
    router.push({ pathname: "/agent/[sessionId]/chat", params: { sessionId } });
  }

  function handlePickService(serviceId: string) {
    router.push({ pathname: "/service/[serviceId]", params: { serviceId } });
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerClassName="px-4 py-5 md:px-8 md:py-7">
        {!project || !topology ? (
          <Text className="text-sm text-muted-foreground">
            Select a project from the sidebar to view topology.
          </Text>
        ) : (
          <View className="w-full max-w-[1100px]">
            <View className="mb-5">
              <Text className="mb-1.5 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                Topology
              </Text>
              <Text
                className="text-[28px] font-bold leading-tight text-foreground"
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {project.name}
              </Text>
              <View className="mt-2 flex-row items-center">
                <Network size={14} color="#a1a1aa" />
                <Text
                  className="ml-2 min-w-0 flex-1 text-[12px] text-muted-foreground"
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {project.path}
                </Text>
              </View>
            </View>

            {!endpoint && desktopState === null ? (
              <Card className="mb-5 rounded-xl p-5">
                <Text className="text-[14px] font-medium text-foreground">
                  Project host not running.
                </Text>
                <Text className="mt-1.5 text-[12px] text-muted-foreground">
                  Start the host to see worktree and agent topology.
                </Text>
              </Card>
            ) : null}

            <View className="mb-5 flex-row flex-wrap">
              <SummaryTile label="Worktrees" value={topology.summary.worktrees} />
              <SummaryTile label="Agents" value={topology.summary.agents} />
              <SummaryTile label="Services" value={topology.summary.services} />
              <SummaryTile label="Active" value={topology.summary.active} tone="active" />
              <SummaryTile label="Attention" value={topology.summary.attention} tone="attention" />
              <SummaryTile label="Offline" value={topology.summary.offline} tone="offline" />
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
                onChange={setMode}
                className="ml-3"
              />
            </View>

            {mode === "map" ? (
              <View>
                <TopologyMap topology={topology} width={width} />
                <Text className="mt-3 text-[11px] text-muted-foreground">
                  The map mirrors OpenRig's topology concept with Aimux worktrees, agents, and
                  services.
                </Text>
              </View>
            ) : null}

            {mode === "tree" ? (
              <View>
                {topology.worktrees.map((worktree) => (
                  <WorktreeTreeSection
                    key={worktree.id}
                    worktree={worktree}
                    onPickAgent={handlePickAgent}
                    onPickService={handlePickService}
                  />
                ))}
              </View>
            ) : null}

            {mode === "table" ? (
              <TopologyTable
                topology={topology}
                onPickAgent={handlePickAgent}
                onPickService={handlePickService}
              />
            ) : null}

            {topology.worktrees.length === 0 ? (
              <Card className="mt-4 items-center rounded-xl p-6">
                <Box size={22} color="#a1a1aa" />
                <Text className="mt-2 text-sm text-muted-foreground">No worktrees yet</Text>
              </Card>
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
