import type { DesktopSession } from "@/lib/desktop-state";
import type { NotificationRecord } from "@/lib/api";
import type { AlertEvent } from "@/lib/events";
import {
  isAgentNotificationEnabled,
  type AgentNotificationKind,
  type NotificationSettings,
} from "@/lib/notification-settings";

export type ClientNotificationCategory = "agent" | "system";

export interface ClientNotificationEvent {
  id: string;
  dedupeKey: string;
  category: ClientNotificationCategory;
  kind: AgentNotificationKind | string;
  title: string;
  body: string;
  target?: {
    projectPath?: string;
    sessionId?: string;
  };
}

export interface SessionNotificationSnapshot {
  id: string;
  status: string;
  attention: string;
  activity: string;
  label: string;
  headline: string;
  unseenCount: number;
}

export interface SessionNotificationContext {
  projectName?: string;
  projectPath?: string;
}

const ACTIVE_ATTENTIONS = new Set(["needs_input", "blocked", "error"]);
const ERROR_KINDS = new Set(["error", "task_failed"]);
const COMPLETED_KINDS = new Set(["completed", "task_done"]);
const ACTIVITY_KINDS = new Set(["activity", "notification", "notify"]);
const NEEDS_INPUT_KINDS = new Set([
  "needs_input",
  "next_step",
  "interaction_request",
  "message_waiting",
  "handoff_waiting",
  "task_assigned",
  "review_waiting",
]);
const RECORD_CATCHUP_NOTIFICATION_WINDOW_MS = 30_000;

export function snapshotSessionForNotifications(
  session: DesktopSession,
): SessionNotificationSnapshot {
  return {
    id: session.id,
    status: session.status,
    attention: normalizeState(session.attention),
    activity: normalizeState(session.activity),
    label: session.label?.trim() || session.command?.trim() || session.id,
    headline: session.headline?.trim() || session.previewLine?.trim() || "",
    unseenCount: session.unseenCount ?? 0,
  };
}

export function evaluateAgentNotification(
  session: DesktopSession,
  previous: SessionNotificationSnapshot | undefined,
  settings: NotificationSettings,
  context: SessionNotificationContext = {},
): ClientNotificationEvent | null {
  const current = snapshotSessionForNotifications(session);
  if (!previous) return null;

  const attentionEvent = evaluateAttentionTransition(current, previous, settings, context);
  if (attentionEvent) return attentionEvent;

  if (
    isAgentNotificationEnabled(settings, "completed") &&
    current.activity === "done" &&
    previous.activity !== "done"
  ) {
    return buildAgentEvent("completed", current, context, "completed", "Agent completed");
  }

  if (
    isAgentNotificationEnabled(settings, "activity") &&
    current.unseenCount > previous.unseenCount &&
    !ACTIVE_ATTENTIONS.has(current.attention)
  ) {
    return buildAgentEvent(
      "activity",
      current,
      context,
      `activity:${current.unseenCount}`,
      "New agent activity",
    );
  }

  return null;
}

export function evaluateNotificationRecord(
  record: NotificationRecord,
  settings: NotificationSettings,
  context: SessionNotificationContext = {},
): ClientNotificationEvent | null {
  if (!record.unread || record.cleared) return null;
  if (!isRecentNotificationRecord(record, Date.now())) return null;
  const kind = mapNotificationRecordKind(record.kind);
  if (!kind || !isAgentNotificationEnabled(settings, kind)) return null;

  const title = titleWithProject(record.title, context, record.projectName);
  return {
    id: record.id,
    dedupeKey: record.dedupeKey || `notification:${record.id}`,
    category: "agent",
    kind,
    title,
    body: record.body || record.subtitle || record.title,
    target: {
      projectPath: context.projectPath,
      sessionId: record.sessionId,
    },
  };
}

export function evaluateAlertEvent(
  event: AlertEvent,
  settings: NotificationSettings,
  context: SessionNotificationContext = {},
): ClientNotificationEvent | null {
  if (event.interaction?.telemetry) return null;
  const kind = mapNotificationRecordKind(event.kind);
  if (!kind || !isAgentNotificationEnabled(settings, kind)) return null;

  const title = titleWithProject(event.title || "aimux", context, event.projectName);
  const id =
    event.notificationId ||
    `alert:${event.projectId}:${event.kind}:${event.sessionId ?? "project"}:${event.ts}`;
  return {
    id,
    dedupeKey:
      event.dedupeKey || (event.notificationId ? `notification:${event.notificationId}` : id),
    category: "agent",
    kind,
    title,
    body: event.message || event.sessionId || event.kind,
    target: {
      projectPath: context.projectPath,
      sessionId: event.sessionId,
    },
  };
}

function evaluateAttentionTransition(
  current: SessionNotificationSnapshot,
  previous: SessionNotificationSnapshot,
  settings: NotificationSettings,
  context: SessionNotificationContext,
): ClientNotificationEvent | null {
  if (current.attention === previous.attention) return null;
  if (current.attention === "needs_input" && isAgentNotificationEnabled(settings, "needs_input")) {
    return buildAgentEvent(
      "needs_input",
      current,
      context,
      "attention:needs_input",
      "Agent needs input",
    );
  }
  if (current.attention === "blocked" && isAgentNotificationEnabled(settings, "blocked")) {
    return buildAgentEvent("blocked", current, context, "attention:blocked", "Agent is blocked");
  }
  if (current.attention === "error" && isAgentNotificationEnabled(settings, "error")) {
    return buildAgentEvent("error", current, context, "attention:error", "Agent hit an error");
  }
  return null;
}

function buildAgentEvent(
  kind: AgentNotificationKind,
  snapshot: SessionNotificationSnapshot,
  context: SessionNotificationContext,
  transitionKey: string,
  title: string,
): ClientNotificationEvent {
  const projectPrefix = context.projectName ? `${context.projectName}: ` : "";
  return {
    id: `${snapshot.id}:${transitionKey}`,
    dedupeKey: `agent:${snapshot.id}:${transitionKey}`,
    category: "agent",
    kind,
    title: `${projectPrefix}${title}`,
    body: snapshot.headline || snapshot.label,
    target: {
      projectPath: context.projectPath,
      sessionId: snapshot.id,
    },
  };
}

function normalizeState(value: string | undefined): string {
  return value?.trim() || "none";
}

function titleWithProject(
  title: string,
  context: SessionNotificationContext,
  serverProjectName?: string,
): string {
  const trimmed = title.trim() || "aimux";
  const projectName = serverProjectName?.trim() || context.projectName?.trim();
  if (!projectName) return trimmed;
  if (serverProjectName?.trim()) return trimmed;
  if (trimmed.startsWith(`${projectName}: `) || trimmed.includes(`${projectName} /`)) {
    return trimmed;
  }
  return `${projectName}: ${trimmed}`;
}

export function isRecentNotificationRecord(record: NotificationRecord, nowMs: number): boolean {
  const createdAtMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAtMs)) return false;
  return nowMs - createdAtMs <= RECORD_CATCHUP_NOTIFICATION_WINDOW_MS;
}

function mapNotificationRecordKind(kind: string | undefined): AgentNotificationKind | null {
  const normalized = kind?.trim();
  if (normalized && NEEDS_INPUT_KINDS.has(normalized)) return "needs_input";
  if (normalized === "blocked") return "blocked";
  if (normalized && ERROR_KINDS.has(normalized)) return "error";
  if (normalized && COMPLETED_KINDS.has(normalized)) return "completed";
  if (normalized && ACTIVITY_KINDS.has(normalized)) return "activity";
  return null;
}
