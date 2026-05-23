import type { DesktopSession } from "@/lib/desktop-state";
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
