import React, { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { GitBranch } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { ServiceActions } from "@/components/service-actions";
import { StatusDot, StatusPill } from "@/components/status-dot";
import { useAuth } from "@/lib/auth";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopService, DesktopSession, WorktreeBucket } from "@/lib/desktop-state";
import { firstTokenOf } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { desktopStateFamily, worktreeGroupsFamily } from "@/stores/desktopState";
import {
  selectedProjectAtom,
  selectedProjectEndpointAtom,
  selectedSessionIdAtom,
} from "@/stores/projects";

// ─── Agent card ───────────────────────────────────────────────────────────

function AgentCard({ session, onPress }: { session: DesktopSession; onPress: () => void }) {
  const tool = firstTokenOf(session.command);
  return (
    <Pressable
      onPress={onPress}
      className="rounded-md border border-border bg-secondary/40 px-3.5 py-3 mb-2 active:bg-accent/60"
    >
      <View className="flex-row items-center gap-3">
        <StatusDot status={session.status} size="md" />
        <Text
          className="text-[15px] font-semibold text-foreground flex-1 min-w-0"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {session.label || session.id}
        </Text>
        {tool ? <Text className="text-[11px] font-mono text-muted-foreground">{tool}</Text> : null}
        <StatusPill status={session.status} />
      </View>
      {session.headline ? (
        <Text
          className="text-[12px] text-foreground/80 mt-2 ml-[22px] leading-snug"
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {session.headline}
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
  const detail = service.shellCommand ?? service.previewLine ?? service.command ?? "";
  return (
    <View className="rounded-md border border-border bg-secondary/40 px-3.5 py-3 mb-2">
      <View className="flex-row items-center gap-3">
        <Pressable
          onPress={onPress}
          className="flex-1 flex-row items-center gap-3 min-w-0 active:opacity-70"
        >
          <StatusDot status={service.status} size="md" />
          <Text
            className="text-[15px] font-semibold text-foreground flex-1 min-w-0"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {service.label || service.id}
          </Text>
          <StatusPill status={service.status} />
        </Pressable>
        <ServiceActions service={service} endpoint={endpoint} token={token} iconSize={16} />
      </View>
      {detail ? (
        <Pressable onPress={onPress}>
          <Text
            className="text-[12px] text-foreground/70 mt-2 ml-[22px] font-mono leading-snug"
            numberOfLines={2}
            ellipsizeMode="tail"
          >
            {detail}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ─── Worktree section (full card) ─────────────────────────────────────────

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
  const hasAgents = bucket.sessions.length > 0;
  const hasServices = bucket.services.length > 0;
  const isEmpty = !hasAgents && !hasServices;
  const accent = bucket.isMainCheckout ? "bg-emerald-500" : "bg-sky-500";

  return (
    <View className="rounded-lg border border-border bg-card mb-6 overflow-hidden">
      {/* Worktree header */}
      <View className="flex-row items-stretch border-b border-border bg-secondary">
        <View className={cn("w-1.5", accent)} />
        <View className="flex-1 min-w-0 px-4 py-3.5">
          <Text
            className="text-[18px] font-bold text-foreground"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {bucket.name}
          </Text>
          <View className="flex-row items-center gap-2.5 mt-1.5 flex-wrap">
            {bucket.branch ? (
              <View className="flex-row items-center gap-1 px-1.5 py-0.5 rounded bg-card border border-border">
                <GitBranch size={11} color="#a1a1aa" />
                <Text
                  className="text-[11px] font-mono text-muted-foreground max-w-[200px]"
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {bucket.branch}
                </Text>
              </View>
            ) : null}
            {bucket.path ? (
              <Text
                className="text-[11px] text-muted-foreground/70 flex-1 min-w-0"
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {bucket.path}
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      {/* Body */}
      <View className="px-3.5 pt-3 pb-3">
        {isEmpty ? (
          <Text className="text-[12px] text-muted-foreground italic px-1 py-2">
            no agents · no services
          </Text>
        ) : (
          <>
            {hasAgents ? (
              <View className={cn(hasServices && "mb-4")}>
                <Text className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2 px-1">
                  Agents · {bucket.sessions.length}
                </Text>
                {bucket.sessions.map((session) => (
                  <AgentCard
                    key={session.id}
                    session={session}
                    onPress={() => onPickSession(session.id)}
                  />
                ))}
              </View>
            ) : null}

            {hasServices ? (
              <View>
                <Text className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2 px-1">
                  Services · {bucket.services.length}
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
              </View>
            ) : null}
          </>
        )}
      </View>
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
      <ScrollView className="flex-1" contentContainerClassName="px-6 py-6">
        {!project ? (
          <Text className="text-sm text-muted-foreground">
            Select a project from the sidebar to begin.
          </Text>
        ) : (
          <>
            <View className="mb-7">
              <Text className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-1">
                Project
              </Text>
              <Text
                className="text-[28px] font-bold text-foreground leading-tight"
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {project.name}
              </Text>
              <View className="flex-row items-center gap-2 mt-2">
                <Text
                  className="text-[12px] text-muted-foreground flex-1 min-w-0"
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {project.path}
                </Text>
                {endpoint ? (
                  <View className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30">
                    <Text className="text-[10px] font-mono text-emerald-400">
                      {endpoint.host}:{endpoint.port}
                    </Text>
                  </View>
                ) : (
                  <View className="px-2 py-0.5 rounded bg-zinc-500/15 border border-zinc-500/30">
                    <Text className="text-[10px] font-medium text-zinc-400 uppercase tracking-wide">
                      host offline
                    </Text>
                  </View>
                )}
              </View>
            </View>

            {!endpoint && desktopState === null ? (
              <View className="rounded-lg border border-border bg-card px-4 py-4">
                <Text className="text-[13px] text-foreground/90 leading-snug">
                  Project host not running.
                </Text>
                <Text className="text-[12px] text-muted-foreground mt-1 leading-snug">
                  Start the host to see worktrees, agents, and services for this project.
                </Text>
              </View>
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
