import type { DashboardService, DashboardSession, DashboardViewModel, WorktreeGroup } from "../../dashboard/index.js";
import { isAgentOutputEventKind } from "../../agent-events.js";
import { buildDashboardQuickJumpWorktrees, DASHBOARD_QUICK_JUMP_LIMIT } from "../../dashboard/quick-jump.js";
import { formatRelativeRecency } from "../../recency.js";
import { sessionRecencyAnchor } from "../../session-recency.js";
import { center, composeTwoPane, stripAnsi, truncate, truncateAnsi, wrapKeyValue } from "../render/text.js";
import {
  card,
  chip,
  type ChipTone,
  cols as gridCols,
  keycapHintLines,
  pill,
  statusDot,
  style,
  type Tone,
} from "../render/theme.js";

const RECENT_IDLE_MS = 2 * 60 * 1000;

type SessionUserLabel = NonNullable<DashboardSession["semantic"]>["user"]["label"];
type SessionPendingAction = NonNullable<DashboardSession["pendingAction"]>;
type SessionRowState = SessionUserLabel | SessionPendingAction;

const ROW_STATE_LABELS: Record<SessionRowState, string> = {
  working: "Working",
  ready: "Ready",
  needs_input: "Needs input",
  needs_response: "Needs response",
  next_step: "Next step",
  blocked: "Blocked",
  error: "Error",
  idle: "Idle",
  offline: "Offline",
  starting: "Starting",
  stopping: "Stopping",
  graveyarding: "Removing",
  done: "Done",
  interrupted: "Interrupted",
  creating: "Creating",
  forking: "Forking",
  migrating: "Migrating",
  renaming: "Renaming",
};

// Status cells render as attention pills; the rest use plain colored/dim text.
const PILL_STATES = new Set<SessionRowState>([
  "needs_input",
  "needs_response",
  "error",
  "blocked",
  "working",
  "next_step",
]);

const PILL_TONE: Partial<Record<SessionRowState, Tone>> = {
  needs_input: "attn",
  needs_response: "attn",
  error: "danger",
  blocked: "blocked",
  working: "work",
  next_step: "attn",
};

const PILL_LABEL: Partial<Record<SessionRowState, string>> = {
  needs_response: "NEEDS REPLY",
};

// Column widths for an agent/service row (before the trailing chips/hints region).
const COL_SELECT = 2;
const COL_DOT = 2;
const COL_INDEX = 4;
const COL_IDENTITY = 16;
const COL_STATUS = 14;
const COL_TIME = 16;

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecentlyIdle(session: DashboardSession, now = Date.now()): boolean {
  if (session.pendingAction) return false;
  const label = effectiveSessionRowState(session);
  if (label === "working" || label === "offline" || label === "error") return false;
  const becameIdleAt = parseTimestamp(session.becameIdleAt);
  return becameIdleAt !== null && now - becameIdleAt >= 0 && now - becameIdleAt <= RECENT_IDLE_MS;
}

function effectiveSessionRowState(session: DashboardSession): SessionRowState | undefined {
  return session.pendingAction ?? session.semantic?.user.label;
}

function sessionUserStateLabel(session: DashboardSession, fallback: string): string {
  const label = effectiveSessionRowState(session);
  if (label) return ROW_STATE_LABELS[label];
  if (fallback === "thinking") return "Working";
  return fallback.charAt(0).toUpperCase() + fallback.slice(1);
}

function sessionTimeAnchor(session: DashboardSession): { label: string; value?: string } | null {
  const lastOutputAt =
    session.lastOutputAt ??
    (session.lastEvent && isAgentOutputEventKind(session.lastEvent.kind) ? session.lastEvent.ts : undefined);

  if (session.pendingAction) {
    return {
      label: ROW_STATE_LABELS[session.pendingAction].toLowerCase(),
      value:
        session.pendingStartedAt ?? session.createdAt ?? session.lastUsedAt ?? session.becameIdleAt ?? lastOutputAt,
    };
  }

  return sessionRecencyAnchor({
    label: session.semantic?.user.label,
    latestUnreadAt: session.semantic?.notifications.latestUnread?.createdAt,
    lastOutputAt,
    becameIdleAt: session.becameIdleAt,
    lastUsedAt: session.lastUsedAt,
  });
}

function sessionTimeText(session: DashboardSession): string {
  const anchor = sessionTimeAnchor(session);
  if (!anchor?.value) return "";
  const recency = formatRelativeRecency(anchor.value);
  return recency ? style(`${anchor.label} ${recency}`, "muted") : "";
}

/** An offline agent gets no accent colors — its chips/hints render muted so the
 *  eye stays on live agents. Pending actions (creating/graveyarding) still count
 *  as active. */
function isSessionOffline(session: DashboardSession): boolean {
  if (session.pendingAction) return false;
  return effectiveSessionRowState(session) === "offline" || session.status === "offline" || session.status === "exited";
}

function sessionActivityChips(session: DashboardSession): string {
  const chips: string[] = [];
  const notificationUnread = session.semantic?.notifications.unreadCount ?? session.notificationUnreadCount ?? 0;
  const activityNew = session.semantic?.activityNewCount ?? session.unseenCount ?? 0;
  const threadUnread = session.threadUnreadCount ?? 0;
  const threadWaitingOnMe = session.threadWaitingOnMeCount ?? 0;
  const threadWaitingOnThem = session.threadWaitingOnThemCount ?? 0;
  const threadPending = session.threadPendingCount ?? 0;

  // Offline rows lose all accent tones; colors are reserved for live agents.
  const offline = isSessionOffline(session);
  const tone = (active: ChipTone): ChipTone => (offline ? "muted" : active);

  if (notificationUnread > 0) chips.push(chip(`${Math.min(notificationUnread, 99)} unread`, tone("work")));
  if (activityNew > 0) chips.push(chip(`${Math.min(activityNew, 99)} unseen`, tone("info")));
  if (threadUnread > 0 || threadWaitingOnMe > 0 || threadWaitingOnThem > 0) {
    chips.push(chip(`thread ${threadUnread}/${threadWaitingOnMe}/${threadWaitingOnThem}`, "muted"));
  }
  if (threadPending > 0) chips.push(chip(`${threadPending} pending`, tone("danger")));
  if ((session.workflowOnMeCount ?? 0) > 0) chips.push(chip("workflow on you", tone("attn")));
  if ((session.workflowBlockedCount ?? 0) > 0) chips.push(chip("workflow blocked", tone("danger")));
  if ((session.workflowFamilyCount ?? 0) > 0) chips.push(chip(`workflow ${session.workflowFamilyCount}`, "muted"));

  return chips.join(" ");
}

interface StateRank {
  rank: number;
  tone: Tone;
}

function sessionStateRank(state: SessionRowState | undefined): StateRank {
  switch (state) {
    case "error":
      return { rank: 6, tone: "danger" };
    case "needs_input":
    case "needs_response":
      return { rank: 5, tone: "attn" };
    case "blocked":
      return { rank: 4, tone: "blocked" };
    case "working":
      return { rank: 3, tone: "work" };
    case "ready":
      return { rank: 1, tone: "ready" };
    case "next_step":
      return { rank: 3, tone: "attn" };
    case "done":
      return { rank: 2, tone: "done" };
    case "idle":
      return { rank: 1, tone: "idle" };
    case undefined:
    case "offline":
      return { rank: 0, tone: "muted" };
    default:
      return { rank: 3, tone: "attn" };
  }
}

function semanticCountParts(worktree: { sessions: DashboardSession[] }): string[] {
  const counts = new Map<SessionRowState, number>();
  for (const session of worktree.sessions) {
    const label = effectiveSessionRowState(session);
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const parts: string[] = [];
  const append = (label: SessionRowState, text: string, tone: Tone = "muted") => {
    const count = counts.get(label) ?? 0;
    if (count > 0) parts.push(style(`${count} ${text}`, tone));
  };

  append("needs_input", "needs input", "attn");
  append("needs_response", "needs response", "attn");
  append("next_step", "next step", "attn");
  append("blocked", "blocked", "blocked");
  append("error", "error", "danger");
  append("working", "working", "work");
  append("ready", "ready", "ready");
  append("idle", "idle");
  append("done", "done", "done");
  append("offline", "offline");
  append("creating", "creating", "attn");
  append("forking", "forking", "attn");
  append("migrating", "migrating", "attn");
  append("starting", "starting", "attn");
  append("stopping", "stopping", "attn");
  append("graveyarding", "removing", "attn");
  append("renaming", "renaming", "attn");

  return parts;
}

interface WorktreeLike {
  sessions: DashboardSession[];
  services: DashboardService[];
  operationFailure?: unknown;
  pendingAction?: string;
  removing?: boolean;
  pending?: boolean;
}

function worktreeTone(worktree: WorktreeLike): Tone {
  if (worktree.operationFailure) return "danger";
  let best: StateRank = { rank: 0, tone: "muted" };
  for (const session of worktree.sessions) {
    const ranked = sessionStateRank(effectiveSessionRowState(session));
    if (ranked.rank > best.rank) best = ranked;
  }
  return best.tone;
}

function worktreeSummaryText(worktree: WorktreeLike): string {
  if (worktree.operationFailure) return style("failed", "danger");
  if (worktree.pendingAction === "creating") return style("(creating...)", "attn");
  if (worktree.pendingAction === "graveyarding") return style("(graveyarding...)", "attn");
  if (worktree.removing || worktree.pending) return style("(removing...)", "attn");
  const parts = semanticCountParts(worktree);
  if (parts.length > 0) return parts.join(style(" · ", "muted"));
  return worktree.sessions.length + worktree.services.length === 0 ? style("no agents", "muted") : "";
}

function sessionStatusDot(session: DashboardSession): string {
  if (session.pendingAction) return style("●", "attn");
  const label = effectiveSessionRowState(session);
  const attention = session.semantic?.user.attention;
  if (attention === "error" || label === "error") return statusDot("error");
  if (attention === "blocked" || label === "blocked") return statusDot("blocked");
  if (attention === "needs_input" || label === "needs_input") return statusDot("needs");
  if (attention === "needs_response" || label === "needs_response") return statusDot("needs");
  if (label === "working") return statusDot("working");
  if (label === "ready") return statusDot("ready");
  if (label === "done") return statusDot("done");
  if (label === "next_step") return style("●", "attn");
  if (label === "idle") return statusDot("idle");
  if (label === "offline") return statusDot("offline");
  if (session.status === "offline") return statusDot("offline");
  if (session.status === "waiting") return statusDot("needs");
  if (session.status === "exited") return style("○", "danger");
  if (session.status === "idle") return statusDot("done");
  return style("●", "attn");
}

function sessionStatusCell(session: DashboardSession, fallback: string): string {
  const label = sessionUserStateLabel(session, fallback);
  const rowState = effectiveSessionRowState(session);
  if (rowState && PILL_STATES.has(rowState)) {
    const pillLabel = PILL_LABEL[rowState] ?? label.toUpperCase();
    return pill(pillLabel, PILL_TONE[rowState] ?? "attn");
  }
  let tone: Tone = "muted";
  if (session.pendingAction) tone = "attn";
  if (rowState === "ready") tone = "ready";
  if (rowState === "done") tone = "done";
  if (rowState === "idle") tone = "idle";
  return style(label, tone);
}

function serviceStatusDot(service: DashboardService): string {
  if (service.status === "running") return statusDot("service");
  if (service.status === "exited") return style("◇", "danger");
  return statusDot("serviceOff");
}

function summarizeTeammate(
  session: DashboardSession,
  derivedStatusLabel: DashboardViewModel["derivedStatusLabel"],
): string {
  const identity = session.team?.label ?? session.label ?? session.command;
  const role = session.team?.role ?? session.role;
  const status = derivedStatusLabel(session);
  const hint = session.semantic?.presentation.compactHint;
  return [role ? `${identity}(${role})` : identity, status, hint && hint !== status ? hint : undefined]
    .filter(Boolean)
    .join(" · ");
}

export function renderDashboardFrame(
  state: DashboardViewModel,
  cols: number,
  rows: number,
): { frame: string; scrollOffset: number } {
  const contentWidth = Math.max(72, cols);
  const twoPane = cols >= 72 && state.detailsPaneVisible;
  const leftWidth = Math.max(32, Math.floor(contentWidth * 0.58));
  const cardWidth = twoPane ? leftWidth : contentWidth;
  const padBlockLine = (line: string): string => line;
  const centerInBlock = (line: string): string => truncateAnsi(center(line, contentWidth), cols);
  const buildHelpLines = (line: string): string[] => keycapHintLines(line, contentWidth);

  const trailingHints = (parts: string[]): string => parts.filter(Boolean).join(" ");

  const indexCell = (digit?: number): string => (digit ? style(`[${digit}]`, "muted") : "");

  const agentRow = (session: DashboardSession, selected: boolean, digit?: number): string => {
    const role = session.role ? ` ${style(session.role, "muted")}` : "";
    const identity = `${style(session.label ?? session.command, "strong")}${role}`;
    const grid = gridCols([
      { content: selected ? `${style("▸", "accent")} ` : "  ", width: COL_SELECT },
      { content: `${sessionStatusDot(session)} `, width: COL_DOT },
      { content: indexCell(digit), width: COL_INDEX },
      { content: identity, width: COL_IDENTITY },
      { content: sessionStatusCell(session, state.derivedStatusLabel(session)), width: COL_STATUS },
      { content: sessionTimeText(session), width: COL_TIME },
    ]);
    const offline = isSessionOffline(session);
    const hintTone = (active: Tone): Tone => (offline ? "muted" : active);
    const trailing = trailingHints([
      sessionActivityChips(session),
      isRecentlyIdle(session) ? style("idle now", hintTone("ready")) : "",
      session.taskDescription ? style(`⧫ ${truncate(session.taskDescription, 40)}`, hintTone("blocked")) : "",
      session.workflowNextAction ? style(`→ ${truncate(session.workflowNextAction, 24)}`, hintTone("attn")) : "",
      session.headline ? style(`· ${truncate(session.headline, 50)}`, "muted") : "",
    ]);
    return trailing ? `${grid} ${trailing}` : grid;
  };

  const serviceRow = (service: DashboardService, selected: boolean, digit?: number): string => {
    const statusLabel = service.pendingAction ?? service.status;
    const statusTone: Tone = service.status === "running" ? "done" : service.status === "exited" ? "danger" : "muted";
    const grid = gridCols([
      { content: selected ? `${style("▸", "accent")} ` : "  ", width: COL_SELECT },
      { content: `${serviceStatusDot(service)} `, width: COL_DOT },
      { content: indexCell(digit), width: COL_INDEX },
      { content: style(service.label ?? service.command, "strong"), width: COL_IDENTITY },
      { content: style(`[svc] ${statusLabel}`, statusTone), width: COL_STATUS },
      {
        content: service.lastUsedAt ? style(formatRelativeRecency(service.lastUsedAt) ?? "", "muted") : "",
        width: COL_TIME,
      },
    ]);
    const commandHint = service.shellCommand
      ? style(`· ${truncate(service.shellCommand, 36)}`, "muted")
      : service.foregroundCommand
        ? style(`· ${truncate(service.foregroundCommand, 22)}`, "muted")
        : "";
    const trailing = trailingHints([
      commandHint,
      service.pid ? style(`(pid ${service.pid})`, "muted") : "",
      service.previewLine ? style(`· ${truncate(service.previewLine, 40)}`, "muted") : "",
    ]);
    return trailing ? `${grid} ${trailing}` : grid;
  };

  const renderWorktreeGrouped = (lines: string[]): void => {
    const quickJumpWorktrees = buildDashboardQuickJumpWorktrees({
      sessions: state.sessions,
      services: state.services,
      worktreeGroups: state.worktreeGroups,
      mainCheckout: state.mainCheckout,
    });

    for (const worktree of quickJumpWorktrees) {
      const focused = worktree.path === state.focusedWorktreePath;
      const focusMark = focused && state.navLevel === "worktrees" ? `${style("▸", "accent")} ` : "";
      const nameTone: Tone = focused ? "accent" : "strong";
      const badge = worktree.digit ? `[${worktree.digit}] ` : "";
      let title = `${focusMark}${style(`${badge}${worktree.name}`, nameTone)}`;
      if (worktree.branch) title += ` ${style(`· ${worktree.branch}`, "muted")}`;
      const summary = worktreeSummaryText(worktree);
      const tone = worktreeTone(worktree);

      const digitById = new Map(worktree.entries.map((entry) => [entry.id, entry.digit]));
      const cardRows: string[] = [];
      for (const session of worktree.sessions) {
        const selected = state.navLevel === "sessions" && session.id === state.selectedSessionId;
        cardRows.push(agentRow(session, selected, digitById.get(session.id)));
      }
      for (const service of worktree.services) {
        const selected = state.navLevel === "sessions" && service.id === state.selectedServiceId;
        cardRows.push(serviceRow(service, selected, digitById.get(service.id)));
      }

      for (const line of card({ tone, title, summary: summary || undefined, rows: cardRows, width: cardWidth })) {
        lines.push(line);
      }
      lines.push("");
    }
  };

  const findFocusLine = (content: string[]): number => {
    for (let i = 0; i < content.length; i++) {
      const stripped = content[i].replace(/\x1b\[[0-9;]*m/g, "");
      if (stripped.includes("▸")) return i;
    }
    return -1;
  };

  const buildHelpLine = (): string => {
    const selectedSession = state.selectedSessionId
      ? state.sessions.find((s) => s.id === state.selectedSessionId)
      : undefined;
    const selectedService = state.selectedServiceId
      ? state.services.find((s) => s.id === state.selectedServiceId)
      : undefined;
    const xLabel = selectedService
      ? "[x] stop"
      : selectedSession?.status === "offline"
        ? "[x] kill"
        : selectedSession
          ? "[x] stop"
          : "";
    const rLabel = selectedSession ? "  [r] name" : "";
    const teamLabel = selectedSession && state.selectedTeammates.length > 0 ? "  [e] team" : "";
    const enterLabel = selectedService
      ? "Enter open"
      : selectedSession?.status === "offline"
        ? "Enter resume"
        : "Enter focus";

    if (state.sessions.length === 0 && !state.hasWorktrees) {
      return " [u] attention  [Tab] details  [n] new agent  [v] service  [f] fork  [S] msg  [H] handoff  [T] task  [o] thread  [R] reply  [?] help  [q] quit ";
    }
    if (state.hasWorktrees && state.navLevel === "sessions") {
      const xPart = xLabel ? `  ${xLabel}` : "";
      return ` ↑↓ items  Shift+↑↓ reorder  1-9/12 jump  ${enterLabel}  Esc back  [u] attention  [Tab] details  [n] new agent  [v] service  [f] fork  [S] msg  [H] handoff  [T] task  [o] thread  [R] reply${teamLabel}  [m] migrate${xPart}${rLabel}  [?] help  [q] quit `;
    }
    if (state.hasWorktrees) {
      return ` ↑↓ worktrees  1-9/12 jump  Enter step in  [u] attention  [Tab] details  [n] new agent  [v] service  [f] fork(step in)  [w] worktree  [?] help  [q] quit `;
    }
    if (state.sessions.length > 0) {
      const xPart = xLabel ? `  ${xLabel}` : "";
      return ` ↑↓ select  ${enterLabel}  [u] attention  [Tab] details  [n] new agent  [v] service  [f] fork  [S] msg  [H] handoff  [T] task  [o] thread  [R] reply${teamLabel}  [w] worktree${xPart}${rLabel}  [?] help  [q] quit `;
    }
    return " [u] attention  [Tab] details  [n] new agent  [v] service  [f] fork  [S] msg  [H] handoff  [T] task  [o] thread  [R] reply  [w] worktree  [?] help  [q] quit ";
  };

  const renderSelectedDetailsPanel = (panelWidth: number, height: number): string[] => {
    const width = Math.max(8, panelWidth - 4);
    const finish = (titleText: string, tone: Tone, rows: string[]): string[] => {
      const bodyRows = rows.slice(0, Math.max(0, height - 2));
      const out = card({ tone, title: style(titleText, tone), rows: bodyRows, width: panelWidth });
      while (out.length < height) out.push("");
      return out.slice(0, height);
    };
    const selectedSession = state.selectedSessionId
      ? state.sessions.find((session) => session.id === state.selectedSessionId)
      : undefined;
    const selectedService = state.selectedServiceId
      ? state.services.find((service) => service.id === state.selectedServiceId)
      : undefined;
    if (!selectedSession && !selectedService) {
      const focusedWorktreePath = state.focusedWorktreePath;
      const focusedSessions = state.sessions.filter(
        (session) => (session.worktreePath ?? undefined) === focusedWorktreePath,
      );
      const focusedServices = state.services.filter(
        (service) => (service.worktreePath ?? undefined) === focusedWorktreePath,
      );
      const worktree: { name: string; branch: string; path: string } =
        focusedWorktreePath === undefined
          ? {
              name: state.mainCheckout.name,
              branch: state.mainCheckout.branch,
              path: "(main checkout)",
            }
          : (() => {
              const focusedGroup = state.worktreeGroups.find(
                (group): group is WorktreeGroup & { path: string } => group.path === focusedWorktreePath,
              );
              return (
                focusedGroup ?? {
                  name: focusedSessions[0]?.worktreeName ?? focusedServices[0]?.worktreeName ?? "Worktree",
                  branch: focusedSessions[0]?.worktreeBranch ?? focusedServices[0]?.worktreeBranch ?? "",
                  path: focusedWorktreePath,
                }
              );
            })();

      const lines: string[] = [];
      lines.push(...wrapKeyValue("Name", worktree.name, width));
      if (worktree.branch) lines.push(...wrapKeyValue("Branch", worktree.branch, width));
      lines.push(...wrapKeyValue("Path", worktree.path, width));
      const focusedGroup =
        focusedWorktreePath === undefined
          ? undefined
          : state.worktreeGroups.find((group) => group.path === focusedWorktreePath);
      if (focusedGroup?.operationFailure) {
        lines.push(...wrapKeyValue("Status", "failed", width));
        lines.push(...wrapKeyValue("Operation", focusedGroup.operationFailure.operation, width));
        lines.push(...wrapKeyValue("Error", focusedGroup.operationFailure.message, width));
        lines.push(
          ...wrapKeyValue(
            "Failed",
            formatRelativeRecency(focusedGroup.operationFailure.createdAt) ?? focusedGroup.operationFailure.createdAt,
            width,
          ),
        );
      }
      if (focusedGroup?.pendingAction === "creating") {
        lines.push(...wrapKeyValue("Status", "creating", width));
      }
      lines.push(...wrapKeyValue("Agents", String(focusedSessions.length), width));
      lines.push(...wrapKeyValue("Services", String(focusedServices.length), width));
      const activeWorktreeRemoval =
        state.worktreeRemoval?.path === focusedWorktreePath ? state.worktreeRemoval : undefined;
      if (activeWorktreeRemoval) {
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - activeWorktreeRemoval.startedAt) / 1000));
        lines.push(...wrapKeyValue("Status", "removing", width));
        lines.push(...wrapKeyValue("Elapsed", `${elapsedSeconds}s`, width));
        const detailLines = (activeWorktreeRemoval.stderr ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-3);
        if (detailLines.length > 0) {
          lines.push(...wrapKeyValue("Progress", detailLines.join(" | "), width));
        }
      }
      if (focusedSessions.length > 0) {
        lines.push(
          ...wrapKeyValue(
            "Active",
            focusedSessions
              .map((session) => session.label ?? session.command)
              .slice(0, 3)
              .join(", "),
            width,
          ),
        );
      }
      if (focusedServices.length > 0) {
        lines.push(
          ...wrapKeyValue(
            "Running",
            focusedServices
              .map((service) => service.label ?? service.command)
              .slice(0, 3)
              .join(", "),
            width,
          ),
        );
      }
      return finish("WORKTREE", "accent", lines);
    }

    const lines: string[] = [];
    if (selectedService) {
      lines.push(
        ...wrapKeyValue(
          "Service",
          `${selectedService.label ?? selectedService.command} (${selectedService.id})`,
          width,
        ),
      );
      lines.push(...wrapKeyValue("Command", selectedService.command, width));
      if (selectedService.shellCommand) {
        lines.push(
          ...wrapKeyValue(
            selectedService.shellCommandState === "running" ? "Running" : "Last command",
            selectedService.shellCommand,
            width,
          ),
        );
      }
      if (selectedService.foregroundCommand)
        lines.push(...wrapKeyValue("Foreground", selectedService.foregroundCommand, width));
      if (selectedService.pid) lines.push(...wrapKeyValue("PID", String(selectedService.pid), width));
      if (selectedService.worktreeName || selectedService.worktreeBranch) {
        lines.push(
          ...wrapKeyValue(
            "Worktree",
            `${selectedService.worktreeName ?? "main"}${selectedService.worktreeBranch ? ` · ${selectedService.worktreeBranch}` : ""}`,
            width,
          ),
        );
      }
      if (selectedService.cwd) lines.push(...wrapKeyValue("CWD", selectedService.cwd, width));
      lines.push(...wrapKeyValue("Status", selectedService.status, width));
      if (selectedService.previewLine) lines.push(...wrapKeyValue("Preview", selectedService.previewLine, width));
      return finish("DETAILS", "info", lines);
    }

    const selected = selectedSession!;
    lines.push(...wrapKeyValue("Agent", `${selected.label ?? selected.command} (${selected.id})`, width));
    lines.push(...wrapKeyValue("Tool", selected.command, width));
    if (selected.worktreeName || selected.worktreeBranch) {
      lines.push(
        ...wrapKeyValue(
          "Worktree",
          `${selected.worktreeName ?? "main"}${selected.worktreeBranch ? ` · ${selected.worktreeBranch}` : ""}`,
          width,
        ),
      );
    }
    if (selected.cwd) lines.push(...wrapKeyValue("CWD", selected.cwd, width));
    if (selected.foregroundCommand) lines.push(...wrapKeyValue("Foreground", selected.foregroundCommand, width));
    if (selected.pid) lines.push(...wrapKeyValue("PID", String(selected.pid), width));
    if (selected.prNumber || selected.prTitle || selected.prUrl) {
      const prHeader = [`PR${selected.prNumber ? ` #${selected.prNumber}` : ""}`];
      if (selected.prTitle) prHeader.push(selected.prTitle);
      lines.push(...wrapKeyValue("PR", prHeader.join(": "), width));
      if (selected.prUrl) lines.push(...wrapKeyValue("URL", selected.prUrl, width));
    }
    if (selected.repoOwner || selected.repoName)
      lines.push(...wrapKeyValue("Repo", `${selected.repoOwner ?? "?"}/${selected.repoName ?? "?"}`, width));
    if (selected.repoRemote) lines.push(...wrapKeyValue("Remote", selected.repoRemote, width));
    if (selected.previewLine) lines.push(...wrapKeyValue("Preview", selected.previewLine, width));
    if (selected.pendingAction) {
      lines.push(...wrapKeyValue("State", ROW_STATE_LABELS[selected.pendingAction], width));
      if (selected.pendingStartedAt) {
        const startedRecency = formatRelativeRecency(selected.pendingStartedAt);
        if (startedRecency) lines.push(...wrapKeyValue("Started", startedRecency, width));
      }
    } else if (selected.semantic) {
      lines.push(...wrapKeyValue("State", selected.semantic.presentation.statusLabel, width));
      if (selected.semantic.user.attention !== "none") {
        lines.push(...wrapKeyValue("Attention", selected.semantic.user.attention, width));
      }
      if (selected.semantic.notifications.unreadCount > 0) {
        lines.push(...wrapKeyValue("Unread", String(selected.semantic.notifications.unreadCount), width));
      }
      if (selected.semantic.notifications.latestText) {
        lines.push(...wrapKeyValue("Latest", selected.semantic.notifications.latestText, width));
      }
      if (selected.semantic.activityNewCount > 0) {
        lines.push(...wrapKeyValue("New activity", String(selected.semantic.activityNewCount), width));
      }
    }
    if (selected.lastEvent?.message) lines.push(...wrapKeyValue("Last", selected.lastEvent.message, width));
    if (selected.threadName || selected.threadId)
      lines.push(...wrapKeyValue("Thread", selected.threadName ?? selected.threadId ?? "", width));
    if (
      (selected.threadUnreadCount ?? 0) > 0 ||
      (selected.threadWaitingOnMeCount ?? 0) > 0 ||
      (selected.threadWaitingOnThemCount ?? 0) > 0 ||
      (selected.threadPendingCount ?? 0) > 0
    ) {
      lines.push(
        ...wrapKeyValue(
          "Threads",
          `${selected.threadUnreadCount ?? 0} unread · ${selected.threadWaitingOnMeCount ?? 0} on me · ${selected.threadWaitingOnThemCount ?? 0} on them · ${selected.threadPendingCount ?? 0} pending`,
          width,
        ),
      );
    }
    if (
      (selected.workflowOnMeCount ?? 0) > 0 ||
      (selected.workflowBlockedCount ?? 0) > 0 ||
      (selected.workflowFamilyCount ?? 0) > 0 ||
      selected.workflowTopLabel
    ) {
      const summary = [
        `${selected.workflowOnMeCount ?? 0} on me`,
        `${selected.workflowBlockedCount ?? 0} blocked`,
        `${selected.workflowFamilyCount ?? 0} families`,
        selected.workflowTopLabel ? `top: ${selected.workflowTopLabel}` : undefined,
        selected.workflowNextAction ? `next: ${selected.workflowNextAction}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(...wrapKeyValue("Workflow", summary, width));
    }
    if ((selected.services?.length ?? 0) > 0) {
      lines.push(...wrapKeyValue("Services", selected.services!.map((s) => s.url ?? `:${s.port}`).join(", "), width));
    }
    if (state.selectedTeammates.length > 0) {
      lines.push("");
      lines.push(style("Team", "strong"));
      for (const teammate of state.selectedTeammates.slice(0, 5)) {
        lines.push(...wrapKeyValue("-", summarizeTeammate(teammate, state.derivedStatusLabel), width));
      }
      if (state.selectedTeammates.length > 5) {
        lines.push(...wrapKeyValue("-", `${state.selectedTeammates.length - 5} more`, width));
      }
    }
    return finish("DETAILS", "info", lines);
  };

  const devBadge = state.isDevRuntime ? "\x1b[1;30;43m DEV \x1b[0m " : "";
  const versionTag = state.version ? ` ${style(`v${state.version}`, "muted")}` : "";
  const title = `${devBadge}\x1b[1maimux\x1b[0m${versionTag} — agent multiplexer${state.runtimeLabel ? `  \x1b[32m● ${state.runtimeLabel}\x1b[0m` : ""}`;
  const divider = state.isDevRuntime
    ? `\x1b[33m${"─".repeat(Math.max(0, cols))}\x1b[0m`
    : "─".repeat(Math.max(0, cols));
  const header: string[] = ["", centerInBlock(title), divider, ""];
  const content: string[] = [];
  const operationFailures = state.operationFailures ?? [];
  if (operationFailures.length > 0) {
    const failureRows = operationFailures.slice(0, 3).map((failure) => {
      const recency = formatRelativeRecency(failure.createdAt) ?? failure.createdAt;
      const target = failure.worktreeName ?? failure.targetId ?? failure.worktreePath;
      const targetHint = target ? style(` · ${truncate(target, 24)}`, "muted") : "";
      return `${truncate(failure.title, 48)}${targetHint}${style(` · ${recency}`, "muted")}`;
    });
    if (operationFailures.length > 3) {
      failureRows.push(style(`${operationFailures.length - 3} more failures`, "muted"));
    }
    for (const line of card({
      tone: "danger",
      title: style("⚠ FAILED OPERATIONS", "danger"),
      rows: failureRows,
      width: cardWidth,
    })) {
      content.push(line);
    }
    content.push("");
  }
  const overseerSessions = state.overseerSessions ?? [];
  if (overseerSessions.length > 0) {
    content.push(`  ${style("Overseer", "blocked")}`);
    for (const session of overseerSessions) content.push(`    ${agentRow(session, false)}`);
    content.push("");
  }
  if (state.sessions.length === 0 && state.worktreeGroups.length === 0) {
    content.push(centerInBlock("No sessions. Press [n] to create one."));
  } else if (state.hasWorktrees) {
    renderWorktreeGrouped(content);
  } else {
    state.sessions.forEach((session, index) => {
      const selected = state.navLevel === "sessions" && session.id === state.selectedSessionId;
      const digit = index < DASHBOARD_QUICK_JUMP_LIMIT ? index + 1 : undefined;
      content.push(`  ${agentRow(session, selected, digit)}`);
    });
  }

  const helpLines = buildHelpLines(buildHelpLine());
  const footer: string[] = ["─".repeat(Math.max(0, cols)), ...helpLines.map((line) => centerInBlock(line))];
  const viewportHeight = rows - header.length - footer.length;
  let scrollOffset = state.scrollOffset;
  const focusLine = findFocusLine(content);
  // The focused card spans from its marker line to the next blank separator;
  // scroll to reveal its whole body, not just the marker line, so the bottom
  // of the last (possibly tall) card is always reachable.
  let focusEnd = focusLine;
  while (focusEnd >= 0 && focusEnd + 1 < content.length && stripAnsi(content[focusEnd + 1]).trim() !== "") {
    focusEnd++;
  }
  const maxScroll = Math.max(0, content.length - viewportHeight);
  if (focusLine >= 0) {
    if (focusLine < scrollOffset + 1) {
      scrollOffset = Math.max(0, focusLine - 1);
    } else if (focusEnd >= scrollOffset + viewportHeight - 1) {
      scrollOffset = Math.min(maxScroll, focusEnd - viewportHeight + 2);
      // If the card is taller than the viewport, keep its top edge in view.
      if (focusLine < scrollOffset + 1) scrollOffset = Math.max(0, focusLine - 1);
    }
  }
  scrollOffset = Math.min(scrollOffset, maxScroll);
  const visibleContent = content.slice(scrollOffset, scrollOffset + viewportHeight);
  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset < maxScroll;
  if (canScrollUp) visibleContent[0] = centerInBlock("\x1b[2m▲ more ▲\x1b[0m");
  if (canScrollDown && visibleContent.length > 0)
    visibleContent[visibleContent.length - 1] = centerInBlock("\x1b[2m▼ more ▼\x1b[0m");
  while (visibleContent.length < viewportHeight) visibleContent.push("");

  let bodyLines = visibleContent;
  if (twoPane) {
    const panelWidth = Math.max(20, contentWidth - leftWidth - 4);
    const rightPanel = renderSelectedDetailsPanel(panelWidth, viewportHeight);
    bodyLines = composeTwoPane(visibleContent, rightPanel, contentWidth, "   ").map(padBlockLine);
  } else {
    bodyLines = visibleContent.map((line) => padBlockLine(line));
  }
  return {
    frame: "\x1b[2J\x1b[H" + [...header, ...bodyLines, ...footer].join("\r\n"),
    scrollOffset,
  };
}
