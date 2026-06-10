import { getProjectId } from "./paths.js";
import { upsertNotification } from "./notifications.js";
import { isSessionNotificationFocused } from "./notification-context.js";
import type { InteractionType } from "./interaction-requests.js";

export type AlertKind =
  | "notification"
  | "needs_input"
  | "task_done"
  | "task_failed"
  | "blocked"
  | "message_waiting"
  | "handoff_waiting"
  | "task_assigned"
  | "review_waiting"
  | "interaction_request";

export interface AlertEvent {
  type: "alert";
  kind: AlertKind;
  projectId: string;
  sessionId?: string;
  title: string;
  message: string;
  ts: string;
  threadId?: string;
  taskId?: string;
  worktreePath?: string;
  dedupeKey?: string;
  forceNotify?: boolean;
  /** Present on actionable interaction_request alerts so clients can resolve them.
   * `telemetry: true` marks a read-only notice (e.g. Codex, whose native TUI owns
   * the decision) — clients render it as a non-actionable Feed row. */
  interaction?: {
    id: string;
    type: InteractionType;
    summary?: string;
    telemetry?: boolean;
    toolName?: string;
    toolInputJSON?: string;
  };
}

export type ProjectStreamEvent = AlertEvent;

type ProjectEventListener = (event: ProjectStreamEvent) => void;

export class ProjectEventBus {
  private listeners = new Set<ProjectEventListener>();
  private alertCooldowns = new Map<string, number>();

  subscribe(listener: ProjectEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: ProjectStreamEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  publishAlert(
    alert: Omit<AlertEvent, "type" | "projectId" | "ts"> & {
      dedupeKey?: string;
      cooldownMs?: number;
      forceNotify?: boolean;
    },
  ): boolean {
    const cooldownMs = alert.cooldownMs ?? 15_000;
    const dedupeKey = alert.dedupeKey?.trim() || undefined;
    if (dedupeKey) {
      const now = Date.now();
      const until = this.alertCooldowns.get(dedupeKey) ?? 0;
      if (until > now) {
        return false;
      }
      this.alertCooldowns.set(dedupeKey, now + cooldownMs);
    }

    const event = {
      type: "alert",
      projectId: getProjectId(),
      ts: new Date().toISOString(),
      kind: alert.kind,
      sessionId: alert.sessionId,
      title: alert.title,
      message: alert.message,
      threadId: alert.threadId,
      taskId: alert.taskId,
      worktreePath: alert.worktreePath,
      dedupeKey,
      forceNotify: alert.forceNotify,
      interaction: alert.interaction,
    } satisfies AlertEvent;

    upsertNotification({
      title: event.title,
      body: event.message,
      sessionId: event.sessionId,
      kind: event.kind,
      dedupeKey: event.dedupeKey,
      createdAt: event.ts,
      unread: !event.sessionId || event.forceNotify ? true : !isSessionNotificationFocused(event.sessionId),
    });

    this.publish(event);
    return true;
  }
}
