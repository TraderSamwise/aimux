import React, { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { AgentCreatePanel } from "@/components/agent-create-panel";
import { AgentActions } from "@/components/agent-actions";
import { PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { ServiceActions } from "@/components/service-actions";
import { WorktreeManagementPanel } from "@/components/worktree-management-panel";
import { StatusDotMini } from "@/components/status-dot";
import { useAuth } from "@/lib/auth";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopService, DesktopSession, WorktreeBucket } from "@/lib/desktop-state";
import { firstTokenOf } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { useRouteProject } from "@/lib/use-route-project";
import { detailHrefForPath, parentViewHrefForPath } from "@/lib/view-location";
import {
  desktopStateErrorFamily,
  desktopStateFamily,
  worktreeGroupsFamily,
} from "@/stores/desktopState";
import { selectedSessionIdAtom } from "@/stores/projects";
import { projectStateErrorCopy } from "@/lib/project-connection-display";

// TUI-styled worktree dashboard: each worktree is a contained, tinted card
// (left accent bar = aggregate state) with a header row (square glyph · name ·
// branch · count chips) and agent/service rows beneath. Mirrors the terminal
// dashboard's card/dot/[n]/pill language. Palette: card #15161a · border
// #26272d · hairline #202127 · text #edeef0 / muted #7c7e88 / faint #565862.
const PRESS = "hover:bg-[#1f2025] active:bg-[#232733]";

function worktreeHasChildren(bucket: WorktreeBucket): boolean {
  return bucket.sessions.length > 0 || bucket.services.length > 0;
}

// "Active" = the agent/service is live in tmux (anything but offline/exited).
// Used to focus the sidebar on live worktrees; the full dashboard always shows
// everything, including stopped agents.
function isLiveStatus(status: string): boolean {
  return status !== "offline" && status !== "exited";
}

function worktreeIsActive(bucket: WorktreeBucket): boolean {
  return [...bucket.sessions, ...bucket.services].some((entry) => isLiveStatus(entry.status));
}

function cap(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

type StateKind =
  | "running"
  | "waiting"
  | "idle"
  | "offline"
  | "exited"
  | "error"
  | "needs"
  | "blocked";

interface AgentState {
  label: string;
  kind: StateKind;
  pill: boolean;
}

// Precedence mirrors the TUI: a transient pending action (stopping/forking/…)
// shows first, then attention signals that need the user, then the runtime
// status. Pill states read as active; the rest are quiet words.
function deriveAgentState(session: DesktopSession): AgentState {
  if (session.pendingAction)
    return { label: cap(session.pendingAction), kind: "waiting", pill: false };
  switch (session.attention) {
    case "error":
      return { label: "Error", kind: "error", pill: true };
    case "blocked":
      return { label: "Blocked", kind: "blocked", pill: true };
    case "needs_input":
      return { label: "Needs input", kind: "needs", pill: true };
    case "needs_response":
      return { label: "Needs reply", kind: "needs", pill: true };
  }
  if (session.status === "running") return { label: "Running", kind: "running", pill: true };
  if (session.status === "waiting") return { label: "Waiting", kind: "waiting", pill: true };
  if (session.status === "idle") return { label: "Idle", kind: "idle", pill: false };
  if (session.status === "exited") return { label: "Exited", kind: "exited", pill: false };
  return { label: "Offline", kind: "offline", pill: false };
}

// Split bg/text so the background class lands only on the View and the text
// color only on the Text — on native a Text background composites over the
// parent's, which would darken the pill under the label.
const PILL_BG: Record<StateKind, string> = {
  running: "bg-emerald-500/15",
  waiting: "bg-amber-500/15",
  needs: "bg-amber-500/15",
  error: "bg-red-500/15",
  blocked: "bg-fuchsia-500/15",
  idle: "bg-zinc-500/15",
  offline: "bg-zinc-500/10",
  exited: "bg-red-500/10",
};

const WORD_CLASS: Record<StateKind, string> = {
  running: "text-emerald-400",
  waiting: "text-amber-400",
  needs: "text-amber-400",
  error: "text-red-400",
  blocked: "text-fuchsia-300",
  idle: "text-[#7c7e88]",
  offline: "text-[#7c7e88]",
  exited: "text-red-400/80",
};

function StatusCell({ state }: { state: AgentState }) {
  if (state.pill) {
    return (
      <View className={cn("rounded-[5px] px-2 py-0.5", PILL_BG[state.kind])}>
        <Text
          className={cn("text-[10.5px] font-bold uppercase tracking-wide", WORD_CLASS[state.kind])}
        >
          {state.label}
        </Text>
      </View>
    );
  }
  return (
    <Text className={cn("font-mono text-[12px]", WORD_CLASS[state.kind])} numberOfLines={1}>
      {state.label}
    </Text>
  );
}

function IndexBadge({ digit }: { digit: number }) {
  return <Text className="w-7 shrink-0 font-mono text-[12px] text-[#7c7e88]">{`[${digit}]`}</Text>;
}

function SelectMark({ selected }: { selected: boolean }) {
  return (
    <Text className="w-3 shrink-0 text-center text-[13px] text-[#e0b341]">
      {selected ? "▸" : ""}
    </Text>
  );
}

function TrailingHint({ text }: { text?: string }) {
  if (!text) return <View className="min-w-0 flex-1" />;
  return (
    <Text
      className="min-w-0 flex-1 font-mono text-[12px] text-[#565862]"
      numberOfLines={1}
      ellipsizeMode="tail"
    >
      {`· ${text}`}
    </Text>
  );
}

function AgentRow({
  session,
  digit,
  selected,
  compact,
  endpoint,
  token,
  mainCheckoutPath,
  onKilled,
  onPress,
}: {
  session: DesktopSession;
  digit: number;
  selected: boolean;
  compact?: boolean;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  mainCheckoutPath?: string | null;
  onKilled: (sessionId: string) => void;
  onPress: () => void;
}) {
  const tool = firstTokenOf(session.command);
  const state = deriveAgentState(session);
  const identity = (
    <>
      <SelectMark selected={selected} />
      <View className="w-4 items-center justify-center">
        <StatusDotMini status={session.status} />
      </View>
      <IndexBadge digit={digit} />
      <View
        className={cn(
          "min-w-0 flex-row items-baseline gap-2",
          compact ? "flex-1" : "max-w-[55%] shrink",
        )}
      >
        <Text
          className="min-w-0 shrink text-[14px] font-medium text-[#edeef0]"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {session.label || session.id}
        </Text>
        {session.role || tool ? (
          <Text
            className={cn("shrink-0 font-mono text-[12px] text-[#7c7e88]", compact && "ml-auto")}
            numberOfLines={1}
          >
            {session.role ?? tool}
          </Text>
        ) : null}
      </View>
      {compact ? null : (
        <TrailingHint text={session.headline || session.previewLine || undefined} />
      )}
    </>
  );

  // Compact (sidebar nav): identity only — status + management actions live on
  // the full-width dashboard, where there's room.
  if (compact) {
    return (
      <Pressable
        onPress={onPress}
        className={cn(
          "flex-row items-center gap-2 rounded-md px-2.5 py-2",
          selected ? "bg-[#232733]" : PRESS,
        )}
      >
        {identity}
      </Pressable>
    );
  }

  return (
    <View
      className={cn(
        "flex-row items-center gap-2 rounded-md px-2.5 py-2",
        selected ? "bg-[#232733]" : PRESS,
      )}
    >
      <Pressable
        onPress={onPress}
        className="min-w-0 flex-1 flex-row items-center gap-2 active:opacity-70"
      >
        {identity}
      </Pressable>
      <View className="shrink-0 flex-row items-center gap-3 pl-2">
        <StatusCell state={state} />
        <AgentActions
          session={session}
          endpoint={endpoint}
          token={token}
          compact
          mainCheckoutPath={mainCheckoutPath}
          onKilled={() => onKilled(session.id)}
        />
      </View>
    </View>
  );
}

function ServiceRow({
  service,
  digit,
  compact,
  endpoint,
  token,
  onPress,
}: {
  service: DesktopService;
  digit: number;
  compact?: boolean;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  onPress: () => void;
}) {
  const detail = service.shellCommand ?? service.previewLine ?? service.command ?? "";
  const word =
    service.status === "running"
      ? "text-emerald-400"
      : service.status === "exited"
        ? "text-red-400/80"
        : "text-[#7c7e88]";
  const identity = (
    <>
      <SelectMark selected={false} />
      <View className="w-4 items-center justify-center">
        <StatusDotMini status={service.status} shape="diamond" />
      </View>
      <IndexBadge digit={digit} />
      <View
        className={cn(
          "min-w-0 flex-row items-baseline gap-2",
          compact ? "flex-1" : "max-w-[55%] shrink",
        )}
      >
        <Text className="min-w-0 shrink text-[14px] font-medium text-[#edeef0]" numberOfLines={1}>
          {service.label || service.id}
        </Text>
        <Text
          className={cn(
            "shrink-0 font-mono text-[10px] uppercase tracking-wide text-[#7c7e88]",
            compact && "ml-auto",
          )}
        >
          svc
        </Text>
      </View>
      {compact ? null : <TrailingHint text={detail || undefined} />}
    </>
  );

  if (compact) {
    return (
      <Pressable
        onPress={onPress}
        className="flex-row items-center gap-2 rounded-md px-2.5 py-2 hover:bg-[#1f2025] active:opacity-70"
      >
        {identity}
      </Pressable>
    );
  }

  return (
    <View className="flex-row items-center gap-2 rounded-md px-2.5 py-2 hover:bg-[#1f2025]">
      <Pressable
        onPress={onPress}
        className="min-w-0 flex-1 flex-row items-center gap-2 active:opacity-70"
      >
        {identity}
      </Pressable>
      <View className="shrink-0 flex-row items-center gap-3 pl-2">
        <Text className={cn("font-mono text-[12px]", word)} numberOfLines={1}>
          {service.pendingAction ?? service.status}
        </Text>
        <ServiceActions service={service} endpoint={endpoint} token={token} compact />
      </View>
    </View>
  );
}

interface CountChip {
  label: string;
  active: boolean;
}

function worktreeCountChips(bucket: WorktreeBucket): CountChip[] {
  let running = 0;
  let waiting = 0;
  let idle = 0;
  let offline = 0;
  for (const session of bucket.sessions) {
    if (session.status === "running") running++;
    else if (session.status === "waiting") waiting++;
    else if (session.status === "idle") idle++;
    else offline++; // offline + exited
  }
  for (const service of bucket.services) {
    if (service.status === "running") running++;
    else offline++;
  }
  const chips: CountChip[] = [];
  if (running > 0) chips.push({ label: `${running} running`, active: true });
  if (waiting > 0) chips.push({ label: `${waiting} waiting`, active: true });
  if (idle > 0) chips.push({ label: `${idle} idle`, active: false });
  if (offline > 0) chips.push({ label: `${offline} offline`, active: false });
  return chips;
}

function WorktreeCard({
  bucket,
  endpoint,
  token,
  selectedSessionId,
  compact,
  onPickSession,
  onPickService,
  onKillSession,
}: {
  bucket: WorktreeBucket;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  selectedSessionId: string | null;
  compact?: boolean;
  onPickSession: (sessionId: string) => void;
  onPickService: (serviceId: string) => void;
  onKillSession: (sessionId: string) => void;
}) {
  const anyRunning = [...bucket.sessions, ...bucket.services].some((x) => x.status === "running");
  const containsSelected = bucket.sessions.some((s) => s.id === selectedSessionId);
  const barColor = containsSelected ? "#e0b341" : anyRunning ? "#3f9c6d" : "#26272d";
  const chips = worktreeCountChips(bucket);

  return (
    <View
      className={cn(
        "overflow-hidden rounded-xl",
        compact ? "mb-2" : "mb-3",
        containsSelected ? "bg-[#181a1f]" : "bg-[#15161a]",
      )}
      style={{
        borderWidth: 1,
        borderColor: containsSelected ? "#3a3c44" : "#26272d",
        borderLeftWidth: 3,
        borderLeftColor: barColor,
      }}
    >
      <View
        className={cn("flex-row items-center gap-2.5", compact ? "px-3 py-2" : "px-3.5 py-2.5")}
      >
        <StatusDotMini
          status={anyRunning ? "running" : undefined}
          hollow={!anyRunning}
          shape="square"
          outline
        />
        <Text
          className={cn(
            "shrink-0 text-[13.5px] font-bold",
            containsSelected ? "text-[#e0b341]" : "text-[#edeef0]",
          )}
          numberOfLines={1}
        >
          {bucket.name}
        </Text>
        {bucket.branch ? (
          <Text
            className="min-w-0 shrink font-mono text-[12.5px] text-[#7c7e88]"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {`· ${bucket.branch}`}
          </Text>
        ) : null}
        <View className="ml-auto shrink-0 flex-row items-center gap-1.5 pl-3">
          {chips.map((chip) => (
            <View
              key={chip.label}
              className={cn(
                "rounded-[5px] px-2 py-0.5",
                chip.active ? "bg-emerald-500/10" : "bg-[#202127]",
              )}
            >
              <Text
                className={cn(
                  "font-mono text-[11px]",
                  chip.active ? "text-emerald-400" : "text-[#7c7e88]",
                )}
              >
                {chip.label}
              </Text>
            </View>
          ))}
        </View>
      </View>

      {worktreeHasChildren(bucket) ? (
        <View className="border-t border-[#202127] p-1">
          {bucket.sessions.map((session, i) => (
            <AgentRow
              key={session.id}
              session={session}
              digit={i + 1}
              selected={session.id === selectedSessionId}
              compact={compact}
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
              compact={compact}
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

export function WorktreeList({
  groups,
  endpoint,
  token,
  padded,
  compact,
  activeOnly,
  selectedSessionId,
  onPickSession,
  onPickService,
  onKillSession,
}: {
  groups: WorktreeBucket[];
  endpoint: ServiceEndpoint | null;
  token: string | null;
  padded: boolean;
  compact?: boolean;
  activeOnly?: boolean;
  selectedSessionId: string | null;
  onPickSession: (sessionId: string) => void;
  onPickService: (serviceId: string) => void;
  onKillSession: (sessionId: string) => void;
}) {
  const [showEmpty, setShowEmpty] = useState(false);

  const shown = activeOnly ? groups.filter(worktreeIsActive) : groups;
  const main = shown.find((g) => g.isMainCheckout);
  const rest = shown.filter((g) => !g.isMainCheckout);
  const activeRest = rest.filter(worktreeHasChildren);
  const emptyRest = rest.filter((g) => !worktreeHasChildren(g));

  if (activeOnly && shown.length === 0) {
    return (
      <View className={cn("py-3", padded && "px-4")}>
        <Text className="px-2 font-mono text-[13px] text-[#7c7e88]">No active agents</Text>
      </View>
    );
  }

  const cardProps = {
    endpoint,
    token,
    selectedSessionId,
    compact,
    onPickSession,
    onPickService,
    onKillSession,
  };

  return (
    <View className={cn("py-3", padded && "px-4")}>
      {main ? <WorktreeCard bucket={main} {...cardProps} /> : null}
      {activeRest.map((bucket) => (
        <WorktreeCard key={bucket.key} bucket={bucket} {...cardProps} />
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
            className={cn("flex-row items-center gap-2 rounded-md px-2.5 py-2.5", PRESS)}
          >
            <Text className="w-3 text-center font-mono text-[11px] text-[#565862]">
              {showEmpty ? "▾" : "▸"}
            </Text>
            <Text className="font-mono text-[13px] text-[#7c7e88]">
              <Text className="font-bold text-[#a6a8b0]">{emptyRest.length}</Text> empty worktree
              {emptyRest.length > 1 ? "s" : ""}
            </Text>
          </Pressable>
          {showEmpty
            ? emptyRest.map((bucket) => (
                <WorktreeCard key={bucket.key} bucket={bucket} {...cardProps} />
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
  const { projectPath, endpoint } = useRouteProject();
  const stateProjectPath = projectPath ?? "";
  const desktopState = useAtomValue(desktopStateFamily(stateProjectPath));
  const desktopStateError = useAtomValue(desktopStateErrorFamily(stateProjectPath));
  const groups = useAtomValue(worktreeGroupsFamily(stateProjectPath));
  const selectedSessionId = useAtomValue(selectedSessionIdAtom);
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
    router.push(detailHrefForPath(pathname, "agent", sessionId, projectPath));
  }

  function handlePickService(serviceId: string) {
    router.push(detailHrefForPath(pathname, "service", serviceId, projectPath));
  }

  function handleKillSession(sessionId: string) {
    if (selectedSessionId !== sessionId) return;
    selectSession(null);
    if (pathname.includes("/agent/")) {
      router.replace(parentViewHrefForPath(pathname, projectPath));
    }
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
    <View className={cn(padded && "px-4")}>
      <WorktreeManagementPanel endpoint={endpoint} token={token} groups={groups} />
      <AgentCreatePanel endpoint={endpoint} token={token} groups={groups} />
      <WorktreeList
        groups={groups}
        endpoint={endpoint}
        token={token}
        padded={false}
        selectedSessionId={selectedSessionId}
        onPickSession={handlePickSession}
        onPickService={handlePickService}
        onKillSession={handleKillSession}
      />
    </View>
  );
}
