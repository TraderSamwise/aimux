import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Bell,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  MessageSquare,
  Network,
} from "lucide-react-native";
import { AgentActions } from "@/components/agent-actions";
import { Text } from "@/components/ui/text";
import { ServiceActions } from "@/components/service-actions";
import { StatusDotMini, TypeTag } from "@/components/status-dot";
import { useAuth } from "@/lib/auth";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type {
  DesktopService,
  DesktopSession,
  DesktopState,
  WorktreeBucket,
} from "@/lib/desktop-state";
import { mainTabForPath, useMainTabNavigation, type MainTabId } from "@/lib/main-tabs";
import {
  buildViewHref,
  detailHrefForPath,
  parentViewHrefForPath,
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

function worktreeHasChildren(bucket: WorktreeBucket): boolean {
  return bucket.sessions.length > 0 || bucket.services.length > 0;
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

// ─── Agent / service child rows ──────────────────────────────────────────────

function IndexBadge({ digit }: { digit: number }) {
  return <Text className="w-6 shrink-0 font-mono text-[11px] text-[#787a83]">{`[${digit}]`}</Text>;
}

function AgentRow({
  session,
  digit,
  isSelected,
  endpoint,
  token,
  mainCheckoutPath,
  onKilled,
  onPress,
}: {
  session: DesktopSession;
  digit: number;
  isSelected: boolean;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  mainCheckoutPath?: string | null;
  onKilled: (sessionId: string) => void;
  onPress: () => void;
}) {
  const tool = firstTokenOf(session.command);
  return (
    <View
      className={cn(
        "min-h-[40px] flex-row items-center gap-2 rounded-md pl-2.5 pr-2",
        isSelected ? "bg-[#232733]" : "hover:bg-[#232429] active:bg-[#26272d]",
      )}
    >
      <Pressable
        onPress={onPress}
        className="min-w-0 flex-1 flex-row items-center gap-2 active:opacity-70"
      >
        <StatusDotMini status={session.status} />
        <IndexBadge digit={digit} />
        <Text
          className="min-w-0 shrink text-[14px] font-medium text-[#edeef0]"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {session.label || session.id}
        </Text>
        {session.role || tool ? (
          <Text className="ml-auto shrink-0 font-mono text-[12px] text-[#787a83]" numberOfLines={1}>
            {session.role ?? tool}
          </Text>
        ) : null}
      </Pressable>
      <AgentActions
        session={session}
        endpoint={endpoint}
        token={token}
        compact
        mainCheckoutPath={mainCheckoutPath}
        onKilled={() => onKilled(session.id)}
      />
    </View>
  );
}

function ServiceRow({
  service,
  digit,
  endpoint,
  token,
  onPress,
}: {
  service: DesktopService;
  digit: number;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  onPress: () => void;
}) {
  return (
    <View className="min-h-[40px] flex-row items-center gap-2 rounded-md pl-2.5 pr-2 hover:bg-[#232429]">
      <Pressable
        onPress={onPress}
        className="min-w-0 flex-1 flex-row items-center gap-2 active:opacity-70"
      >
        <StatusDotMini status={service.status} shape="diamond" />
        <IndexBadge digit={digit} />
        <Text
          className="min-w-0 shrink text-[14px] font-medium text-[#edeef0]"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {service.label || service.id}
        </Text>
        <TypeTag label="service" />
      </Pressable>
      <ServiceActions service={service} endpoint={endpoint} token={token} compact />
    </View>
  );
}

// ─── Worktree group (collapsible header + child rows) ─────────────────────────

function WorktreeGroup({
  bucket,
  endpoint,
  token,
  selectedSessionId,
  onPickSession,
  onPickService,
  onKillSession,
}: {
  bucket: WorktreeBucket;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  selectedSessionId: string | null;
  onPickSession: (sessionId: string) => void;
  onPickService: (serviceId: string) => void;
  onKillSession: (sessionId: string) => void;
}) {
  const hasChildren = worktreeHasChildren(bucket);
  const [collapsed, setCollapsed] = useState(false);
  const runningCount = [...bucket.sessions, ...bucket.services].filter(
    (x) => x.status === "running",
  ).length;
  const anyRunning = runningCount > 0;
  const bright = hasChildren || bucket.isMainCheckout;

  const header = (
    <>
      {hasChildren ? (
        collapsed ? (
          <ChevronRight size={13} color="#5b5d66" />
        ) : (
          <ChevronDown size={13} color="#5b5d66" />
        )
      ) : (
        <View className="w-[13px]" />
      )}
      <StatusDotMini
        status={anyRunning ? "running" : undefined}
        hollow={!hasChildren}
        shape="square"
        outline
      />
      <Text
        className={cn(
          "shrink-0 text-[14px] font-semibold",
          bright ? "text-[#edeef0]" : "font-medium text-[#a6a8b0]",
        )}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {bucket.name}
      </Text>
      {bucket.branch ? (
        <Text
          className="min-w-0 shrink font-mono text-[12px] text-[#787a83]"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {`· ${bucket.branch}`}
        </Text>
      ) : null}
      {runningCount > 0 ? (
        <Text className="ml-auto shrink-0 pl-1.5 font-mono text-[11px] text-emerald-400">
          {`${runningCount} running`}
        </Text>
      ) : null}
    </>
  );

  const headerClass = "flex-row items-center gap-2.5 rounded-md px-2.5 py-2.5";

  return (
    <View>
      {hasChildren ? (
        <Pressable
          onPress={() => setCollapsed((c) => !c)}
          className={cn(headerClass, "hover:bg-[#232429] active:bg-[#26272d]")}
        >
          {header}
        </Pressable>
      ) : (
        <View className={headerClass}>{header}</View>
      )}
      {hasChildren && !collapsed ? (
        <View className="ml-[20px] border-l border-[#2e3038] pl-0.5">
          {bucket.sessions.map((session, i) => (
            <AgentRow
              key={session.id}
              session={session}
              digit={i + 1}
              isSelected={session.id === selectedSessionId}
              endpoint={endpoint}
              token={token}
              mainCheckoutPath={bucket.isMainCheckout ? session.worktreePath : undefined}
              onKilled={onKillSession}
              onPress={() => onPickSession(session.id)}
            />
          ))}
          {bucket.services.map((service, i) => (
            <ServiceRow
              key={service.id}
              service={service}
              digit={bucket.sessions.length + i + 1}
              endpoint={endpoint}
              token={token}
              onPress={() => onPickService(service.id)}
            />
          ))}
        </View>
      ) : null}
    </View>
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
  const [showEmpty, setShowEmpty] = useState(false);

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

  // Main checkout stays pinned/visible; remaining worktrees split into active
  // (have agents/services) and empty (collapsed behind a disclosure).
  const main = groups.find((g) => g.isMainCheckout);
  const rest = groups.filter((g) => !g.isMainCheckout);
  const activeRest = rest.filter(worktreeHasChildren);
  const emptyRest = rest.filter((g) => !worktreeHasChildren(g));

  const groupProps = {
    endpoint,
    token,
    selectedSessionId,
    onPickSession,
    onPickService,
    onKillSession,
  };

  return (
    <View className="p-2">
      {main ? <WorktreeGroup bucket={main} {...groupProps} /> : null}
      {activeRest.map((bucket) => (
        <WorktreeGroup key={bucket.key} bucket={bucket} {...groupProps} />
      ))}

      {emptyRest.length > 0 ? (
        <View className="mt-0.5">
          <Pressable
            onPress={() => setShowEmpty((s) => !s)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showEmpty }}
            accessibilityLabel={`${showEmpty ? "Hide" : "Show"} ${emptyRest.length} empty worktree${
              emptyRest.length > 1 ? "s" : ""
            }`}
            className="flex-row items-center gap-2.5 rounded-md px-2.5 py-2.5 hover:bg-[#232429] active:bg-[#26272d]"
          >
            {showEmpty ? (
              <ChevronDown size={13} color="#5b5d66" />
            ) : (
              <ChevronRight size={13} color="#5b5d66" />
            )}
            <Text className="text-[13px] text-[#787a83]">
              <Text className="font-bold text-[#a6a8b0]">{emptyRest.length}</Text> empty worktree
              {emptyRest.length > 1 ? "s" : ""}
            </Text>
          </Pressable>
          {showEmpty
            ? emptyRest.map((bucket) => (
                <WorktreeGroup key={bucket.key} bucket={bucket} {...groupProps} />
              ))
            : null}
        </View>
      ) : null}
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

function SidebarPrimaryNav() {
  const pathname = usePathname();
  const navigateTab = useMainTabNavigation();
  const activeTab = mainTabForPath(pathname);

  return (
    <View className="p-1.5">
      {PRIMARY_NAV.map(({ id, label, Icon }) => {
        const tabId = id as MainTabId;
        const active = activeTab === tabId;
        return (
          <Pressable
            key={id}
            onPress={() => navigateTab(tabId)}
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
    // Selecting a project always lands on the Project screen's Dashboard section.
    router.replace(buildViewHref("/project", { project: path }));
  }

  function handlePickSession(sessionId: string) {
    setSelectedSession(sessionId);
    router.push(detailHrefForPath(pathname, "agent", sessionId, effectiveProjectPath));
  }

  function handlePickService(serviceId: string) {
    router.push(detailHrefForPath(pathname, "service", serviceId, effectiveProjectPath));
  }

  function handleKillSession(sessionId: string) {
    if (selectedSessionId !== sessionId) return;
    setSelectedSession(null);
    if (pathname.includes("/agent/")) {
      router.replace(parentViewHrefForPath(pathname, effectiveProjectPath));
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
