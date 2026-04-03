import { getProjectId } from "./paths.js";
import { addNotification } from "./notifications.js";

export type AlertKind =
  | "notification"
  | "needs_input"
  | "task_done"
  | "task_failed"
  | "blocked"
  | "message_waiting"
  | "handoff_waiting"
  | "task_assigned"
  | "review_waiting";

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
}

export interface HistoryUpdateEvent {
  type: "history_update";
  projectId: string;
  sessionId: string;
  ts: string;
  messages: unknown[];
  lastN?: number;
}

export type ProjectStreamEvent = AlertEvent | HistoryUpdateEvent;

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

  publishHistoryUpdate(input: Omit<HistoryUpdateEvent, "type" | "projectId" | "ts">): void {
    this.publish({
      type: "history_update",
      projectId: getProjectId(),
      ts: new Date().toISOString(),
      sessionId: input.sessionId,
      messages: input.messages,
      lastN: input.lastN,
    });
  }

  publishAlert(
    alert: Omit<AlertEvent, "type" | "projectId" | "ts"> & {
      dedupeKey?: string;
      cooldownMs?: number;
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
    } satisfies AlertEvent;

    addNotification({
      title: event.title,
      body: event.message,
      sessionId: event.sessionId,
      kind: event.kind,
      dedupeKey: event.dedupeKey,
      createdAt: event.ts,
    });

    this.publish(event);
    return true;
  }
}
