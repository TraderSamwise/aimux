import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Bell,
  BookOpen,
  ChevronLeft,
  FolderKanban,
  MessageSquare,
  Network,
} from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { WorktreeList } from "@/components/WorktreeDashboard";
import { useAuth } from "@/lib/auth";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopState } from "@/lib/desktop-state";
import { MAIN_TAB_ROUTES, mainTabForPath, type MainTabId } from "@/lib/main-tabs";
import {
  buildViewHref,
  detailHrefForPath,
  parentViewHrefForPath,
  projectPathFromSearchOrLocation,
  type SearchValue,
} from "@/lib/view-location";
import { cn } from "@/lib/utils";
import {
  desktopStateErrorFamily,
  desktopStateFamily,
  worktreeGroupsFamily,
} from "@/stores/desktopState";
import type { DaemonProject } from "@/lib/api";
import {
  projectsAtom,
  selectedProjectAtom,
  selectedProjectEndpointAtom,
  selectedProjectPathAtom,
  selectedSessionIdAtom,
  selectProjectAtom,
} from "@/stores/projects";
import { sidebarModeAtom, sidebarShowProjectPickerAtom } from "@/stores/ui";
import { getProjectServiceEndpoint, projectStateErrorCopy } from "@/lib/project-connection-display";

// Restyle palette (Linear-style lifted slate) — mirrors docs/mockups/project-view.html.
//   sidebar bg #161719 · hairline #2a2b31 · press #232429 · selected #26272d
//   text fg #edeef0 · muted #a6a8b0 / #787a83 · faint #5b5d66

const SIDEBAR_WIDTH = 320;
const EMPTY_PROJECT_PATH = "__aimux_no_selected_project__";
const usePrePaintEffect = Platform.OS === "web" ? useLayoutEffect : useEffect;
type SidebarMode = "dashboard" | "views";

function routePrefersViews(tab: MainTabId): boolean {
  return (
    tab === "project" ||
    tab === "coordination" ||
    tab === "topology" ||
    tab === "library" ||
    tab === "inbox" ||
    tab === "threads"
  );
}

// ─── Project picker ───────────────────────────────────────────────────────

function ProjectPicker({
  projects,
  selectedPath,
  onSelect,
}: {
  projects: DaemonProject[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <View className="pt-4 pb-2">
      <View className="px-3.5 pb-2">
        <Text className="text-[10px] font-bold uppercase tracking-widest text-[#787a83]">
          Projects
        </Text>
      </View>
      {projects.length === 0 ? (
        <View className="px-3.5 py-3">
          <Text className="text-[13px] text-[#787a83]">No projects detected</Text>
        </View>
      ) : (
        projects.map((project) => {
          const isSelected = project.path === selectedPath;
          const isOnline = project.serviceAlive;
          return (
            <Pressable
              key={project.path}
              onPress={() => onSelect(project.path)}
              className={cn(
                "px-4 py-3",
                isSelected ? "bg-[#26272d]" : "hover:bg-[#232429] active:bg-[#26272d]",
              )}
            >
              <View className="flex-row items-center gap-2.5">
                <View
                  className={cn(
                    "h-[7px] w-[7px] rounded-full",
                    isOnline ? "bg-[#4ade80]" : "bg-[#5b5d66]",
                  )}
                />
                <Text
                  className="min-w-0 flex-1 text-[14px] font-medium text-[#edeef0]"
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {project.name}
                </Text>
                <Text
                  className={cn(
                    "font-mono text-[11px]",
                    isOnline ? "text-[#4ade80]" : "text-[#787a83]",
                  )}
                >
                  {isOnline ? "online" : "offline"}
                </Text>
              </View>
              <Text
                className="ml-4 mt-0.5 font-mono text-[12px] text-[#787a83]"
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {project.path}
              </Text>
            </Pressable>
          );
        })
      )}
    </View>
  );
}

// ─── Project header ────────────────────────────────────────────────────────

function ProjectHeader({
  project,
  onSwitchProject,
}: {
  project: DaemonProject;
  onSwitchProject: () => void;
}) {
  return (
    <Pressable
      onPress={onSwitchProject}
      accessibilityLabel="Switch project"
      className="border-b border-[#2a2b31] px-4 pb-3.5 pt-4 hover:bg-[#232429] active:bg-[#26272d]"
    >
      <View className="flex-row items-center gap-1.5">
        <ChevronLeft size={14} color="#787a83" />
        <Text className="text-[12.5px] font-medium text-[#787a83]">All projects</Text>
      </View>
      <Text
        className="mt-2 text-[16px] font-semibold text-[#edeef0]"
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {project.name}
      </Text>
      <Text
        className="mt-0.5 font-mono text-[12px] text-[#787a83]"
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {project.path}
      </Text>
    </Pressable>
  );
}

// ─── Worktree tree (top-level for the project) ────────────────────────────

function SidebarStateCard({
  title,
  detail,
  tone = "default",
}: {
  title: string;
  detail?: string;
  tone?: "default" | "warning";
}) {
  return (
    <View
      className={cn(
        "mx-2 mt-3 mb-2 rounded-lg border px-3 py-3",
        tone === "warning"
          ? "border-amber-500/30 bg-amber-500/10"
          : "border-[#2a2b31] bg-[#1f2025]",
      )}
    >
      <Text className="text-[12px] font-medium leading-snug text-[#edeef0]">{title}</Text>
      {detail ? (
        <Text className="mt-1 text-[11px] leading-snug text-[#787a83]">{detail}</Text>
      ) : null}
    </View>
  );
}

function WorktreeTree({
  projectPath,
  endpoint,
  token,
  desktopState,
  desktopStateError,
  selectedSessionId,
  onPickSession,
  onPickService,
  onKillSession,
}: {
  projectPath: string;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  desktopState: DesktopState | null;
  desktopStateError: string | null;
  selectedSessionId: string | null;
  onPickSession: (sessionId: string) => void;
  onPickService: (serviceId: string) => void;
  onKillSession: (sessionId: string) => void;
}) {
  const groups = useAtomValue(worktreeGroupsFamily(projectPath));

  if (!endpoint && desktopState === null) {
    return (
      <SidebarStateCard
        title="Project host not running."
        detail="Start the host to see worktrees, agents, and services."
      />
    );
  }

  if (endpoint && desktopState === null && desktopStateError) {
    const copy = projectStateErrorCopy(desktopStateError);
    return <SidebarStateCard title={copy.title} detail={copy.detail} tone="warning" />;
  }

  if (endpoint && desktopState === null) {
    return (
      <View className="px-4 py-4">
        <Text className="text-xs text-[#787a83]">Loading project state...</Text>
      </View>
    );
  }

  if (groups.length === 0) {
    return (
      <View className="px-4 py-4">
        <Text className="text-xs text-[#787a83]">No worktrees yet</Text>
      </View>
    );
  }

  // The sidebar's Dashboard view is the worktree dashboard, narrower: reuse the
  // same cards in their compact (navigation-only) variant.
  return (
    <View className="px-2 pb-2">
      <WorktreeList
        groups={groups}
        projectPath={projectPath}
        endpoint={endpoint}
        token={token}
        padded={false}
        compact
        activeOnly
        selectedSessionId={selectedSessionId}
        onPickSession={onPickSession}
        onPickService={onPickService}
        onKillSession={onKillSession}
      />
    </View>
  );
}

// ─── Desktop primary nav ─────────────────────────────────────────────────

const PRIMARY_NAV = [
  { id: "project", label: "Project", Icon: FolderKanban },
  { id: "coordination", label: "Coordination", Icon: Bell },
  { id: "topology", label: "Topology", Icon: Network },
  { id: "library", label: "Library", Icon: BookOpen },
  { id: "inbox", label: "Inbox", Icon: Bell },
  { id: "threads", label: "Threads", Icon: MessageSquare },
];

function SidebarModeTabs({
  mode,
  onChange,
}: {
  mode: SidebarMode;
  onChange: (mode: SidebarMode) => void;
}) {
  return (
    <View className="flex-row gap-5 border-b border-[#2a2b31] px-4">
      {(["dashboard", "views"] as const).map((tab) => {
        const active = mode === tab;
        const label = tab === "dashboard" ? "Dashboard" : "Views";
        return (
          <Pressable
            key={tab}
            onPress={() => onChange(tab)}
            className={cn(
              "border-b-[1.5px] py-3",
              active ? "border-[#edeef0]" : "border-transparent",
            )}
          >
            <Text
              className={cn(
                "text-[13.5px] font-medium",
                active ? "text-[#edeef0]" : "text-[#787a83]",
              )}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SidebarPrimaryNav({ projectPath }: { projectPath: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useGlobalSearchParams() as Record<string, SearchValue>;
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const activeTab = mainTabForPath(pathname);
  const routeProjectPath =
    projectPath ?? projectPathFromSearchOrLocation(searchParams.project) ?? selectedProjectPath;

  return (
    <View className="p-1.5">
      {PRIMARY_NAV.map(({ id, label, Icon }) => {
        const tabId = id as MainTabId;
        const active = activeTab === tabId;
        return (
          <Pressable
            key={id}
            onPress={() => {
              const href = buildViewHref(MAIN_TAB_ROUTES[tabId].href, {
                project: routeProjectPath,
              });
              router.push(href);
            }}
            className={cn(
              "mb-0.5 flex-row items-center gap-2 rounded-md px-2 py-2",
              active ? "bg-[#26272d]" : "hover:bg-[#232429] active:bg-[#26272d]",
            )}
          >
            <Icon size={15} color={active ? "#edeef0" : "#787a83"} />
            <Text
              className={cn(
                "text-[13px] font-medium",
                active ? "text-[#edeef0]" : "text-[#787a83]",
              )}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ─── Top-level component ──────────────────────────────────────────────────

export function ProjectSidebar({ showPrimaryNav = true }: { showPrimaryNav?: boolean }) {
  const projects = useAtomValue(projectsAtom);
  const selectedProject = useAtomValue(selectedProjectAtom);
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const selectedProjectEndpoint = useAtomValue(selectedProjectEndpointAtom);
  const selectedSessionId = useAtomValue(selectedSessionIdAtom);
  const selectProject = useSetAtom(selectProjectAtom);
  const setSelectedSession = useSetAtom(selectedSessionIdAtom);
  const showPicker = useAtomValue(sidebarShowProjectPickerAtom);
  const setShowPicker = useSetAtom(sidebarShowProjectPickerAtom);
  const router = useRouter();
  const pathname = usePathname();
  const routeTab = mainTabForPath(pathname);
  const [sidebarMode, setSidebarMode] = useAtom(sidebarModeAtom);
  const searchParams = useGlobalSearchParams() as Record<string, SearchValue>;
  const effectiveProjectPath =
    projectPathFromSearchOrLocation(searchParams.project) ?? selectedProjectPath;
  const effectiveProject =
    projects.find((project) => project.path === effectiveProjectPath) ?? selectedProject;
  const routeProjectPath = effectiveProject?.path ?? effectiveProjectPath;
  const endpoint = effectiveProject
    ? getProjectServiceEndpoint(effectiveProject)
    : selectedProjectEndpoint;

  // Fetch auth token once (auth context is stable in LOCAL_MODE; refetch is cheap).
  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await getToken();
        if (!cancelled) setToken(t);
      } catch {
        if (!cancelled) setToken(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  // Auto-close the picker when the selected project path changes externally
  // (e.g., auto-reconcile fallback when the stored project disappears).
  const previousProjectPathRef = useRef({
    effectiveProjectPath,
    selectedProjectPath,
  });
  usePrePaintEffect(() => {
    const previous = previousProjectPathRef.current;
    previousProjectPathRef.current = { effectiveProjectPath, selectedProjectPath };
    if (
      showPicker &&
      (previous.effectiveProjectPath !== effectiveProjectPath ||
        previous.selectedProjectPath !== selectedProjectPath)
    ) {
      setShowPicker(false);
    }
  }, [effectiveProjectPath, selectedProjectPath, setShowPicker, showPicker]);

  usePrePaintEffect(() => {
    if (!showPrimaryNav) return;
    if (routePrefersViews(routeTab)) {
      setSidebarMode("views");
    }
  }, [routeTab, setSidebarMode, showPrimaryNav]);

  const desktopState = useAtomValue(desktopStateFamily(routeProjectPath ?? EMPTY_PROJECT_PATH));
  const desktopStateError = useAtomValue(
    desktopStateErrorFamily(routeProjectPath ?? EMPTY_PROJECT_PATH),
  );
  const pickerMode = !effectiveProject || showPicker;

  function handlePickProject(path: string) {
    selectProject(path);
    setShowPicker(false);
    // Selecting a project always lands on the Project screen's Dashboard section.
    router.replace(buildViewHref("/project", { project: path }));
  }

  function handlePickSession(sessionId: string) {
    setSelectedSession(sessionId);
    router.push(detailHrefForPath(pathname, "agent", sessionId, routeProjectPath));
  }

  function handlePickService(serviceId: string) {
    router.push(detailHrefForPath(pathname, "service", serviceId, routeProjectPath));
  }

  function handleKillSession(sessionId: string) {
    if (selectedSessionId !== sessionId) return;
    setSelectedSession(null);
    if (pathname.includes("/agent/")) {
      router.replace(parentViewHrefForPath(pathname, routeProjectPath));
    }
  }

  return (
    <View
      className="border-r border-[#2a2b31] bg-[#161719]"
      style={{ width: SIDEBAR_WIDTH, height: "100%" }}
    >
      <ScrollView className="flex-1">
        {pickerMode ? (
          <ProjectPicker
            projects={projects}
            selectedPath={effectiveProjectPath}
            onSelect={handlePickProject}
          />
        ) : (
          <>
            <ProjectHeader
              project={effectiveProject!}
              onSwitchProject={() => setShowPicker(true)}
            />
            {showPrimaryNav ? (
              <>
                <SidebarModeTabs mode={sidebarMode} onChange={setSidebarMode} />
                {sidebarMode === "views" ? (
                  <SidebarPrimaryNav projectPath={routeProjectPath} />
                ) : (
                  <WorktreeTree
                    projectPath={effectiveProject!.path}
                    endpoint={endpoint}
                    token={token}
                    desktopState={desktopState}
                    desktopStateError={desktopStateError}
                    selectedSessionId={selectedSessionId}
                    onPickSession={handlePickSession}
                    onPickService={handlePickService}
                    onKillSession={handleKillSession}
                  />
                )}
              </>
            ) : (
              <WorktreeTree
                projectPath={effectiveProject!.path}
                endpoint={endpoint}
                token={token}
                desktopState={desktopState}
                desktopStateError={desktopStateError}
                selectedSessionId={selectedSessionId}
                onPickSession={handlePickSession}
                onPickService={handlePickService}
                onKillSession={handleKillSession}
              />
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
