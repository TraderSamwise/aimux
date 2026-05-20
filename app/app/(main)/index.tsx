import React, { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Text } from "@/components/ui/text";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { ServiceActions } from "@/components/service-actions";
import { useAuth } from "@/lib/auth";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopService, DesktopSession, WorktreeBucket } from "@/lib/desktop-state";
import { AGENT_STATUS_TONE, SERVICE_STATUS_TONE, firstTokenOf } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { desktopStateFamily, worktreeGroupsFamily } from "@/stores/desktopState";
import {
  selectedProjectAtom,
  selectedProjectEndpointAtom,
  selectedSessionIdAtom,
} from "@/stores/projects";

// ─── Agent card ───────────────────────────────────────────────────────────

function AgentCard({ session, onPress }: { session: DesktopSession; onPress: () => void }) {
  const tone = AGENT_STATUS_TONE[session.status] ?? "text-zinc-400";
  const tool = firstTokenOf(session.command);
  return (
    <Pressable
      onPress={onPress}
      className="rounded-lg border border-border bg-card p-3 mb-2 active:bg-accent"
    >
      <View className="flex-row items-center gap-2">
        <Text className={cn("text-xs", tone)}>●</Text>
        <Text className="text-base font-medium text-foreground flex-1" numberOfLines={1}>
          {session.label || session.id}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {tool ? `${tool} · ${session.status}` : session.status}
        </Text>
      </View>
      {session.headline ? (
        <Text className="text-sm text-foreground mt-1" numberOfLines={2}>
          {session.headline}
        </Text>
      ) : null}
      {session.worktreePath ? (
        <Text className="text-xs text-muted-foreground mt-1" numberOfLines={1}>
          {session.worktreePath}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ─── Service card ─────────────────────────────────────────────────────────

function ServiceCard({
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
    <View className="rounded-lg border border-border bg-card p-3 mb-2">
      <View className="flex-row items-center gap-2">
        <Pressable onPress={onPress} className="flex-1 flex-row items-center gap-2">
          <Text className={cn("text-xs", tone)}>●</Text>
          <Text className="text-base font-medium text-foreground flex-1" numberOfLines={1}>
            {service.label || service.id}
          </Text>
          <Text className="text-xs text-muted-foreground">{service.status}</Text>
        </Pressable>
        <ServiceActions service={service} endpoint={endpoint} token={token} iconSize={16} />
      </View>
      {detail ? (
        <Pressable onPress={onPress}>
          <Text className="text-sm text-foreground mt-1" numberOfLines={2}>
            {detail}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ─── Worktree section ─────────────────────────────────────────────────────

function WorktreeSection({
  bucket,
  endpoint,
  token,
  onPickSession,
  onPickService,
}: {
  bucket: WorktreeBucket;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  onPickSession: (sessionId: string) => void;
  onPickService: (serviceId: string) => void;
}) {
  const isEmpty = bucket.sessions.length === 0 && bucket.services.length === 0;
  return (
    <View className="mb-6">
      <View className="mb-2">
        <Text className="text-sm font-semibold text-foreground">{bucket.name}</Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {[bucket.branch, bucket.path].filter(Boolean).join(" · ")}
        </Text>
      </View>

      {isEmpty ? (
        <Text className="text-xs text-muted-foreground italic">no agents · no services</Text>
      ) : (
        <>
          {bucket.sessions.length > 0 ? (
            <>
              <Text className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 mt-2">
                Agents
              </Text>
              {bucket.sessions.map((session) => (
                <AgentCard
                  key={session.id}
                  session={session}
                  onPress={() => onPickSession(session.id)}
                />
              ))}
            </>
          ) : null}

          {bucket.services.length > 0 ? (
            <>
              <Text className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 mt-2">
                Services
              </Text>
              {bucket.services.map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  endpoint={endpoint}
                  token={token}
                  onPress={() => onPickService(service.id)}
                />
              ))}
            </>
          ) : null}
        </>
      )}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────

export default function DashboardIndex() {
  const project = useAtomValue(selectedProjectAtom);
  const endpoint = useAtomValue(selectedProjectEndpointAtom);
  const desktopState = useAtomValue(desktopStateFamily(project?.path ?? ""));
  const groups = useAtomValue(worktreeGroupsFamily(project?.path ?? ""));
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const router = useRouter();

  // Auth token for inline service actions.
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

  function handlePickSession(sessionId: string) {
    selectSession(sessionId);
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
    <View className="flex-1 bg-background">
      {Platform.OS !== "web" ? <ProjectSidebar /> : null}
      <ScrollView className="flex-1 p-6">
        {!project ? (
          <Text className="text-sm text-muted-foreground">
            Select a project from the sidebar to begin.
          </Text>
        ) : (
          <>
            <Text className="text-2xl font-bold text-foreground mb-1">{project.name}</Text>
            <Text className="text-sm text-muted-foreground mb-4" numberOfLines={1}>
              {project.path}
              {endpoint ? ` · ${endpoint.host}:${endpoint.port}` : " · host not running"}
            </Text>

            {!endpoint && desktopState === null ? (
              <Text className="text-sm text-muted-foreground">
                Project host not running. Start the project host to see worktrees and agents.
              </Text>
            ) : groups.length === 0 ? (
              <Text className="text-sm text-muted-foreground">No worktrees yet</Text>
            ) : (
              groups.map((bucket) => (
                <WorktreeSection
                  key={bucket.key}
                  bucket={bucket}
                  endpoint={endpoint}
                  token={token}
                  onPickSession={handlePickSession}
                  onPickService={handlePickService}
                />
              ))
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
