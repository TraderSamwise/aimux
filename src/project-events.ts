import { getProjectId } from "./paths.js";
import { upsertNotification } from "./notifications.js";
import { isSessionNotificationFocused } from "./notification-context.js";
import type { InteractionType } from "./interaction-requests.js";
import {
  PROJECT_API_EVENT_NAMES,
  PROJECT_API_VIEWS,
  type ProjectApiView,
  type ProjectUpdateEvent,
} from "./project-api-contract.js";

export type AlertKind =
  | "notification"
  | "needs_input"
  | "next_step"
  | "task_done"
  | "task_failed"
  | "blocked"
  | "message_waiting"
  | "handoff_waiting"
  | "task_assigned"
  | "review_waiting"
  | "interaction_request";

export interface AlertEvent {
  type: typeof PROJECT_API_EVENT_NAMES.alert;
  kind: AlertKind;
  projectId: string;
  sessionId?: string;
  title: string;
  message: string;
  ts: string;
  notificationId?: string;
  projectName?: string;
  projectRoot?: string;
  threadId?: string;
  taskId?: string;
  worktreePath?: string;
  worktreeName?: string;
  branch?: string;
  categoryLabel?: string;
  reasonLabel?: string;
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

export type ProjectStreamEvent = AlertEvent | ProjectUpdateEvent;

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

  publishProjectUpdate(
    input: {
      views?: ProjectApiView[];
      reason?: string;
      sessionId?: string;
      worktreePath?: string;
    } = {},
  ): void {
    const views = input.views?.length ? input.views : [...PROJECT_API_VIEWS];
    this.publish({
      type: PROJECT_API_EVENT_NAMES.projectUpdate,
      projectId: getProjectId(),
      ts: new Date().toISOString(),
      views,
      reason: input.reason,
      sessionId: input.sessionId,
      worktreePath: input.worktreePath,
    });
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

    const ts = new Date().toISOString();
    const notification = upsertNotification({
      title: alert.title,
      body: alert.message,
      sessionId: alert.sessionId,
      kind: alert.kind,
      projectName: alert.projectName,
      projectRoot: alert.projectRoot,
      worktreePath: alert.worktreePath,
      worktreeName: alert.worktreeName,
      branch: alert.branch,
      categoryLabel: alert.categoryLabel,
      reasonLabel: alert.reasonLabel,
      dedupeKey,
      createdAt: ts,
      unread:
        !alert.sessionId || alert.forceNotify
          ? true
          : !isSessionNotificationFocused(alert.sessionId, alert.projectRoot),
      interaction: alert.interaction,
    });

    const event = {
      type: PROJECT_API_EVENT_NAMES.alert,
      projectId: getProjectId(),
      ts,
      kind: alert.kind,
      sessionId: alert.sessionId,
      title: alert.title,
      message: alert.message,
      notificationId: notification.id,
      projectName: alert.projectName,
      projectRoot: alert.projectRoot,
      threadId: alert.threadId,
      taskId: alert.taskId,
      worktreePath: alert.worktreePath,
      worktreeName: alert.worktreeName,
      branch: alert.branch,
      categoryLabel: alert.categoryLabel,
      reasonLabel: alert.reasonLabel,
      dedupeKey,
      forceNotify: alert.forceNotify,
      interaction: alert.interaction,
    } satisfies AlertEvent;

    this.publish(event);
    this.publishProjectUpdate({
      views: ["coordination-worklist", "notifications"],
      reason: "alert",
      sessionId: alert.sessionId,
      worktreePath: alert.worktreePath,
    });
    return true;
  }
}
