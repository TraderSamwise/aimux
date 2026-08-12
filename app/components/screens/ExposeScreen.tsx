import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { CheckCircle2, RefreshCw } from "lucide-react-native";
import { useColorScheme } from "nativewind";
import { PageHeader, PageStateCard } from "@/components/PageLayout";
import { Button } from "@/components/ui/button";
import { PressableCard } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Text } from "@/components/ui/text";
import { getDesktopState } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { blurWebActiveElement } from "@/lib/blur-web-active-element";
import { groupByWorktree } from "@/lib/desktop-state";
import {
  buildExposeTiles,
  filterExposeTiles,
  summarizeExposeTiles,
  type ExposeFilter,
  type ExposeTile,
} from "@/lib/expose-model";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import { getErrorMessage, isTransientRequestError } from "@/lib/request-errors";
import { cn } from "@/lib/utils";
import { detailHrefForPath, projectPathFromSearchOrLocation } from "@/lib/view-location";
import { worktreeGroupsFamily } from "@/stores/desktopState";
import { projectsAtom, selectedProjectPathAtom, selectedSessionIdAtom } from "@/stores/projects";
import { relayStatusAtom } from "@/stores/relay";

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
  { value: "offline", label: "Offline" },
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
    case "attention":
      return "border-amber-500/30 bg-amber-500/10";
    case "ready":
      return "border-sky-500/25 bg-sky-500/10";
    case "offline":
      return "border-zinc-500/20 bg-zinc-500/10";
  }
}

function statusTextClass(kind: ExposeTile["statusKind"]): string {
  switch (kind) {
    case "working":
      return "text-emerald-300";
    case "attention":
      return "text-amber-300";
    case "ready":
      return "text-sky-300";
    case "offline":
      return "text-zinc-400";
  }
}

function dotClass(kind: ExposeTile["statusKind"]): string {
  switch (kind) {
    case "working":
      return "bg-emerald-400";
    case "attention":
      return "bg-amber-400";
    case "ready":
      return "bg-sky-400";
    case "offline":
      return "bg-zinc-600";
  }
}

function ExposeTileCard({
  tile,
  tileWidth,
  onPress,
}: {
  tile: ExposeTile;
  tileWidth: number;
  onPress: () => void;
}) {
  const preview = tile.previewLines.length > 0 ? tile.previewLines : ["No recent pane output."];
  return (
    <View className="p-2" style={{ width: tileWidth }}>
      <PressableCard
        onPress={onPress}
        className={cn(
          "min-h-[210px] rounded-lg border bg-[#17181d] p-0 overflow-hidden hover:bg-[#1c1d23]",
          tile.statusKind === "offline" ? "border-[#2a2b31]" : "border-[#334155]",
        )}
      >
        <View className="flex-1 border-l-4 p-3.5" style={{ borderLeftColor: tile.tone }}>
          <View className="flex-row items-start gap-2">
            <View className={cn("mt-1 h-2 w-2 rounded-full", dotClass(tile.statusKind))} />
            <View className="min-w-0 flex-1">
              <View className="flex-row items-baseline gap-2">
                <Text
                  className="min-w-0 shrink text-[15px] font-bold text-[#f4f4f5]"
                  numberOfLines={1}
                >
                  {tile.label}
                </Text>
                <Text className="shrink-0 font-mono text-[11px] text-[#8b8d97]" numberOfLines={1}>
                  {tile.tool}
                </Text>
              </View>
              <Text
                className="mt-1 font-mono text-[11px] text-[#7c7e88]"
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {tile.projectName} · {tile.worktreeName}
                {tile.branch ? ` · ${tile.branch}` : ""}
              </Text>
            </View>
            <View className={cn("rounded border px-2 py-0.5", statusBoxClass(tile.statusKind))}>
              <Text
                className={cn("text-[10px] font-bold uppercase", statusTextClass(tile.statusKind))}
              >
                {tile.status}
              </Text>
            </View>
          </View>

          <View className="mt-3 border-t border-[#2a2b31] pt-3">
            {preview.map((line, index) => (
              <Text
                key={`${tile.id}:${index}`}
                className={cn(
                  "font-mono text-[11.5px] leading-5",
                  tile.previewLines.length > 0 ? "text-[#d4d4d8]" : "text-[#666872]",
                )}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {line}
              </Text>
            ))}
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
        {label} <Text className="font-mono text-muted-foreground">{value}</Text>
      </Text>
    </View>
  );
}

export default function ExposeScreen() {
  const { width } = useWindowDimensions();
  const { colorScheme } = useColorScheme();
  const foregroundIconColor = colorScheme === "dark" ? "#fafafa" : "#09090b";
  const router = useRouter();
  const pathname = usePathname();
  const projects = useAtomValue(projectsAtom);
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
  const [pending, setPending] = useState(false);

  const routeProjectPath = projectPathFromSearchOrLocation(searchParams.project);
  const scope = resolveScope(searchParams.scope);
  const filter = resolveFilter(searchParams.filter);
  const currentProjectPath = routeProjectPath ?? selectedProjectPath ?? projects[0]?.path ?? null;
  const currentProject = projects.find((project) => project.path === currentProjectPath) ?? null;
  const cachedCurrentGroups = useAtomValue(worktreeGroupsFamily(currentProjectPath ?? ""));
  const visibleProjects = useMemo(
    () =>
      scope === "global" ? projects : currentProject ? [currentProject] : projects.slice(0, 1),
    [currentProject, projects, scope],
  );
  const cachedProjectTiles = useMemo(
    () =>
      scope === "project" && currentProject && cachedCurrentGroups.length > 0
        ? buildExposeTiles([{ project: currentProject, groups: cachedCurrentGroups }])
        : [],
    [cachedCurrentGroups, currentProject, scope],
  );
  const displayTiles = tiles.length > 0 ? tiles : cachedProjectTiles;
  const summary = useMemo(() => summarizeExposeTiles(displayTiles), [displayTiles]);
  const visibleTiles = useMemo(
    () => filterExposeTiles(displayTiles, filter),
    [displayTiles, filter],
  );
  const columns = width >= 1440 ? 3 : width >= 900 ? 2 : 1;
  const tileWidth = Math.max(280, Math.floor((width - (width >= 1024 ? 384 : 32)) / columns));
  const offlineProjects = projectResults.filter((result) => result.error);
  const relayReadyForRequests = relayStatus !== "connecting";
  const viewKey = scope === "global" ? "global" : `project:${currentProjectPath ?? ""}`;

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
      const fetched = await Promise.all(
        visibleProjects.map(async (project) => {
          const tilesForProject: ExposeTile[] = [];
          const resultsForProject: ExposeProjectResult[] = [];
          const endpoint = getProjectServiceEndpoint(project);
          if (!endpoint) {
            resultsForProject.push({
              projectName: project.name,
              error: "Project host offline",
            });
            return { tiles: tilesForProject, results: resultsForProject };
          }
          try {
            const state = await getDesktopState(endpoint, {
              token,
              includePreview: true,
              signal: controller.signal,
              timeoutMs: scope === "global" ? 5000 : 10000,
            });
            tilesForProject.push(
              ...buildExposeTiles([{ project, groups: groupByWorktree(state) }]),
            );
            resultsForProject.push({ projectName: project.name, error: null });
          } catch (err) {
            if (!controller.signal.aborted && !isTransientRequestError(err)) {
              resultsForProject.push({
                projectName: project.name,
                error: getErrorMessage(err),
              });
            }
          }
          return { tiles: tilesForProject, results: resultsForProject };
        }),
      );
      if (mountedRequestRef.current !== requestId) return;
      const nextTiles = fetched.flatMap((item) => item.tiles);
      const results = fetched.flatMap((item) => item.results);
      setTiles(nextTiles);
      setProjectResults(results);
    } finally {
      if (mountedRequestRef.current === requestId) setPending(false);
      if (activeControllerRef.current === controller) activeControllerRef.current = null;
    }
  }, [getToken, relayReadyForRequests, scope, visibleProjects]);

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

  useEffect(() => {
    setTiles([]);
    setProjectResults([]);
  }, [viewKey]);

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
          <SummaryPill label="Offline" value={summary.offline} />
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

        {pending && tiles.length === 0 ? (
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
                onPress={() => openTile(tile)}
              />
            ))}
          </View>
        )}

        {!pending && visibleTiles.length > 0 ? (
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
