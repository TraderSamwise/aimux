import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Bell,
  BookOpen,
  ChevronLeft,
  FolderKanban,
  GitBranch,
  MessageSquare,
  Network,
} from "lucide-react-native";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { ServiceActions } from "@/components/service-actions";
import { StatusDot } from "@/components/status-dot";
import { useAuth } from "@/lib/auth";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type {
  DesktopService,
  DesktopSession,
  DesktopState,
  WorktreeBucket,
} from "@/lib/desktop-state";
import {
  MAIN_TAB_ROUTES,
  mainTabForPath,
  useMainTabNavigation,
  type MainTabId,
} from "@/lib/main-tabs";
import {
  buildViewHref,
  detailHrefForPath,
  mergeViewParams,
  projectPathFromSearchOrLocation,
  type SearchValue,
} from "@/lib/view-location";
import { firstTokenOf } from "@/lib/status-tone";
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

// Type ladder used throughout the sidebar:
//   - Project name / worktree name (title)      → text-[15px] font-bold
//   - Section headings (Agents, Services)       → text-[10px] uppercase tracking-widest
//   - Row primary (agent/service label)         → text-[13px] font-medium
//   - Row secondary (tool, status, detail)      → text-[11px] text-muted-foreground
//   - Path / branch chip                        → text-[11px] muted

const SIDEBAR_WIDTH = 320;
const EMPTY_PROJECT_PATH = "__aimux_no_selected_project__";
const usePrePaintEffect = Platform.OS === "web" ? useLayoutEffect : useEffect;
type SidebarMode = "dashboard" | "views";

function routePrefersViews(tab: MainTabId): boolean {
  return (
    tab === "project" ||
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
    <View className="pt-5 pb-2">
      <View className="px-4 pb-3">
        <Text className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Projects
        </Text>
      </View>
      {projects.length === 0 ? (
        <View className="px-4 py-3">
          <Text className="text-sm text-muted-foreground">No projects detected</Text>
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
                "px-4 py-2.5 border-l-2",
                isSelected
                  ? "border-l-emerald-500 bg-accent"
                  : "border-l-transparent active:bg-accent/60",
              )}
            >
              <View className="flex-row items-center gap-2">
                <View
                  className={cn(
                    "h-2 w-2 rounded-full",
                    isOnline ? "bg-emerald-400" : "bg-muted-foreground/35",
                  )}
                />
                <Text
                  className="text-[14px] font-semibold text-foreground flex-1 min-w-0"
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {project.name}
                </Text>
                <Text
                  className={cn(
                    "text-[9px] font-bold uppercase tracking-wide",
                    isOnline ? "text-emerald-400" : "text-muted-foreground",
                  )}
                >
                  {isOnline ? "online" : "offline"}
                </Text>
              </View>
              <Text
                className="text-[11px] text-muted-foreground mt-0.5 ml-4"
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

// ─── Project header (within tree view) ────────────────────────────────────

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
      className="flex-row items-center px-4 py-3.5 border-b border-border bg-card active:bg-accent"
    >
      <View className="mr-2 -ml-1">
        <ChevronLeft size={16} color="#a1a1aa" />
      </View>
      <View className="flex-1 min-w-0">
        <Text className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">
          All projects
        </Text>
        <Text
          className="text-[16px] font-bold text-foreground"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {project.name}
        </Text>
        <Text
          className="text-[11px] text-muted-foreground mt-1"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {project.path}
        </Text>
      </View>
    </Pressable>
  );
}

// ─── Branch chip ──────────────────────────────────────────────────────────

function BranchChip({ branch }: { branch: string }) {
  return (
    <View className="flex-row items-center self-start px-2 py-0.5 rounded bg-background border border-border max-w-full">
      <GitBranch size={10} color="#a1a1aa" />
      <Text
        className="text-[10px] font-mono text-muted-foreground ml-1.5"
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {branch}
      </Text>
    </View>
  );
}

// ─── Agent row ────────────────────────────────────────────────────────────

function AgentRow({
  session,
  isSelected,
  onPress,
}: {
  session: DesktopSession;
  isSelected: boolean;
  onPress: () => void;
}) {
  const tool = firstTokenOf(session.command);
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "flex-row items-center px-3 py-2",
        isSelected ? "bg-accent" : "active:bg-accent/60",
      )}
    >
      <View className="mr-2.5">
        <StatusDot status={session.status} size="sm" />
      </View>
      <View className="flex-1 min-w-0">
        <Text
          className="text-[13px] font-medium text-foreground"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {session.label || session.id}
        </Text>
        <Text className="text-[11px] text-muted-foreground mt-0.5" numberOfLines={1}>
          {tool ? `${tool} · ${session.status}` : session.status}
        </Text>
      </View>
    </Pressable>
  );
}

// ─── Service row ──────────────────────────────────────────────────────────

function ServiceRow({
  service,
  endpoint,
  token,
  onPress,
}: {
  service: DesktopService;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  onPress: () => void;
}) {
  const detail = service.shellCommand ?? service.previewLine ?? service.command ?? "";

  return (
    <View className="flex-row items-center px-3 py-2">
      <Pressable
        onPress={onPress}
        className="flex-1 flex-row items-center min-w-0 active:opacity-70"
      >
        <View className="mr-2.5">
          <StatusDot status={service.status} size="sm" />
        </View>
        <View className="flex-1 min-w-0">
          <Text
            className="text-[13px] font-medium text-foreground"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {service.label || service.id}
          </Text>
          <Text
            className="text-[11px] text-muted-foreground mt-0.5"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {detail ? `${detail} · ${service.status}` : service.status}
          </Text>
        </View>
      </Pressable>
      <View className="ml-2">
        <ServiceActions service={service} endpoint={endpoint} token={token} compact />
      </View>
    </View>
  );
}

// ─── Worktree group ───────────────────────────────────────────────────────

function WorktreeGroup({
  bucket,
  endpoint,
  token,
  selectedSessionId,
  onPickSession,
  onPickService,
}: {
  bucket: WorktreeBucket;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  selectedSessionId: string | null;
  onPickSession: (sessionId: string) => void;
  onPickService: (serviceId: string) => void;
}) {
  const hasAgents = bucket.sessions.length > 0;
  const hasServices = bucket.services.length > 0;
  const railColor = bucket.isMainCheckout ? "bg-emerald-500" : "bg-sky-500";

  return (
    <Card className="mx-3 mb-3 p-0 overflow-hidden">
      {/* Worktree header */}
      <View className="flex-row items-stretch border-b border-border bg-secondary">
        <View className={cn("w-1", railColor)} />
        <View className="flex-1 min-w-0 px-3.5 py-3">
          <Text
            className="text-[15px] font-bold text-foreground"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {bucket.name}
          </Text>
          {bucket.branch ? (
            <View className="mt-2">
              <BranchChip branch={bucket.branch} />
            </View>
          ) : null}
        </View>
      </View>

      {/* Body */}
      {hasAgents ? (
        <View className="pb-1">
          <View className="px-3.5 pt-3 pb-1.5">
            <Text className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Agents · {bucket.sessions.length}
            </Text>
          </View>
          {bucket.sessions.map((session) => (
            <AgentRow
              key={session.id}
              session={session}
              isSelected={session.id === selectedSessionId}
              onPress={() => onPickSession(session.id)}
            />
          ))}
        </View>
      ) : null}

      {hasServices ? (
        <View className={cn("pb-2", hasAgents && "border-t border-border")}>
          <View className="px-3.5 pt-3 pb-1.5">
            <Text className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Services · {bucket.services.length}
            </Text>
          </View>
          {bucket.services.map((service) => (
            <ServiceRow
              key={service.id}
              service={service}
              endpoint={endpoint}
              token={token}
              onPress={() => onPickService(service.id)}
            />
          ))}
        </View>
      ) : null}

      {!hasAgents && !hasServices ? (
        <View className="px-3.5 py-3">
          <Text className="text-[11px] text-muted-foreground italic">empty worktree</Text>
        </View>
      ) : (
        <View className="h-0.5" />
      )}
    </Card>
  );
}

// ─── Worktree tree (top-level for the project) ────────────────────────────

function WorktreeTree({
  projectPath,
  endpoint,
  token,
  desktopState,
  desktopStateError,
  selectedSessionId,
  onPickSession,
  onPickService,
}: {
  projectPath: string;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  desktopState: DesktopState | null;
  desktopStateError: string | null;
  selectedSessionId: string | null;
  onPickSession: (sessionId: string) => void;
  onPickService: (serviceId: string) => void;
}) {
  const groups = useAtomValue(worktreeGroupsFamily(projectPath));

  if (!endpoint && desktopState === null) {
    return (
      <View className="mx-3 mt-3 mb-2 rounded-lg border border-border bg-card px-3 py-3">
        <Text className="text-[12px] font-medium text-foreground/90 leading-snug">
          Project host not running.
        </Text>
        <Text className="text-[11px] text-muted-foreground mt-1 leading-snug">
          Start the host to see worktrees, agents, and services.
        </Text>
      </View>
    );
  }

  if (endpoint && desktopState === null && desktopStateError) {
    const copy = projectStateErrorCopy(desktopStateError);
    return (
      <View className="mx-3 mt-3 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3">
        <Text className="text-[12px] font-medium text-foreground/90 leading-snug">
          {copy.title}
        </Text>
        <Text className="text-[11px] text-muted-foreground mt-1 leading-snug">{copy.detail}</Text>
      </View>
    );
  }

  if (endpoint && desktopState === null) {
    return (
      <View className="px-4 py-4">
        <Text className="text-xs text-muted-foreground">Loading project state...</Text>
      </View>
    );
  }

  if (groups.length === 0) {
    return (
      <View className="px-4 py-4">
        <Text className="text-xs text-muted-foreground">No worktrees yet</Text>
      </View>
    );
  }

  return (
    <View className="pt-3 pb-3">
      {groups.map((bucket) => (
        <WorktreeGroup
          key={bucket.key}
          bucket={bucket}
          endpoint={endpoint}
          token={token}
          selectedSessionId={selectedSessionId}
          onPickSession={onPickSession}
          onPickService={onPickService}
        />
      ))}
    </View>
  );
}

// ─── Desktop primary nav ─────────────────────────────────────────────────

const PRIMARY_NAV = [
  { id: "project", label: "Project", Icon: FolderKanban },
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
    <View className="border-b border-border px-3 py-3">
      <View className="flex-row overflow-hidden rounded-lg border border-border">
        {(["dashboard", "views"] as const).map((tab) => {
          const active = mode === tab;
          const label = tab === "dashboard" ? "Dashboard" : "Views";
          return (
            <Pressable
              key={tab}
              onPress={() => onChange(tab)}
              className={cn(
                "flex-1 items-center px-3 py-2 active:bg-accent/70",
                active ? "bg-accent" : "bg-background",
              )}
            >
              <Text
                className={cn(
                  "text-[12px] font-semibold",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function SidebarPrimaryNav() {
  const pathname = usePathname();
  const navigateTab = useMainTabNavigation();
  const activeTab = mainTabForPath(pathname);

  return (
    <View className="px-3 py-3">
      {PRIMARY_NAV.map(({ id, label, Icon }) => {
        const tabId = id as MainTabId;
        const active = activeTab === tabId;
        return (
          <Pressable
            key={id}
            onPress={() => navigateTab(tabId)}
            className={cn(
              "mb-0.5 flex-row items-center rounded-md px-2 py-2 active:bg-accent/60",
              active && "bg-accent",
            )}
          >
            <Icon size={15} color={active ? "#fafafa" : "#a1a1aa"} />
            <Text
              className={cn(
                "ml-2 text-[13px] font-medium",
                active ? "text-foreground" : "text-muted-foreground",
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

  const desktopState = useAtomValue(desktopStateFamily(effectiveProjectPath ?? EMPTY_PROJECT_PATH));
  const desktopStateError = useAtomValue(
    desktopStateErrorFamily(effectiveProjectPath ?? EMPTY_PROJECT_PATH),
  );
  const pickerMode = !effectiveProject || showPicker;

  function handlePickProject(path: string) {
    selectProject(path);
    setShowPicker(false);
    const tabId = mainTabForPath(pathname);
    router.replace(
      buildViewHref(MAIN_TAB_ROUTES[tabId].href, mergeViewParams(searchParams, { project: path })),
    );
  }

  function handlePickSession(sessionId: string) {
    setSelectedSession(sessionId);
    router.push(detailHrefForPath(pathname, "agent", sessionId, effectiveProjectPath));
  }

  function handlePickService(serviceId: string) {
    router.push(detailHrefForPath(pathname, "service", serviceId, effectiveProjectPath));
  }

  return (
    <View
      className="border-r border-border bg-background"
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
                  <SidebarPrimaryNav />
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
              />
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
