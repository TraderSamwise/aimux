import React, { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { GitBranch } from "lucide-react-native";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Card, PressableCard } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { ServiceActions } from "@/components/service-actions";
import { StatusDot, StatusPill } from "@/components/status-dot";
import { useAuth } from "@/lib/auth";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopService, DesktopSession, WorktreeBucket } from "@/lib/desktop-state";
import { firstTokenOf } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { detailHrefForPath } from "@/lib/view-location";
import {
  desktopStateErrorFamily,
  desktopStateFamily,
  worktreeGroupsFamily,
} from "@/stores/desktopState";
import {
  selectedProjectAtom,
  selectedProjectEndpointAtom,
  selectedSessionIdAtom,
} from "@/stores/projects";
import { env } from "@/lib/env";
import {
  formatProjectEndpointLabel,
  projectStateErrorCopy,
} from "@/lib/project-connection-display";

// ─── Agent card ───────────────────────────────────────────────────────────

function AgentCard({ session, onPress }: { session: DesktopSession; onPress: () => void }) {
  const tool = firstTokenOf(session.command);
  const metaParts = [tool, session.headline].filter(Boolean) as string[];
  const meta = metaParts.join(" · ");
  return (
    <PressableCard onPress={onPress} className="mb-1 rounded-lg bg-secondary px-2.5 py-1.5 border-border">
      <View className="flex-row items-center">
        <View className="mr-3">
          <StatusDot status={session.status} size="md" />
        </View>
        <Text
          className="min-w-0 flex-1 text-[14px] font-semibold text-foreground"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {session.label || session.id}
        </Text>
        <View className="ml-3">
          <StatusPill status={session.status} />
        </View>
      </View>
      {meta ? (
        <Text
          className="ml-[26px] text-[11px] leading-tight text-muted-foreground"
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {meta}
        </Text>
      ) : null}
    </PressableCard>
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
    <Card className="mb-1 rounded-lg bg-secondary px-2.5 py-1.5 border-border">
      <View className="flex-row items-center">
        <Pressable
          onPress={onPress}
          className="flex-1 flex-row items-center min-w-0 active:opacity-70"
        >
          <View className="mr-3">
            <StatusDot status={service.status} size="md" />
          </View>
          <Text
            className="min-w-0 flex-1 text-[14px] font-semibold text-foreground"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {service.label || service.id}
          </Text>
        </Pressable>
        <View className="ml-3">
          <StatusPill status={service.status} />
        </View>
        <View className="ml-2.5">
          <ServiceActions service={service} endpoint={endpoint} token={token} />
        </View>
      </View>
      {detail ? (
        <Pressable onPress={onPress}>
          <Text
            className="ml-[26px] font-mono text-[11px] leading-tight text-muted-foreground"
            numberOfLines={2}
            ellipsizeMode="tail"
          >
            {detail}
          </Text>
        </Pressable>
      ) : null}
    </Card>
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
    <Card className="mb-3 overflow-hidden p-0">
      {/* Worktree header */}
      <View className="flex-row items-stretch border-b border-border bg-card">
        <View className={cn("w-1.5", accent)} />
        <View className="min-w-0 flex-1 px-3 py-1.5">
          <Text
            className="text-[16px] font-bold text-foreground"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {bucket.name}
          </Text>
          {bucket.branch ? (
            <View className="mt-0.5 flex-row items-center">
              <View className="max-w-full flex-row items-center rounded border border-border bg-background px-2 py-0">
                <GitBranch size={11} color="#a1a1aa" />
                <Text
                  className="text-[11px] font-mono text-muted-foreground ml-1.5"
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {bucket.branch}
                </Text>
              </View>
            </View>
          ) : null}
          {bucket.path ? (
            <Text
              className="mt-0.5 text-[10px] text-muted-foreground/70"
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {bucket.path}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Body */}
      <View className="px-2.5 pb-2 pt-2.5">
        {isEmpty ? (
          <Text className="py-1 text-[11px] italic text-muted-foreground">
            no agents · no services
          </Text>
        ) : (
          <>
            {hasAgents ? (
              <View className={cn(hasServices && "mb-2.5")}>
                <Text className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
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
                <Text className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
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
    </Card>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────

export default function DashboardIndex() {
  const project = useAtomValue(selectedProjectAtom);
  const endpoint = useAtomValue(selectedProjectEndpointAtom);
  const desktopState = useAtomValue(desktopStateFamily(project?.path ?? ""));
  const desktopStateError = useAtomValue(desktopStateErrorFamily(project?.path ?? ""));
  const groups = useAtomValue(worktreeGroupsFamily(project?.path ?? ""));
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const router = useRouter();
  const pathname = usePathname();

  // Auth token for inline service actions.
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

  function handlePickSession(sessionId: string) {
    selectSession(sessionId);
    router.push(detailHrefForPath(pathname, "agent", sessionId, project?.path));
  }

  function handlePickService(serviceId: string) {
    router.push(detailHrefForPath(pathname, "service", serviceId, project?.path));
  }

  const endpointLabel = formatProjectEndpointLabel(endpoint, env.AIMUX_CONNECTION_MODE);

  return (
    <Page width="narrow" contentClassName="px-4 py-5 md:px-8 md:py-7">
      {!project ? (
        <PageStateCard
          title="No project selected"
          body="Select a project from the sidebar to begin."
        />
      ) : (
        <>
          <PageHeader
            eyebrow="Project"
            title={project.name}
            subtitle={project.path}
            className="mb-8"
            actions={
              endpoint ? (
                <View className="rounded border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5">
                  <Text className="font-mono text-[10px] text-emerald-400">{endpointLabel}</Text>
                </View>
              ) : (
                <View className="rounded border border-zinc-500/30 bg-zinc-500/15 px-2 py-0.5">
                  <Text className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                    host offline
                  </Text>
                </View>
              )
            }
          />

          {!endpoint && desktopState === null ? (
            <PageStateCard
              title="Project host not running"
              body="Start the host to see worktrees, agents, and services for this project."
            />
          ) : endpoint && desktopState === null && desktopStateError ? (
            (() => {
              const copy = projectStateErrorCopy(desktopStateError);
              return <PageStateCard title={copy.title} body={copy.detail} tone="warning" />;
            })()
          ) : endpoint && desktopState === null ? (
            <PageStateCard title="Loading project state..." />
          ) : groups.length === 0 ? (
            <PageStateCard title="No worktrees yet" body="Worktrees will appear here." />
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
    </Page>
  );
}
