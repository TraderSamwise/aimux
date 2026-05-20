import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronLeft, Settings } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { ServiceActions } from "@/components/service-actions";
import { useAuth } from "@/lib/auth";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopService, DesktopSession, WorktreeBucket } from "@/lib/desktop-state";
import { AGENT_STATUS_TONE, SERVICE_STATUS_TONE, firstTokenOf } from "@/lib/status-tone";
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
    <>
      <View className="px-4 pt-6 pb-2">
        <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
              className={cn("px-4 py-2", isSelected ? "bg-accent" : "active:bg-accent/50")}
            >
              <Text
                className={cn(
                  "text-sm",
                  isSelected ? "text-accent-foreground font-medium" : "text-foreground",
                )}
              >
                {project.name}
              </Text>
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {project.path}
              </Text>
            </Pressable>
          );
        })
      )}
    </>
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
    <View className="flex-row items-center px-4 pt-6 pb-3 border-b border-border">
      <Pressable
        onPress={onSwitchProject}
        accessibilityLabel="Switch project"
        className="p-1 rounded mr-2 active:bg-accent/50"
      >
        <ChevronLeft size={16} color="#9ca3af" />
      </Pressable>
      <View className="flex-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {project.name}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {project.path}
        </Text>
      </View>
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
  const tone = AGENT_STATUS_TONE[session.status] ?? "text-zinc-400";
  const tool = firstTokenOf(session.command);
  return (
    <Pressable
      onPress={onPress}
      className={cn("px-4 py-2 pl-8", isSelected ? "bg-accent" : "active:bg-accent/50")}
    >
      <View className="flex-row items-center gap-2">
        <Text className={cn("text-xs", tone)}>●</Text>
        <Text
          className={cn(
            "text-sm flex-1",
            isSelected ? "font-medium text-accent-foreground" : "text-foreground",
          )}
          numberOfLines={1}
        >
          {session.label || session.id}
        </Text>
      </View>
      <Text className="text-xs text-muted-foreground ml-4" numberOfLines={1}>
        {tool ? `${tool} · ${session.status}` : session.status}
      </Text>
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
  const tone = SERVICE_STATUS_TONE[service.status] ?? "text-zinc-400";
  const detail = service.shellCommand ?? service.previewLine ?? service.command ?? "";

  return (
    <View className="px-4 py-2 pl-8">
      <View className="flex-row items-center gap-2">
        <Pressable onPress={onPress} className="flex-1 flex-row items-center gap-2">
          <Text className={cn("text-xs", tone)}>●</Text>
          <Text className="text-sm flex-1 text-foreground" numberOfLines={1}>
            {service.label || service.id}
          </Text>
        </Pressable>
        <ServiceActions service={service} endpoint={endpoint} token={token} iconSize={14} />
      </View>
      <Pressable onPress={onPress}>
        <Text className="text-xs text-muted-foreground ml-4" numberOfLines={1}>
          {detail ? `${detail} · ${service.status}` : service.status}
        </Text>
      </Pressable>
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
  return (
    <View>
      <View className="px-4 pt-4 pb-1">
        <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {bucket.name}
          {bucket.branch ? (
            <Text className="text-xs text-muted-foreground"> · {bucket.branch}</Text>
          ) : null}
        </Text>
      </View>

      <View className="px-4 pt-2 pb-1">
        <Text className="text-[10px] uppercase tracking-wider text-muted-foreground">Agents</Text>
      </View>
      {bucket.sessions.length === 0 ? (
        <View className="px-4 py-1 pl-8">
          <Text className="text-xs text-muted-foreground">(none)</Text>
        </View>
      ) : (
        bucket.sessions.map((session) => (
          <AgentRow
            key={session.id}
            session={session}
            isSelected={session.id === selectedSessionId}
            onPress={() => onPickSession(session.id)}
          />
        ))
      )}

      <View className="px-4 pt-2 pb-1">
        <Text className="text-[10px] uppercase tracking-wider text-muted-foreground">Services</Text>
      </View>
      {bucket.services.length === 0 ? (
        <View className="px-4 py-1 pl-8">
          <Text className="text-xs text-muted-foreground">(none)</Text>
        </View>
      ) : (
        bucket.services.map((service) => (
          <ServiceRow
            key={service.id}
            service={service}
            endpoint={endpoint}
            token={token}
            onPress={() => onPickService(service.id)}
          />
        ))
      )}
    </View>
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
      <View className="px-4 py-3">
        <Text className="text-sm text-muted-foreground">
          Project host not running. Start the project host to see worktrees and agents.
        </Text>
      </View>
    );
  }

  if (groups.length === 0) {
    return (
      <View className="px-4 py-3">
        <Text className="text-sm text-muted-foreground">No worktrees yet</Text>
      </View>
    );
  }

  return (
    <>
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
    </>
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
    <View className="w-72 border-r border-border bg-background">
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
      <Pressable
        onPress={() => router.push("/(main)/settings")}
        className="flex-row items-center gap-2 px-4 py-3 border-t border-border active:bg-accent/50"
      >
        <Settings size={16} color="#9ca3af" />
        <Text className="text-sm text-foreground">Settings</Text>
      </Pressable>
    </View>
  );
}
