import React, { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Page, PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { ServiceActions } from "@/components/service-actions";
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

// Restyle palette — Linear/Cloudflare-style lifted dark slate. Mirrors
// docs/mockups/project-view.html. Surfaces: page #191a1f, group header #1f2025,
// row press #232429, hairline border #2a2b31. Status accent is a single green.
const ROW_BORDER = "border-[#2a2b31]";
const PRESS = "active:bg-[#232429]";

// ─── Status primitives ──────────────────────────────────────────────────────

function StatusDotMini({ status, hollow }: { status?: string; hollow?: boolean }) {
  if (hollow) {
    return <View className="h-[7px] w-[7px] rounded-full border-[1.5px] border-[#44464e]" />;
  }
  const bg =
    status === "running" ? "bg-[#4ade80]" : status === "waiting" ? "bg-amber-400" : "bg-[#5b5d66]";
  return <View className={cn("h-[7px] w-[7px] rounded-full", bg)} />;
}

function StatusWord({ status }: { status: string }) {
  const tone =
    status === "running"
      ? "text-[#4ade80]"
      : status === "waiting"
        ? "text-amber-400"
        : "text-[#787a83]";
  return (
    <Text className={cn("min-w-[54px] text-right font-mono text-[12px]", tone)} numberOfLines={1}>
      {status}
    </Text>
  );
}

// ─── Agent row ──────────────────────────────────────────────────────────────

function AgentRow({ session, onPress }: { session: DesktopSession; onPress: () => void }) {
  const tool = firstTokenOf(session.command);
  return (
    <Pressable
      onPress={onPress}
      className={cn("h-[42px] flex-row items-center border-b pl-10 pr-5", ROW_BORDER, PRESS)}
    >
      <View className="min-w-0 flex-1 flex-row items-center gap-[11px]">
        <StatusDotMini status={session.status} />
        <Text
          className="min-w-0 shrink text-[13.5px] font-medium text-[#edeef0]"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {session.label || session.id}
        </Text>
        {tool ? (
          <Text
            className="min-w-0 shrink font-mono text-[12px] text-[#787a83]"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {tool}
          </Text>
        ) : null}
      </View>
      <View className="flex-row items-center gap-4 pl-3">
        <StatusWord status={session.status} />
      </View>
    </Pressable>
  );
}

// ─── Service row ────────────────────────────────────────────────────────────

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
    <View className={cn("h-[42px] flex-row items-center border-b pl-10 pr-5", ROW_BORDER)}>
      <Pressable
        onPress={onPress}
        className="min-w-0 flex-1 flex-row items-center gap-[11px] active:opacity-70"
      >
        <StatusDotMini status={service.status} />
        <Text
          className="min-w-0 shrink text-[13.5px] font-medium text-[#edeef0]"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {service.label || service.id}
        </Text>
        {detail ? (
          <Text
            className="min-w-0 shrink font-mono text-[12px] text-[#787a83]"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {detail}
          </Text>
        ) : null}
      </Pressable>
      <View className="flex-row items-center gap-4 pl-3">
        <StatusWord status={service.status} />
        <ServiceActions service={service} endpoint={endpoint} token={token} compact />
      </View>
    </View>
  );
}

// ─── Worktree group (collapsible header + rows) ───────────────────────────────

function WorktreeGroup({
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
  const [collapsed, setCollapsed] = useState(false);

  const anyRunning = [...bucket.sessions, ...bucket.services].some((x) => x.status === "running");
  const countParts: string[] = [];
  if (hasAgents) {
    countParts.push(`${bucket.sessions.length} agent${bucket.sessions.length > 1 ? "s" : ""}`);
  }
  if (hasServices) {
    countParts.push(`${bucket.services.length} service${bucket.services.length > 1 ? "s" : ""}`);
  }
  const countLabel = isEmpty ? "empty" : countParts.join(" · ");

  const headerInner = (
    <>
      {isEmpty ? (
        <ChevronRight size={12} color="#5b5d66" />
      ) : collapsed ? (
        <ChevronRight size={12} color="#787a83" />
      ) : (
        <ChevronDown size={12} color="#787a83" />
      )}
      <StatusDotMini status={anyRunning ? "running" : undefined} hollow={isEmpty} />
      <Text
        className={cn(
          "shrink-0 text-[13.5px]",
          isEmpty ? "font-semibold text-[#a6a8b0]" : "font-bold text-[#edeef0]",
        )}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {bucket.name}
      </Text>
      {bucket.branch ? (
        <Text
          className="min-w-0 shrink font-mono text-[11.5px] text-[#787a83]"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {bucket.branch}
        </Text>
      ) : null}
      <Text className="ml-auto pl-3 text-[12px] text-[#787a83]" numberOfLines={1}>
        {countLabel}
      </Text>
    </>
  );

  const headerClass = cn(
    "h-[38px] flex-row items-center gap-[10px] border-b bg-[#1f2025] px-5",
    ROW_BORDER,
  );

  return (
    <View>
      {isEmpty ? (
        <View className={headerClass}>{headerInner}</View>
      ) : (
        <Pressable onPress={() => setCollapsed((c) => !c)} className={cn(headerClass, PRESS)}>
          {headerInner}
        </Pressable>
      )}
      {!isEmpty && !collapsed ? (
        <View>
          {bucket.sessions.map((session) => (
            <AgentRow
              key={session.id}
              session={session}
              onPress={() => onPickSession(session.id)}
            />
          ))}
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
    </View>
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
    <Page className="bg-[#191a1f]" contentClassName="p-0">
      {!project ? (
        <View className="p-5">
          <PageStateCard
            title="No project selected"
            body="Select a project from the sidebar to begin."
          />
        </View>
      ) : (
        <>
          {/* Page header */}
          <View className={cn("flex-row items-center gap-3 border-b px-5 py-4", ROW_BORDER)}>
            <Text
              className="min-w-0 shrink text-[20px] font-bold text-[#edeef0]"
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {project.name}
            </Text>
            {endpoint ? (
              <View className="ml-auto flex-row items-center gap-[7px]">
                <StatusDotMini status="running" />
                <Text className="font-mono text-[11.5px] text-[#a6a8b0]">{endpointLabel}</Text>
              </View>
            ) : (
              <View className="ml-auto flex-row items-center gap-[7px]">
                <StatusDotMini hollow />
                <Text className="font-mono text-[11.5px] text-[#787a83]">host offline</Text>
              </View>
            )}
          </View>

          {!endpoint && desktopState === null ? (
            <View className="p-5">
              <PageStateCard
                title="Project host not running"
                body="Start the host to see worktrees, agents, and services for this project."
              />
            </View>
          ) : endpoint && desktopState === null && desktopStateError ? (
            <View className="p-5">
              {(() => {
                const copy = projectStateErrorCopy(desktopStateError);
                return <PageStateCard title={copy.title} body={copy.detail} tone="warning" />;
              })()}
            </View>
          ) : endpoint && desktopState === null ? (
            <View className="p-5">
              <PageStateCard title="Loading project state..." />
            </View>
          ) : groups.length === 0 ? (
            <View className="p-5">
              <PageStateCard title="No worktrees yet" body="Worktrees will appear here." />
            </View>
          ) : (
            groups.map((bucket) => (
              <WorktreeGroup
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
