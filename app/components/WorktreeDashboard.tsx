import React, { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { ServiceActions } from "@/components/service-actions";
import { BranchChip, StatusDotMini, TypeTag } from "@/components/status-dot";
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
import { projectStateErrorCopy } from "@/lib/project-connection-display";

// Linear-style worktree dashboard: worktrees as collapsible group headers
// (square outline = worktree) with agents (circle) / services (diamond) as
// guide-lined child rows. Rendered as the Project screen's "Dashboard"
// section; kept route-agnostic via `padded`. Child guide line #3a3c44.
const PRESS = "active:bg-[#232429]";

function worktreeHasChildren(bucket: WorktreeBucket): boolean {
  return bucket.sessions.length > 0 || bucket.services.length > 0;
}

function StatusWord({ status }: { status: string }) {
  const tone =
    status === "running"
      ? "text-[#4ade80]"
      : status === "waiting"
        ? "text-amber-400"
        : "text-[#787a83]";
  return (
    <Text className={cn("min-w-[62px] text-right font-mono text-[13px]", tone)} numberOfLines={1}>
      {status}
    </Text>
  );
}

function AgentRow({ session, onPress }: { session: DesktopSession; onPress: () => void }) {
  const tool = firstTokenOf(session.command);
  return (
    <Pressable
      onPress={onPress}
      className={cn("flex-row items-center rounded-md py-3 pl-4 pr-4", PRESS)}
    >
      <View className="min-w-0 flex-1 flex-row items-center gap-3">
        <StatusDotMini status={session.status} />
        <Text
          className="min-w-0 shrink text-[15px] font-medium text-[#edeef0]"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {session.label || session.id}
        </Text>
        {tool ? (
          <Text
            className="min-w-0 shrink font-mono text-[13px] text-[#787a83]"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {tool}
          </Text>
        ) : null}
      </View>
      <View className="flex-row items-center gap-5 pl-4">
        <StatusWord status={session.status} />
      </View>
    </Pressable>
  );
}

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
    <View className="flex-row items-center rounded-md py-3 pl-4 pr-4">
      <Pressable
        onPress={onPress}
        className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-70"
      >
        <StatusDotMini status={service.status} shape="diamond" />
        <Text
          className="min-w-0 shrink text-[15px] font-medium text-[#edeef0]"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {service.label || service.id}
        </Text>
        <TypeTag label="service" />
        {detail ? (
          <Text
            className="min-w-0 shrink font-mono text-[13px] text-[#787a83]"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {detail}
          </Text>
        ) : null}
      </Pressable>
      <View className="flex-row items-center gap-5 pl-4">
        <StatusWord status={service.status} />
        <ServiceActions service={service} endpoint={endpoint} token={token} compact />
      </View>
    </View>
  );
}

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
  const hasChildren = worktreeHasChildren(bucket);
  const isEmpty = !hasChildren;
  const [collapsed, setCollapsed] = useState(false);

  const anyRunning = [...bucket.sessions, ...bucket.services].some((x) => x.status === "running");
  const countParts: string[] = [];
  if (bucket.sessions.length > 0) {
    countParts.push(`${bucket.sessions.length} agent${bucket.sessions.length > 1 ? "s" : ""}`);
  }
  if (bucket.services.length > 0) {
    countParts.push(`${bucket.services.length} service${bucket.services.length > 1 ? "s" : ""}`);
  }
  const countLabel = isEmpty ? "empty" : countParts.join(" · ");

  const headerInner = (
    <>
      {hasChildren ? (
        collapsed ? (
          <ChevronRight size={14} color="#5b5d66" />
        ) : (
          <ChevronDown size={14} color="#5b5d66" />
        )
      ) : (
        <View className="w-[14px]" />
      )}
      <StatusDotMini
        status={anyRunning ? "running" : undefined}
        hollow={isEmpty}
        shape="square"
        outline
      />
      <Text
        className={cn(
          "shrink-0 text-[15px]",
          isEmpty ? "font-semibold text-[#a6a8b0]" : "font-bold text-[#edeef0]",
        )}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {bucket.name}
      </Text>
      {bucket.branch ? <BranchChip branch={bucket.branch} /> : null}
      <Text className="ml-auto pl-4 text-[13px] text-[#787a83]" numberOfLines={1}>
        {countLabel}
      </Text>
    </>
  );

  const headerClass = "flex-row items-center gap-3 rounded-md px-3 py-3";

  return (
    <View>
      {hasChildren ? (
        <Pressable onPress={() => setCollapsed((c) => !c)} className={cn(headerClass, PRESS)}>
          {headerInner}
        </Pressable>
      ) : (
        <View className={headerClass}>{headerInner}</View>
      )}
      {hasChildren && !collapsed ? (
        <View className="ml-[22px] border-l-2 border-[#3a3c44]">
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

function WorktreeList({
  groups,
  endpoint,
  token,
  padded,
  onPickSession,
  onPickService,
}: {
  groups: WorktreeBucket[];
  endpoint: ServiceEndpoint | null;
  token: string | null;
  padded: boolean;
  onPickSession: (sessionId: string) => void;
  onPickService: (serviceId: string) => void;
}) {
  const [showEmpty, setShowEmpty] = useState(false);

  const main = groups.find((g) => g.isMainCheckout);
  const rest = groups.filter((g) => !g.isMainCheckout);
  const activeRest = rest.filter(worktreeHasChildren);
  const emptyRest = rest.filter((g) => !worktreeHasChildren(g));

  const groupProps = { endpoint, token, onPickSession, onPickService };

  return (
    <View className={cn("py-3", padded && "px-4")}>
      {main ? <WorktreeGroup bucket={main} {...groupProps} /> : null}
      {activeRest.map((bucket) => (
        <WorktreeGroup key={bucket.key} bucket={bucket} {...groupProps} />
      ))}

      {emptyRest.length > 0 ? (
        <View className="mt-1">
          <Pressable
            onPress={() => setShowEmpty((s) => !s)}
            accessibilityRole="button"
            accessibilityState={{ expanded: showEmpty }}
            accessibilityLabel={`${showEmpty ? "Hide" : "Show"} ${emptyRest.length} empty worktree${
              emptyRest.length > 1 ? "s" : ""
            }`}
            className={cn("flex-row items-center gap-3 rounded-md px-3 py-3", PRESS)}
          >
            {showEmpty ? (
              <ChevronDown size={14} color="#5b5d66" />
            ) : (
              <ChevronRight size={14} color="#5b5d66" />
            )}
            <Text className="text-[14px] text-[#787a83]">
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

// Self-contained worktree dashboard (state handling + list). `padded` adds the
// horizontal page padding for full-bleed callers; embedded callers (the Project
// screen) pass false to align with their own page padding.
export function WorktreeDashboard({ padded = true }: { padded?: boolean }) {
  const project = useAtomValue(selectedProjectAtom);
  const endpoint = useAtomValue(selectedProjectEndpointAtom);
  const desktopState = useAtomValue(desktopStateFamily(project?.path ?? ""));
  const desktopStateError = useAtomValue(desktopStateErrorFamily(project?.path ?? ""));
  const groups = useAtomValue(worktreeGroupsFamily(project?.path ?? ""));
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const router = useRouter();
  const pathname = usePathname();

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

  const statePad = padded ? "p-6" : "py-6";

  if (!endpoint && desktopState === null) {
    return (
      <View className={statePad}>
        <PageStateCard
          title="Project host not running"
          body="Start the host to see worktrees, agents, and services for this project."
        />
      </View>
    );
  }
  if (endpoint && desktopState === null && desktopStateError) {
    const copy = projectStateErrorCopy(desktopStateError);
    return (
      <View className={statePad}>
        <PageStateCard title={copy.title} body={copy.detail} tone="warning" />
      </View>
    );
  }
  if (endpoint && desktopState === null) {
    return (
      <View className={statePad}>
        <PageStateCard title="Loading project state..." />
      </View>
    );
  }
  if (groups.length === 0) {
    return (
      <View className={statePad}>
        <PageStateCard title="No worktrees yet" body="Worktrees will appear here." />
      </View>
    );
  }

  return (
    <WorktreeList
      groups={groups}
      endpoint={endpoint}
      token={token}
      padded={padded}
      onPickSession={handlePickSession}
      onPickService={handlePickService}
    />
  );
}
