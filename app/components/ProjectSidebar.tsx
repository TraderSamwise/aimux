import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronLeft, GitBranch, Home, MessageSquare, Settings } from "lucide-react-native";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { ServiceActions } from "@/components/service-actions";
import { StatusDot } from "@/components/status-dot";
import { useAuth } from "@/lib/auth";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopService, DesktopSession, WorktreeBucket } from "@/lib/desktop-state";
import { firstTokenOf } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { desktopStateFamily, worktreeGroupsFamily } from "@/stores/desktopState";
import type { DaemonProject } from "@/lib/api";
import {
  projectsAtom,
  selectedProjectAtom,
  selectedProjectEndpointAtom,
  selectedProjectPathAtom,
  selectedSessionIdAtom,
  selectProjectAtom,
} from "@/stores/projects";
import { sidebarShowProjectPickerAtom } from "@/stores/ui";

// Type ladder used throughout the sidebar:
//   - Project name / worktree name (title)      → text-[15px] font-bold
//   - Section headings (Agents, Services)       → text-[10px] uppercase tracking-widest
//   - Row primary (agent/service label)         → text-[13px] font-medium
//   - Row secondary (tool, status, detail)      → text-[11px] text-muted-foreground
//   - Path / branch chip                        → text-[11px] muted

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
              <Text
                className="text-[14px] font-semibold text-foreground"
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {project.name}
              </Text>
              <Text
                className="text-[11px] text-muted-foreground mt-0.5"
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
          Project
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
  selectedSessionId,
  onPickSession,
  onPickService,
}: {
  projectPath: string;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  selectedSessionId: string | null;
  onPickSession: (sessionId: string) => void;
  onPickService: (serviceId: string) => void;
}) {
  const groups = useAtomValue(worktreeGroupsFamily(projectPath));
  const desktopState = useAtomValue(desktopStateFamily(projectPath));

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

// ─── Bottom nav (tablet/desktop) ──────────────────────────────────────────

const BOTTOM_NAV = [
  { label: "Dashboard", route: "/" as const, Icon: Home },
  { label: "Threads", route: "/threads" as const, Icon: MessageSquare },
  { label: "Settings", route: "/settings" as const, Icon: Settings },
];

function navItemActive(pathname: string, route: string): boolean {
  if (route === "/") return pathname === "/" || pathname === "/(main)";
  return pathname.startsWith(route);
}

function SidebarBottomNav() {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <View className="flex-row border-t border-border">
      {BOTTOM_NAV.map(({ label, route, Icon }) => {
        const active = navItemActive(pathname, route);
        return (
          <Pressable
            key={route}
            onPress={() => router.push(route)}
            className="flex-1 items-center py-2.5 active:bg-accent/50"
          >
            <Icon size={15} color="#a1a1aa" />
            <Text
              className={cn(
                "mt-0.5 text-[10px]",
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

export function ProjectSidebar() {
  const projects = useAtomValue(projectsAtom);
  const selectedProject = useAtomValue(selectedProjectAtom);
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const endpoint = useAtomValue(selectedProjectEndpointAtom);
  const selectedSessionId = useAtomValue(selectedSessionIdAtom);
  const selectProject = useSetAtom(selectProjectAtom);
  const setSelectedSession = useSetAtom(selectedSessionIdAtom);
  const showPicker = useAtomValue(sidebarShowProjectPickerAtom);
  const setShowPicker = useSetAtom(sidebarShowProjectPickerAtom);
  const router = useRouter();

  // Fetch auth token once (auth context is stable in LOCAL_MODE; refetch is cheap).
  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t = await getToken();
      if (!cancelled) setToken(t);
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  // Auto-close the picker when the selected project path changes externally
  // (e.g., auto-reconcile fallback when the stored project disappears).
  useEffect(() => {
    setShowPicker(false);
  }, [selectedProjectPath, setShowPicker]);

  const pickerMode = !selectedProject || showPicker;

  function handlePickProject(path: string) {
    selectProject(path);
    setShowPicker(false);
  }

  function handlePickSession(sessionId: string) {
    setSelectedSession(sessionId);
    router.push({
      pathname: "/(main)/agent/[sessionId]/chat",
      params: { sessionId },
    });
  }

  function handlePickService(serviceId: string) {
    router.push({
      pathname: "/(main)/service/[serviceId]",
      params: { serviceId },
    });
  }

  return (
    <View className="w-80 border-r border-border bg-background">
      <ScrollView className="flex-1">
        {pickerMode ? (
          <ProjectPicker
            projects={projects}
            selectedPath={selectedProjectPath}
            onSelect={handlePickProject}
          />
        ) : (
          <>
            <ProjectHeader project={selectedProject!} onSwitchProject={() => setShowPicker(true)} />
            <WorktreeTree
              projectPath={selectedProject!.path}
              endpoint={endpoint}
              token={token}
              selectedSessionId={selectedSessionId}
              onPickSession={handlePickSession}
              onPickService={handlePickService}
            />
          </>
        )}
      </ScrollView>
      <SidebarBottomNav />
    </View>
  );
}
