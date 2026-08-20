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
import { agentRoleLabel, agentShortName } from "@/lib/agent-display";
import { useAuth } from "@/lib/auth";
import { blurWebActiveElement } from "@/lib/blur-web-active-element";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopService, DesktopSession, WorktreeBucket } from "@/lib/desktop-state";
import { filterWorktreeBucketToActiveEntries } from "@/lib/desktop-state";
import {
  agentStatusKind,
  appStatusClasses,
  serviceStatusKind,
  type AppStatusKind,
} from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { useRouteProject } from "@/lib/use-route-project";
import { detailHrefForPath, parentViewHrefForPath } from "@/lib/view-location";
import { worktreeToneForBucket } from "@/lib/worktree-tone";
import {
  desktopStateErrorFamily,
  desktopStateFamily,
  worktreeGroupsFamily,
} from "@/stores/desktopState";
import { selectedSessionIdAtom } from "@/stores/projects";
import { PairDeviceDialog } from "@/components/PairDeviceDialog";
import {
  isDevicePendingApprovalError,
  projectStateErrorCopy,
} from "@/lib/project-connection-display";

// TUI-styled worktree dashboard: each worktree is a contained, tinted card
// (left accent bar = aggregate state) with a header row (square glyph · name ·
// branch · count chips) and agent/service rows beneath. Mirrors the terminal
// dashboard's card/dot/[n]/pill language. Palette: card #15161a · border
// #26272d · hairline #202127 · text #edeef0 / muted #7c7e88 / faint #565862.
const PRESS = "hover:bg-[#1f2025] active:bg-[#232733]";

function worktreeHasChildren(bucket: WorktreeBucket): boolean {
  return bucket.sessions.length > 0 || bucket.services.length > 0;
}

function cap(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

interface AgentState {
  label: string;
  kind: AppStatusKind;
  pill: boolean;
}

// Precedence mirrors the TUI: a transient pending action (stopping/forking/…)
// shows first, then attention signals that need the user, then the runtime
// status. Pill states read as active; the rest are quiet words.
function deriveAgentState(session: DesktopSession): AgentState {
  if (session.pendingAction)
    return { label: cap(session.pendingAction), kind: agentStatusKind(session), pill: false };
  if (session.status === "offline") return { label: "Offline", kind: "offline", pill: false };
  if (session.status === "exited") return { label: "Exited", kind: "offline", pill: false };
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
  const kind = agentStatusKind(session);
  if (session.status === "running") return { label: "Running", kind, pill: true };
  if (session.status === "waiting") return { label: "Waiting", kind, pill: true };
  if (session.status === "idle") return { label: "Idle", kind: "idle", pill: false };
  if (session.status === "exited") return { label: "Exited", kind, pill: false };
  return { label: "Offline", kind: "offline", pill: false };
}

function StatusCell({ state }: { state: AgentState }) {
  const tone = appStatusClasses(state.kind);
  if (state.pill) {
    return (
      <View className={cn("rounded-[5px] px-2 py-0.5", tone.bg)}>
        <Text
          className={cn("text-[10.5px] font-bold uppercase tracking-wide", tone.text)}
          style={{ color: tone.hex }}
        >
          {state.label}
        </Text>
      </View>
    );
  }
  return (
    <Text
      className={cn("font-mono text-[12px]", tone.text)}
      style={{ color: tone.hex }}
      numberOfLines={1}
    >
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
  projectPath,
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
  projectPath: string;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  mainCheckoutPath?: string | null;
  onKilled: (sessionId: string) => void;
  onPress: () => void;
}) {
  const shortName = agentShortName(session);
  const role = agentRoleLabel(session);
  const state = deriveAgentState(session);
  const identity = (
    <>
      <SelectMark selected={selected} />
      <View className="w-4 shrink-0 items-center justify-center">
        <StatusDotMini status={state.kind} />
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
          {shortName}
        </Text>
        {role ? (
          <Text
            className={cn("shrink-0 font-mono text-[12px] text-[#7c7e88]", compact && "ml-auto")}
            numberOfLines={1}
          >
            {role}
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
          projectPath={projectPath}
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
  projectPath,
  endpoint,
  token,
  onPress,
}: {
  service: DesktopService;
  digit: number;
  compact?: boolean;
  projectPath: string;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  onPress: () => void;
}) {
  const detail = service.shellCommand ?? service.previewLine ?? service.command ?? "";
  const stateKind = serviceStatusKind(service);
  const tone = appStatusClasses(stateKind);
  const identity = (
    <>
      <SelectMark selected={false} />
      <View className="w-4 shrink-0 items-center justify-center">
        <StatusDotMini status={stateKind} shape="diamond" />
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
        <Text
          className={cn("font-mono text-[12px]", tone.text)}
          style={{ color: tone.hex }}
          numberOfLines={1}
        >
          {service.pendingAction ?? service.status}
        </Text>
        <ServiceActions
          service={service}
          projectPath={projectPath}
          endpoint={endpoint}
          token={token}
          compact
        />
      </View>
    </View>
  );
}

interface CountChip {
  label: string;
  kind: AppStatusKind;
}

function worktreeCountChips(bucket: WorktreeBucket): CountChip[] {
  let working = 0;
  let needs = 0;
  let blocked = 0;
  let error = 0;
  let ready = 0;
  let done = 0;
  let idle = 0;
  let offline = 0;
  for (const session of bucket.sessions) {
    const kind = agentStatusKind(session);
    if (kind === "working") working++;
    else if (kind === "needs") needs++;
    else if (kind === "blocked") blocked++;
    else if (kind === "error") error++;
    else if (kind === "ready") ready++;
    else if (kind === "done") done++;
    else if (kind === "idle") idle++;
    else offline++;
  }
  for (const service of bucket.services) {
    const kind = serviceStatusKind(service);
    if (kind === "service") working++;
    else offline++;
  }
  const chips: CountChip[] = [];
  if (error > 0) chips.push({ label: `${error} error`, kind: "error" });
  if (needs > 0) chips.push({ label: `${needs} needs`, kind: "needs" });
  if (blocked > 0) chips.push({ label: `${blocked} blocked`, kind: "blocked" });
  if (working > 0) chips.push({ label: `${working} running`, kind: "working" });
  if (ready > 0) chips.push({ label: `${ready} ready`, kind: "ready" });
  if (done > 0) chips.push({ label: `${done} done`, kind: "done" });
  if (idle > 0) chips.push({ label: `${idle} idle`, kind: "idle" });
  if (offline > 0) chips.push({ label: `${offline} offline`, kind: "offline" });
  if (bucket.pending) chips.push({ label: "pending", kind: "needs" });
  if (bucket.removing) chips.push({ label: "removing", kind: "needs" });
  return chips;
}

function WorktreeCard({
  bucket,
  projectPath,
  endpoint,
  token,
  selectedSessionId,
  compact,
  onPickSession,
  onPickService,
  onKillSession,
  identityTone,
}: {
  bucket: WorktreeBucket;
  projectPath: string;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  selectedSessionId: string | null;
  compact?: boolean;
  identityTone: string;
  onPickSession: (sessionId: string) => void;
  onPickService: (serviceId: string) => void;
  onKillSession: (sessionId: string) => void;
}) {
  const containsSelected = bucket.sessions.some((s) => s.id === selectedSessionId);
  const barColor = identityTone;
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
        <StatusDotMini color={identityTone} hollow={false} shape="square" outline />
        <Text
          className="shrink-0 text-[13.5px] font-bold"
          style={{ color: identityTone }}
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
          {chips.map((chip) => {
            const chipTone = appStatusClasses(chip.kind);
            return (
              <View key={chip.label} className={cn("rounded-[5px] px-2 py-0.5", chipTone.bg)}>
                <Text
                  className={cn("font-mono text-[11px]", chipTone.text)}
                  style={{ color: chipTone.hex }}
                >
                  {chip.label}
                </Text>
              </View>
            );
          })}
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
              projectPath={projectPath}
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
              projectPath={projectPath}
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
  projectPath,
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
  projectPath: string;
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

  const shown = activeOnly
    ? groups.flatMap((bucket) => {
        const activeBucket = filterWorktreeBucketToActiveEntries(bucket);
        return activeBucket ? [activeBucket] : [];
      })
    : groups;
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
    projectPath,
    endpoint,
    token,
    selectedSessionId,
    compact,
    onPickSession,
    onPickService,
    onKillSession,
  };
  const identityToneForBucket = (bucket: WorktreeBucket) =>
    worktreeToneForBucket(bucket, projectPath);

  return (
    <View className={cn("py-3", padded && "px-4")}>
      {main ? (
        <WorktreeCard bucket={main} identityTone={identityToneForBucket(main)} {...cardProps} />
      ) : null}
      {activeRest.map((bucket) => (
        <WorktreeCard
          key={bucket.key}
          bucket={bucket}
          identityTone={identityToneForBucket(bucket)}
          {...cardProps}
        />
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
                <WorktreeCard
                  key={bucket.key}
                  bucket={bucket}
                  identityTone={identityToneForBucket(bucket)}
                  {...cardProps}
                />
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
    blurWebActiveElement();
    selectSession(sessionId);
    router.push(detailHrefForPath(pathname, "agent", sessionId, projectPath));
  }

  function handlePickService(serviceId: string) {
    blurWebActiveElement();
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
    // Pairing is the operator's next move, not an error to read: the dialog
    // carries the code and clears itself, so no wall goes up behind it.
    if (isDevicePendingApprovalError(desktopStateError)) {
      return (
        <View className={statePad}>
          <PageStateCard title="Waiting for this device to be approved…" />
          <PairDeviceDialog />
        </View>
      );
    }
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
      <WorktreeManagementPanel
        projectPath={stateProjectPath}
        endpoint={endpoint}
        token={token}
        groups={groups}
      />
      <AgentCreatePanel
        projectPath={stateProjectPath}
        endpoint={endpoint}
        token={token}
        groups={groups}
      />
      <WorktreeList
        groups={groups}
        projectPath={stateProjectPath}
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
