import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text as RNText, View, useWindowDimensions } from "react-native";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { CheckCircle2, RefreshCw } from "lucide-react-native";
import { useColorScheme } from "nativewind";
import { MessageBlock } from "@/components/MessageBlock";
import { PageHeader, PageStateCard } from "@/components/PageLayout";
import { Button } from "@/components/ui/button";
import { PressableCard } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Text } from "@/components/ui/text";
import { listGlobalExposeItems, listSwitchableAgents, type DaemonProject } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { blurWebActiveElement } from "@/lib/blur-web-active-element";
import {
  buildExposeTiles,
  filterExposeTiles,
  summarizeExposeTiles,
  type ExposeFilter,
  type ExposeSourceItem,
  type ExposeTile,
} from "@/lib/expose-model";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import { getErrorMessage, isTransientRequestError } from "@/lib/request-errors";
import { cn } from "@/lib/utils";
import { detailHrefForPath, projectPathFromSearchOrLocation } from "@/lib/view-location";
import { projectsAtom, selectedProjectPathAtom, selectedSessionIdAtom } from "@/stores/projects";
import { relayStatusAtom } from "@/stores/relay";
import { exposePreviewModeAtom, type ExposePreviewMode } from "@/stores/settings";

type ExposeScope = "project" | "global";

interface ExposeProjectResult {
  projectName: string;
  error: string | null;
}

const FILTER_OPTIONS: Array<{ value: ExposeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "working", label: "Working" },
  { value: "attention", label: "Needs" },
  { value: "ready", label: "Ready" },
];

const PREVIEW_MODE_OPTIONS: Array<{ value: ExposePreviewMode; label: string }> = [
  { value: "chat", label: "Chat" },
  { value: "terminal", label: "Terminal" },
];

function resolveScope(value: string | string[] | undefined): ExposeScope {
  const first = Array.isArray(value) ? value[0] : value;
  return first === "global" ? "global" : "project";
}

function resolveFilter(value: string | string[] | undefined): ExposeFilter {
  const first = Array.isArray(value) ? value[0] : value;
  return FILTER_OPTIONS.some((option) => option.value === first) ? (first as ExposeFilter) : "all";
}

function statusBoxClass(kind: ExposeTile["statusKind"]): string {
  switch (kind) {
    case "working":
      return "border-emerald-500/30 bg-emerald-500/10";
    case "needs":
    case "blocked":
    case "error":
      return "border-amber-500/30 bg-amber-500/10";
    case "ready":
    case "idle":
    case "done":
      return "border-sky-500/25 bg-sky-500/10";
    case "service":
      return "border-violet-500/25 bg-violet-500/10";
    case "serviceOff":
    case "offline":
      return "border-zinc-500/20 bg-zinc-500/10";
    default:
      return "border-zinc-500/20 bg-zinc-500/10";
  }
}

function statusTextClass(kind: ExposeTile["statusKind"]): string {
  switch (kind) {
    case "working":
      return "text-emerald-300";
    case "needs":
    case "blocked":
    case "error":
      return "text-amber-300";
    case "ready":
    case "idle":
    case "done":
      return "text-sky-300";
    case "service":
      return "text-violet-300";
    case "serviceOff":
    case "offline":
      return "text-zinc-400";
    default:
      return "text-zinc-400";
  }
}

function dotClass(kind: ExposeTile["statusKind"]): string {
  switch (kind) {
    case "working":
      return "bg-emerald-400";
    case "needs":
    case "blocked":
    case "error":
      return "bg-amber-400";
    case "ready":
    case "idle":
    case "done":
      return "bg-sky-400";
    case "service":
      return "bg-violet-400";
    case "serviceOff":
    case "offline":
      return "bg-zinc-600";
    default:
      return "bg-zinc-600";
  }
}

function sourcesForGlobalExposeItems(projects: DaemonProject[], items: ExposeSourceItem[]) {
  const byProjectId = new Map(projects.map((project) => [project.id, project]));
  const byProjectPath = new Map(projects.map((project) => [project.path, project]));
  const grouped = new Map<string, { project: DaemonProject; items: ExposeSourceItem[] }>();
  for (const item of items) {
    const project =
      (item.projectId ? byProjectId.get(item.projectId) : undefined) ??
      (item.projectRoot ? byProjectPath.get(item.projectRoot) : undefined);
    if (!project) continue;
    let source = grouped.get(project.id);
    if (!source) {
      source = { project, items: [] };
      grouped.set(project.id, source);
    }
    source.items.push(item);
  }
  return [...grouped.values()];
}

function ExposeTileCard({
  tile,
  tileWidth,
  tileHeight,
  previewMode,
  onPress,
}: {
  tile: ExposeTile;
  tileWidth: number;
  tileHeight: number;
  previewMode: ExposePreviewMode;
  onPress: () => void;
}) {
  const previewLineCount = Math.max(6, Math.floor((tileHeight - 112) / 20));
  const terminalPreview =
    tile.terminalPreviewLines.length > 0
      ? tile.terminalPreviewLines.slice(-previewLineCount)
      : [[{ text: "No recent pane output.", style: {} }]];
  const chatPreview = tile.chatPreviewMessages;
  const chatPreviewTail = chatPreview.slice(-4);
  const hasPreview =
    previewMode === "terminal"
      ? tile.terminalPreviewLines.length > 0
      : tile.chatPreviewMessages.length > 0;
  const chatDividerWidth = Math.max(24, Math.floor((tileWidth * 0.9 - 24) / 8.5) - 2);
  const chatEndpoint = tile.serviceEndpoint;
  return (
    <View className="p-2" style={{ width: tileWidth }}>
      <PressableCard
        onPress={onPress}
        style={{ height: tileHeight }}
        className={cn(
          "rounded-lg border bg-[#17181d] p-0 overflow-hidden hover:bg-[#1c1d23]",
          tile.statusKind === "offline" ? "border-[#2a2b31]" : "border-[#334155]",
        )}
      >
        <View className="flex-1 border-l-4 p-3.5" style={{ borderLeftColor: tile.tone }}>
          <View className="flex-row items-start gap-2">
            <View className={cn("mt-1 h-2 w-2 rounded-full", dotClass(tile.statusKind))} />
            <View className="min-w-0 flex-1">
              <View className="flex-row items-baseline gap-2">
                <Text
                  className="min-w-0 shrink text-[15px] font-bold"
                  style={{ color: tile.tone }}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {tile.semanticTitle || tile.label}
                </Text>
                <Text className="shrink-0 font-mono text-[11px] text-[#8b8d97]" numberOfLines={1}>
                  {tile.label}
                </Text>
              </View>
              <Text
                className="mt-1 font-mono text-[11px] text-[#7c7e88]"
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {tile.contextSubtitle} · {tile.tool}
              </Text>
            </View>
            {tile.status ? (
              <View className={cn("rounded border px-2 py-0.5", statusBoxClass(tile.statusKind))}>
                <Text
                  className={cn(
                    "text-[10px] font-bold uppercase",
                    statusTextClass(tile.statusKind),
                  )}
                >
                  {tile.status}
                </Text>
              </View>
            ) : null}
          </View>

          <View className="mt-3 flex-1 justify-end overflow-hidden border-t border-[#2a2b31] pt-3">
            {previewMode === "terminal" ? (
              terminalPreview.map((line, index) => (
                <Text
                  key={`${tile.id}:${index}`}
                  className={cn(
                    "font-mono text-[11.5px] leading-5",
                    hasPreview ? "text-[#d4d4d8]" : "text-[#666872]",
                  )}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {line.length === 0
                    ? " "
                    : line.map((span, spanIndex) => (
                        <RNText key={`${tile.id}:${index}:${spanIndex}`} style={span.style}>
                          {span.text}
                        </RNText>
                      ))}
                </Text>
              ))
            ) : hasPreview && chatEndpoint ? (
              <View className="min-h-full justify-end">
                {chatPreviewTail.map((message, index) => (
                  <View
                    key={message.id ?? message.clientMessageId ?? `${tile.id}:${index}`}
                    style={{ flexShrink: 0 }}
                  >
                    <MessageBlock
                      dividerWidth={chatDividerWidth}
                      message={message}
                      serviceEndpoint={chatEndpoint}
                    />
                  </View>
                ))}
              </View>
            ) : (
              <Text className="text-[12px] leading-5 text-[#666872]" numberOfLines={1}>
                No recent chat output.
              </Text>
            )}
          </View>
        </View>
      </PressableCard>
    </View>
  );
}

function SummaryPill({ label, value }: { label: string; value: number }) {
  return (
    <View className="mr-2 mb-2 rounded-full border border-border bg-card px-3 py-1.5">
      <Text className="text-[12px] font-semibold text-foreground">
        {label} <Text className="text-muted-foreground">{value}</Text>
      </Text>
    </View>
  );
}

export default function ExposeScreen() {
  const { width, height } = useWindowDimensions();
  const { colorScheme } = useColorScheme();
  const foregroundIconColor = colorScheme === "dark" ? "#fafafa" : "#09090b";
  const router = useRouter();
  const pathname = usePathname();
  const projects = useAtomValue(projectsAtom);
  const [exposePreviewMode, setExposePreviewMode] = useAtom(exposePreviewModeAtom);
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const setSelectedSession = useSetAtom(selectedSessionIdAtom);
  const searchParams = useGlobalSearchParams<{
    project?: string | string[];
    scope?: string | string[];
    filter?: string | string[];
  }>();
  const { getToken } = useAuth();
  const mountedRequestRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const [tiles, setTiles] = useState<ExposeTile[]>([]);
  const [projectResults, setProjectResults] = useState<ExposeProjectResult[]>([]);
  const [loadedViewKey, setLoadedViewKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const routeProjectPath = projectPathFromSearchOrLocation(searchParams.project);
  const scope = resolveScope(searchParams.scope);
  const filter = resolveFilter(searchParams.filter);
  const currentProjectPath = routeProjectPath ?? selectedProjectPath ?? projects[0]?.path ?? null;
  const currentProject = projects.find((project) => project.path === currentProjectPath) ?? null;
  const projectForRequest = currentProject ?? projects[0] ?? null;
  const projectEndpoint = projectForRequest ? getProjectServiceEndpoint(projectForRequest) : null;
  const projectRequestId = projectForRequest?.id ?? "";
  const projectRequestName = projectForRequest?.name ?? "";
  const projectRequestPath = projectForRequest?.path ?? "";
  const projectRequestDashboardSessionName = projectForRequest?.dashboardSessionName ?? "";
  const projectRequestServiceAlive = projectForRequest?.serviceAlive ?? false;
  const projectRequestEndpointHost = projectEndpoint?.host ?? "";
  const projectRequestEndpointPort = projectEndpoint?.port ?? null;
  const projectRequest = useMemo<DaemonProject | null>(
    () =>
      projectRequestPath
        ? {
            id: projectRequestId,
            name: projectRequestName,
            path: projectRequestPath,
            dashboardSessionName: projectRequestDashboardSessionName,
            service: null,
            serviceAlive: projectRequestServiceAlive,
            serviceEndpoint: projectRequestEndpointHost
              ? { host: projectRequestEndpointHost, port: projectRequestEndpointPort ?? 0 }
              : null,
          }
        : null,
    [
      projectRequestDashboardSessionName,
      projectRequestEndpointHost,
      projectRequestEndpointPort,
      projectRequestId,
      projectRequestName,
      projectRequestPath,
      projectRequestServiceAlive,
    ],
  );
  const viewKey =
    scope === "global"
      ? `global:${exposePreviewMode}`
      : `project:${currentProjectPath ?? ""}:${exposePreviewMode}`;
  const currentTiles = useMemo(
    () => (loadedViewKey === viewKey ? tiles : []),
    [loadedViewKey, tiles, viewKey],
  );
  const currentProjectResults = useMemo(
    () => (loadedViewKey === viewKey ? projectResults : []),
    [loadedViewKey, projectResults, viewKey],
  );
  const summary = useMemo(() => summarizeExposeTiles(currentTiles), [currentTiles]);
  const visibleTiles = useMemo(
    () => filterExposeTiles(currentTiles, filter),
    [currentTiles, filter],
  );
  const columns = width >= 1440 ? 3 : width >= 900 ? 2 : 1;
  const tileWidth = Math.max(280, Math.floor((width - (width >= 1024 ? 384 : 32)) / columns));
  const tileRows = Math.max(1, Math.ceil(Math.max(visibleTiles.length, 1) / columns));
  const exposeChromeHeight = width >= 900 ? 330 : 280;
  const gridGapHeight = Math.max(0, tileRows - 1) * 16;
  const targetGridHeight = Math.max(0, height - exposeChromeHeight);
  const tileHeight = Math.max(
    width >= 900 ? 260 : 240,
    Math.min(420, Math.floor((targetGridHeight - gridGapHeight) / tileRows)),
  );
  const offlineProjects = currentProjectResults.filter((result) => result.error);
  const relayReadyForRequests = relayStatus !== "connecting";

  const refresh = useCallback(async () => {
    const requestId = mountedRequestRef.current + 1;
    mountedRequestRef.current = requestId;
    if (!relayReadyForRequests) return;
    activeControllerRef.current?.abort();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    setPending(true);
    try {
      const token = await getToken();
      const fetched =
        scope === "global"
          ? await (async () => {
              const response = await listGlobalExposeItems({
                token,
                includeChatPreview: exposePreviewMode === "chat",
                signal: controller.signal,
                timeoutMs: 5000,
              });
              return {
                tiles: buildExposeTiles(
                  sourcesForGlobalExposeItems(projects, response.items as ExposeSourceItem[]),
                ),
                results: [{ projectName: "all projects", error: null }],
              };
            })()
          : await (async () => {
              const project = projectRequest;
              if (!project) return { tiles: [], results: [] };
              const endpoint = project.serviceEndpoint;
              if (!endpoint) {
                return {
                  tiles: [],
                  results: [{ projectName: project.name, error: "Project host offline" }],
                };
              }
              const input = {
                scope: "all",
                labelFormat: "raw",
                includePreview: "1",
                expose: "1",
              } as const;
              const response = await listSwitchableAgents(
                endpoint,
                exposePreviewMode === "chat" ? { ...input, includeChatPreview: "1" } : input,
                {
                  token,
                  signal: controller.signal,
                  timeoutMs: 10000,
                },
              );
              return {
                tiles: buildExposeTiles([{ project, items: response.items as ExposeSourceItem[] }]),
                results: [{ projectName: project.name, error: null }],
              };
            })();
      if (mountedRequestRef.current !== requestId) return;
      setTiles(fetched.tiles);
      setProjectResults(fetched.results);
      setLoadedViewKey(viewKey);
    } catch (err) {
      if (!controller.signal.aborted && !isTransientRequestError(err)) {
        setTiles([]);
        setProjectResults([
          {
            projectName: scope === "global" ? "all projects" : (projectRequest?.name ?? "project"),
            error: getErrorMessage(err),
          },
        ]);
        setLoadedViewKey(viewKey);
      }
    } finally {
      if (mountedRequestRef.current === requestId) setPending(false);
      if (activeControllerRef.current === controller) activeControllerRef.current = null;
    }
  }, [
    exposePreviewMode,
    getToken,
    projectRequest,
    projects,
    relayReadyForRequests,
    scope,
    viewKey,
  ]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh();
    }, 0);
    return () => {
      clearTimeout(timer);
      mountedRequestRef.current += 1;
      activeControllerRef.current?.abort();
    };
  }, [refresh]);

  function setScope(nextScope: ExposeScope) {
    router.replace({
      pathname: "/expose",
      params: {
        project: currentProjectPath ?? undefined,
        scope: nextScope === "global" ? "global" : undefined,
        filter: filter === "all" ? undefined : filter,
      },
    });
  }

  function setFilter(nextFilter: ExposeFilter) {
    router.replace({
      pathname: "/expose",
      params: {
        project: currentProjectPath ?? undefined,
        scope: scope === "global" ? "global" : undefined,
        filter: nextFilter === "all" ? undefined : nextFilter,
      },
    });
  }

  function openTile(tile: ExposeTile) {
    blurWebActiveElement();
    if (tile.kind === "agent") {
      setSelectedSession(tile.sessionId);
      router.push(detailHrefForPath(pathname, "agent", tile.sessionId, tile.projectRoot));
      return;
    }
    router.push(detailHrefForPath(pathname, "service", tile.sessionId, tile.projectRoot));
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-4 py-5 md:px-8"
        keyboardShouldPersistTaps="handled"
      >
        <PageHeader
          eyebrow="Exposé"
          title={scope === "global" ? "All Worktrees" : (currentProject?.name ?? "Project Exposé")}
          subtitle={
            scope === "global"
              ? "Projects are ordered by the sidebar; worktrees and sessions keep dashboard order."
              : (currentProject?.path ?? "Select a project to inspect live panes.")
          }
          actions={
            <Button
              variant="outline"
              size="icon"
              disabled={pending}
              onPress={() => void refresh()}
              accessibilityLabel="Refresh Exposé"
            >
              <RefreshCw size={18} color={foregroundIconColor} />
            </Button>
          }
        />

        <View className="mb-4 gap-3 md:flex-row md:items-center md:justify-between">
          <View className="gap-3 sm:flex-row sm:items-center">
            <SegmentedControl
              options={[
                { value: "project", label: "Project" },
                { value: "global", label: "Global" },
              ]}
              value={scope}
              onChange={setScope}
              className="bg-card"
            />
            <SegmentedControl
              options={PREVIEW_MODE_OPTIONS}
              value={exposePreviewMode}
              onChange={setExposePreviewMode}
              className="bg-card"
            />
          </View>
          <SegmentedControl
            options={FILTER_OPTIONS}
            value={filter}
            onChange={setFilter}
            className="bg-card"
          />
        </View>

        <View className="mb-3 flex-row flex-wrap">
          <SummaryPill label="Total" value={summary.total} />
          <SummaryPill label="Working" value={summary.working} />
          <SummaryPill label="Needs" value={summary.attention} />
          <SummaryPill label="Ready" value={summary.ready} />
        </View>

        {offlineProjects.length > 0 ? (
          <View className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
            <Text className="text-[13px] font-semibold text-foreground">
              {offlineProjects.length} project{offlineProjects.length > 1 ? "s" : ""} unavailable
            </Text>
            <Text className="mt-1 text-[12px] text-muted-foreground" numberOfLines={2}>
              {offlineProjects
                .map((result) => `${result.projectName}: ${result.error ?? "unavailable"}`)
                .join(" · ")}
            </Text>
          </View>
        ) : null}

        {pending && currentTiles.length === 0 ? (
          <PageStateCard title="Loading Exposé..." body="Fetching pane previews." />
        ) : visibleTiles.length === 0 ? (
          <PageStateCard
            title="No matching panes"
            body={
              filter === "all" ? "No agent or service panes are available." : "Try another filter."
            }
          />
        ) : (
          <View className="-m-2 flex-row flex-wrap">
            {visibleTiles.map((tile) => (
              <ExposeTileCard
                key={tile.id}
                tile={tile}
                tileWidth={tileWidth}
                tileHeight={tileHeight}
                previewMode={exposePreviewMode}
                onPress={() => openTile(tile)}
              />
            ))}
          </View>
        )}

        {visibleTiles.length > 0 ? (
          <View className="mt-4 flex-row items-center gap-2 opacity-70">
            <CheckCircle2 size={14} color="#a1a1aa" />
            <Text className="text-[12px] text-muted-foreground">
              Previews use the project service Exposé cache.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
