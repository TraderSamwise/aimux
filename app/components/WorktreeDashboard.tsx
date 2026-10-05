import React, { useCallback, useEffect, useRef, useState } from "react";
import { projectStateKey as projectStateKeyOf, type ProjectStateKey } from "@/lib/project-key";
import { Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { AgentCreatePanel } from "@/components/agent-create-panel";
import { AgentActions } from "@/components/agent-actions";
import { PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { ServiceActions } from "@/components/service-actions";
import { WorktreeManagementPanel } from "@/components/worktree-management-panel";
import { StatusDotMini } from "@/components/status-dot";
import { agentShortName } from "@/lib/agent-display";
import { useAuth } from "@/lib/auth";
import { blurWebActiveElement } from "@/lib/blur-web-active-element";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopService, DesktopSession, WorktreeBucket } from "@/lib/desktop-state";
import { filterWorktreeBucketToActiveEntries } from "@/lib/desktop-state";
import { formatServiceRecency, formatSessionRecency } from "@/lib/recency";
import {
  formatPreviewCaptureUnavailable,
  summarizeOperationFailures,
} from "@/lib/unavailable-state";
import {
  agentStatusKind,
  appStatusClasses,
  serviceStatusKind,
  type AppStatusKind,
} from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { useRecencyClock } from "@/lib/recency-clock";
import { useRouteProject } from "@/lib/use-route-project";
import { detailHrefForPath, parentViewHrefForPath } from "@/lib/view-location";
import { worktreeToneForBucket } from "@/lib/worktree-tone";
import {
  desktopStateErrorFamily,
  desktopStateOperationFailuresFamily,
  desktopStatePresentFamily,
  worktreeGroupsFamily,
} from "@/stores/desktopState";
import { selectedSessionIdAtom } from "@/stores/projects";
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
// Enough that the agent name is still a name. Below this the card scrolls
// sideways rather than crushing the one column that identifies the row.
const WORKTREE_CARD_MIN_WIDTH = 600;

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
  if (session.status === "running") return { label: "Running", kind: "working", pill: true };
  if (session.status === "waiting") return { label: "Waiting", kind: "needs", pill: true };
  if (session.status === "idle") return { label: "Idle", kind: "idle", pill: false };
  return { label: "Offline", kind: "offline", pill: false };
}

// A fixed column. The label runs from "Offline" to "NEEDS INPUT", and letting it
// size itself put every row's status and action buttons at a different x.
const STATUS_COLUMN = "w-[104px] shrink-0 flex-row items-center";

// The relative time is a column of its own, right-aligned so "55s ago" and
// "2w ago" end on the same pixel. Inside the name run it ended wherever the name
// happened to stop, which is what stopped these reading as columns at all.
const RECENCY_COLUMN = "w-[92px] shrink-0";

// "output 1w ago" in a column does not need the "ago": the column is nothing but
// elapsed time, and the four characters are the difference between a readable
// agent name and "c.".
function compactRecency(text?: string | null): string {
  if (!text) return "";
  return text.replace(/ ago$/, "").replace(/just now$/, "now");
}

function RecencyCell({ text }: { text?: string | null }) {
  return (
    <View className={RECENCY_COLUMN}>
      <Text
        className="text-right font-mono text-[12px] text-[#565862]"
        numberOfLines={1}
        ellipsizeMode="head"
      >
        {compactRecency(text)}
      </Text>
    </View>
  );
}

function StatusCell({ state }: { state: AgentState }) {
  const tone = appStatusClasses(state.kind);
  if (state.pill) {
    return (
      <View className={STATUS_COLUMN}>
        <View className={cn("rounded-[5px] px-2 py-0.5", tone.bg)}>
          <Text
            className={cn("text-[10.5px] font-bold uppercase tracking-wide", tone.text)}
            style={{ color: tone.hex }}
          >
            {state.label}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View className={STATUS_COLUMN}>
      <Text
        className={cn("font-mono text-[12px]", tone.text)}
        style={{ color: tone.hex }}
        numberOfLines={1}
      >
        {state.label}
      </Text>
    </View>
  );
}

// The count the footer chip renders as "N unread", from the same derived field.
// Rendering it here rather than recomputing it is what keeps the two surfaces
// showing one number.
function UnreadBadge({ count }: { count?: number }) {
  if (!count || count < 1) return null;
  return (
    <View className="rounded-full bg-[#e0b341] px-1.5 py-[1px]">
      <Text className="font-mono text-[10px] font-bold text-[#1a1c22]">
        {count > 99 ? "99+" : String(count)}
      </Text>
    </View>
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
  if (!text) return null;
  return (
    <Text
      className="min-w-0 shrink font-mono text-[12px] text-[#565862]"
      style={{ maxWidth: 220 }}
      numberOfLines={1}
      ellipsizeMode="tail"
    >
      {`· ${text}`}
    </Text>
  );
}

function joinHints(...parts: Array<string | null | undefined>): string | undefined {
  const text = parts.filter((part): part is string => Boolean(part)).join(" · ");
  return text || undefined;
}

function agentRecencyText(session: DesktopSession): string | null {
  return formatSessionRecency(session);
}

function serviceRecencyText(service: DesktopService): string | null {
  return formatServiceRecency(service);
}

// Services and agents share one map; the prefix keeps their ids from colliding.
function serviceRecencyKey(serviceId: string): string {
  return `service:${serviceId}`;
}

function CompactRecency({ text }: { text?: string | null }) {
  if (!text) return null;
  return (
    <Text
      className="ml-20 mt-0.5 font-mono text-[11px] text-[#565862]"
      numberOfLines={1}
      ellipsizeMode="tail"
    >
      {text}
    </Text>
  );
}

// Memoised: selecting an agent changes one highlight, and without this all 35
// rows re-rendered to move it -- 130ms on every tap that opens a chat.
export const AgentRow = React.memo(AgentRowImpl);

function AgentRowImpl({
  session,
  digit,
  selected,
  compact,
  supervisorLane,
  projectStateKey,
  endpoint,
  token,
  mainCheckoutPath,
  recencyText,
  onKilled,
  onPick,
}: {
  session: DesktopSession;
  digit: number;
  selected: boolean;
  compact?: boolean;
  supervisorLane?: boolean;
  projectStateKey: ProjectStateKey;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  mainCheckoutPath?: string | null;
  // A string, so a clock tick re-renders this row only when its own label
  // changed rather than every time the minute advances.
  recencyText?: string | null;
  onKilled: (sessionId: string) => void;
  // Takes the id rather than a bound closure, so the prop is stable per row.
  onPick: (sessionId: string) => void;
}) {
  // Plain closure, not a hook: this row only re-renders when its props change,
  // and the test harness renders these components as ordinary functions.
  const onPress = () => onPick(session.id);
  const shortName = agentShortName(session);
  const state = deriveAgentState(session);
  const recency = recencyText !== undefined ? recencyText : agentRecencyText(session);
  const previewUnavailable = formatPreviewCaptureUnavailable(session.previewCapture);
  const fullHint = joinHints(
    recency,
    previewUnavailable || session.headline || session.previewLine,
  );
  // Compact rows keep the joined string; the full row splits the time out so it
  // can hold a column.
  const detailHint = previewUnavailable || session.headline || session.previewLine || undefined;
  const identity = (
    <>
      <SelectMark selected={selected} />
      <View className="w-4 shrink-0 items-center justify-center">
        <StatusDotMini status={state.kind} />
      </View>
      <IndexBadge digit={digit} />
      {supervisorLane ? <SupervisorRoleCell session={session} /> : null}
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
        <UnreadBadge count={session.notificationUnreadCount} />
      </View>
      {compact ? null : <TrailingHint text={detailHint} />}
    </>
  );

  // Compact (sidebar nav): identity only — status + management actions live on
  // the full-width dashboard, where there's room.
  if (compact) {
    return (
      <Pressable
        onPress={onPress}
        className={cn("rounded-md px-2.5 py-2", selected ? "bg-[#232733]" : PRESS)}
      >
        <View className="flex-row items-center gap-2">{identity}</View>
        <CompactRecency text={fullHint} />
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
      <View className="shrink-0 flex-row items-center gap-3 pl-3">
        <RecencyCell text={recency} />
        <StatusCell state={state} />
        <AgentActions
          session={session}
          projectStateKey={projectStateKey}
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

function supervisorRoleLabel(session: DesktopSession): string {
  if (session.overseer === true || session.role === "overseer") return "overseer";
  if (session.scribe === true || session.role === "scribe") return "scribe";
  return "control";
}

function SupervisorRoleCell({ session }: { session: DesktopSession }) {
  return (
    <Text
      className="w-16 shrink-0 font-mono text-[11px] font-semibold uppercase text-[#d787d7]"
      numberOfLines={1}
    >
      {supervisorRoleLabel(session)}
    </Text>
  );
}

function ServiceRow({
  service,
  digit,
  compact,
  projectStateKey,
  endpoint,
  token,
  onPress,
}: {
  service: DesktopService;
  digit: number;
  compact?: boolean;
  projectStateKey: ProjectStateKey;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  onPress: () => void;
}) {
  const detail = service.shellCommand ?? service.previewLine ?? service.command ?? "";
  const stateKind = serviceStatusKind(service);
  const tone = appStatusClasses(stateKind);
  const recency = serviceRecencyText(service);
  const fullHint = joinHints(recency, detail);
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
      {compact ? null : <TrailingHint text={fullHint} />}
    </>
  );

  if (compact) {
    return (
      <Pressable
        onPress={onPress}
        className="rounded-md px-2.5 py-2 hover:bg-[#1f2025] active:opacity-70"
      >
        <View className="flex-row items-center gap-2">{identity}</View>
        <CompactRecency text={recency} />
      </Pressable>
    );
  }

  return (
    <View className="flex-row items-center gap-2 rounded-md px-2.5 py-2 hover:bg-[#1f2025]">
      <Pressable
        onPress={onPress}
        className="min-w-0 shrink flex-row items-center gap-2 active:opacity-70"
      >
        {identity}
      </Pressable>
      <View className="shrink-0 flex-row items-center gap-3 pl-3">
        <Text
          className={cn("font-mono text-[12px]", tone.text)}
          style={{ color: tone.hex }}
          numberOfLines={1}
        >
          {service.pendingAction ?? service.status}
        </Text>
        <ServiceActions
          service={service}
          projectStateKey={projectStateKey}
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
  // Counted by the action rather than rolled into "running", the way the TUI
  // lists them: an agent being stopped is in flight, but calling it running is
  // the opposite of what it is doing.
  const inFlight = new Map<string, number>();
  for (const session of bucket.sessions) {
    if (session.pendingAction) {
      inFlight.set(session.pendingAction, (inFlight.get(session.pendingAction) ?? 0) + 1);
      continue;
    }
    const kind = deriveAgentState(session).kind;
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
    if (service.pendingAction) {
      inFlight.set(service.pendingAction, (inFlight.get(service.pendingAction) ?? 0) + 1);
      continue;
    }
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
  for (const [action, count] of [...inFlight].sort(([a], [b]) => a.localeCompare(b))) {
    chips.push({ label: `${count} ${action}`, kind: "working" });
  }
  // Work in flight, not an attention chip: these sat beside "N needs" and
  // "N error" wearing the same amber.
  if (bucket.pending) chips.push({ label: "pending", kind: "working" });
  if (bucket.removing) chips.push({ label: "removing", kind: "working" });
  return chips;
}

export function WorktreeCard({
  bucket,
  projectStateKey,
  endpoint,
  token,
  selectedSessionId,
  compact,
  onPickSession,
  onPickService,
  onKillSession,
  identityTone,
  mainCheckoutPath,
  recencyById,
  contentWidth,
}: {
  bucket: WorktreeBucket;
  mainCheckoutPath?: string | null;
  // One width for every card, measured once by the list. Without it each card's
  // horizontal scroller sizes to its own widest row, so the same column lands at
  // a different x in every card -- and inside a card, a row missing its optional
  // hint loses a flex gap and sits 8px off.
  contentWidth?: number;
  // Precomputed by the list, which owns the clock these labels advance on.
  // Absent when a card is rendered on its own, and then each row computes its
  // own -- correct, just not self-updating.
  recencyById?: Record<string, string | null>;
  projectStateKey: ProjectStateKey;
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
  const content = (
    <>
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
              supervisorLane={bucket.isSupervisorLane}
              projectStateKey={projectStateKey}
              endpoint={endpoint}
              token={token}
              mainCheckoutPath={mainCheckoutPath}
              recencyText={recencyById?.[session.id]}
              onKilled={onKillSession}
              onPick={onPickSession}
            />
          ))}
          {bucket.services.map((service, i) => (
            <ServiceRow
              key={service.id}
              service={service}
              digit={bucket.sessions.length + i + 1}
              compact={compact}
              projectStateKey={projectStateKey}
              endpoint={endpoint}
              token={token}
              onPress={() => onPickService(service.id)}
            />
          ))}
        </View>
      ) : null}
    </>
  );

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
      {compact ? (
        content
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ flexGrow: 1 }}
        >
          <View
            className="flex-1"
            style={
              contentWidth
                ? { width: Math.max(contentWidth, WORKTREE_CARD_MIN_WIDTH) }
                : { minWidth: WORKTREE_CARD_MIN_WIDTH }
            }
          >
            {content}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

// The 35-row list is the expensive part of this screen, so it must not rebuild
// because something above it happened to render. Its inputs are stable now: the
// buckets keep identity across polls that did not change them, and the handlers
// below are stable for the life of the screen.
export const WorktreeList = React.memo(WorktreeListImpl);

function WorktreeListImpl({
  groups,
  projectPath,
  projectStateKey,
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
  projectStateKey: ProjectStateKey;
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
  // Measured once for the whole list and handed to every card, so one column
  // lands at one x down the entire screen.
  const [listWidth, setListWidth] = useState(0);
  // Before any early return: relative labels are computed from Date.now(), and
  // nothing else re-renders them now that the rows hold still.
  useRecencyClock();

  const shown = activeOnly
    ? groups.flatMap((bucket) => {
        const activeBucket = filterWorktreeBucketToActiveEntries(bucket);
        return activeBucket ? [activeBucket] : [];
      })
    : groups;
  const supervisor = shown.find((g) => g.isSupervisorLane);
  const main = shown.find((g) => g.isMainCheckout);
  const rest = shown.filter((g) => !g.isMainCheckout && !g.isSupervisorLane);
  const activeRest = rest.filter(worktreeHasChildren);
  const emptyRest = rest.filter((g) => !worktreeHasChildren(g));

  if (activeOnly && shown.length === 0) {
    return (
      <View className={cn("py-3", padded && "px-4")}>
        <Text className="px-2 font-mono text-[13px] text-[#7c7e88]">No active agents</Text>
      </View>
    );
  }

  // The main checkout bucket carries the project root. Rows used to be handed
  // `bucket.isMainCheckout ? session.worktreePath : undefined`, which is not a
  // main checkout path at all: every supervisor-lane row saw undefined, so an
  // agent with no worktree of its own could be moved into the plane and never
  // moved back out from the dashboard, while the chat header offered it.
  const mainCheckoutPath = groups.find((bucket) => bucket.isMainCheckout)?.path ?? null;
  // One ticker for the whole list. Relative labels are computed from Date.now(),
  // so they only advance when something re-renders them -- and the rows now hold
  // still. Computing the strings here means a minute passing re-renders only the
  // rows whose label actually changed, not all of them.
  const recencyById: Record<string, string | null> = {};
  for (const bucket of shown) {
    for (const session of bucket.sessions) recencyById[session.id] = agentRecencyText(session);
    for (const service of bucket.services) {
      recencyById[serviceRecencyKey(service.id)] = serviceRecencyText(service);
    }
  }

  const cardProps = {
    contentWidth: listWidth || undefined,
    recencyById,
    mainCheckoutPath,
    projectPath,
    projectStateKey,
    endpoint,
    token,
    selectedSessionId,
    compact,
    onPickSession,
    onPickService,
    onKillSession,
  };
  const identityToneForBucket = (bucket: WorktreeBucket) =>
    bucket.isSupervisorLane ? "#d787d7" : worktreeToneForBucket(bucket, projectPath);

  const listClassName = cn("py-3", padded && "px-4");
  const measureList = (event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    setListWidth((current) => (current === width ? current : width));
  };
  const content = (
    <>
      {supervisor ? (
        <WorktreeCard
          bucket={supervisor}
          identityTone={identityToneForBucket(supervisor)}
          {...cardProps}
        />
      ) : null}
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
    </>
  );

  if (compact) {
    return <View className={listClassName}>{content}</View>;
  }

  return (
    <View className={listClassName} onLayout={measureList}>
      {content}
    </View>
  );
}

// Self-contained worktree dashboard (state handling + list). `padded` adds the
// horizontal page padding for full-bleed callers; embedded callers (the Project
// screen) pass false to align with their own page padding.
// Memoised because its only prop is a literal, while its parent re-renders on
// every unrelated poll -- the project list, the notification feed and the task
// summary each tick independently. Without this the whole agent list rebuilt
// three times per data change.
export const WorktreeDashboard = React.memo(WorktreeDashboardImpl);

function WorktreeDashboardImpl({ padded = true }: { padded?: boolean }) {
  const { projectPath, projectRef, endpoint } = useRouteProject();
  const stateProjectPath = projectPath ?? "";
  const stateProjectKey = projectStateKeyOf(projectRef);
  // Subscribing to the whole desktop state re-rendered every row whenever any
  // field changed, including ones this view never shows.
  const desktopStatePresent = useAtomValue(desktopStatePresentFamily(stateProjectKey));
  const operationFailures = useAtomValue(desktopStateOperationFailuresFamily(stateProjectKey));
  const desktopStateError = useAtomValue(desktopStateErrorFamily(stateProjectKey));
  const groups = useAtomValue(worktreeGroupsFamily(stateProjectKey));
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

  // Read through refs rather than closing over these. As dependencies they gave
  // the handlers a new identity on every navigation and selection, which broke
  // the list's memo and re-rendered all 35 rows on the way out of the screen --
  // 155ms of the tap that opens a chat.
  const latest = useRef({ pathname, projectPath, selectedSessionId });
  useEffect(() => {
    latest.current = { pathname, projectPath, selectedSessionId };
  }, [pathname, projectPath, selectedSessionId]);

  const handlePickSession = useCallback(
    (sessionId: string) => {
      blurWebActiveElement();
      selectSession(sessionId);
      const { pathname: at, projectPath: project } = latest.current;
      router.push(detailHrefForPath(at, "agent", sessionId, project));
    },
    [router, selectSession],
  );

  const handlePickService = useCallback(
    (serviceId: string) => {
      blurWebActiveElement();
      const { pathname: at, projectPath: project } = latest.current;
      router.push(detailHrefForPath(at, "service", serviceId, project));
    },
    [router],
  );

  const handleKillSession = useCallback(
    (sessionId: string) => {
      const { pathname: at, projectPath: project, selectedSessionId: selected } = latest.current;
      if (selected !== sessionId) return;
      selectSession(null);
      if (at.includes("/agent/")) {
        router.replace(parentViewHrefForPath(at, project));
      }
    },
    [router, selectSession],
  );

  const statePad = padded ? "p-6" : "py-6";
  const operationFailureSummary = summarizeOperationFailures(operationFailures);

  if (!endpoint && !desktopStatePresent) {
    return (
      <View className={statePad}>
        <PageStateCard
          title="Project host not running"
          body="Start the host to see worktrees, agents, and services for this project."
        />
      </View>
    );
  }
  if (endpoint && !desktopStatePresent && desktopStateError) {
    // Pairing is the operator's next move, not an error to read: the dialog
    // carries the code and clears itself, so no wall goes up behind it.
    if (isDevicePendingApprovalError(desktopStateError)) {
      return (
        <View className={statePad}>
          <PageStateCard
            title="Waiting for this device to be approved..."
            body="Use the approval banner above or the code in the top bar to finish pairing."
          />
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
  if (endpoint && !desktopStatePresent) {
    return (
      <View className={statePad}>
        <PageStateCard title="Loading project state..." />
      </View>
    );
  }
  if (groups.length === 0) {
    return (
      <View className={statePad}>
        {operationFailureSummary ? (
          <PageStateCard
            title={operationFailureSummary.title}
            body={operationFailureSummary.detail}
            tone="warning"
          />
        ) : (
          <PageStateCard title="No worktrees yet" body="Worktrees will appear here." />
        )}
      </View>
    );
  }

  return (
    <View className={cn(padded && "px-4")}>
      {operationFailureSummary ? (
        <PageStateCard
          className="mb-4"
          title={operationFailureSummary.title}
          body={operationFailureSummary.detail}
          tone="warning"
        />
      ) : null}
      <WorktreeManagementPanel
        projectStateKey={stateProjectKey}
        endpoint={endpoint}
        token={token}
        groups={groups}
      />
      <AgentCreatePanel
        projectStateKey={stateProjectKey}
        endpoint={endpoint}
        token={token}
        groups={groups}
      />
      <WorktreeList
        groups={groups}
        projectPath={stateProjectPath}
        projectStateKey={stateProjectKey}
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
