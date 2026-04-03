import notifier from "node-notifier";
import { loadConfig, type NotificationConfig } from "./config.js";
import { debug } from "./debug.js";
import type { AlertEvent } from "./project-events.js";
import { shouldSuppressNotification } from "./notification-context.js";

let cachedConfig: NotificationConfig | null = null;

function getNotifyConfig(): NotificationConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig().notifications;
  }
  return cachedConfig;
}

/** Reset cached config (call when config may have changed) */
export function resetNotifyConfig(): void {
  cachedConfig = null;
}

function send(title: string, message: string): void {
  const config = getNotifyConfig();
  if (!config.enabled) return;

  notifier.notify({ title, message, sound: true });
  debug(`notification: ${message}`, "notify");
}

/** Notify that an agent is waiting for input */
export function notifyPrompt(sessionId: string): void {
  if (!getNotifyConfig().onPrompt) return;
  send("aimux", `${sessionId} is waiting for input`);
}

/** Notify on agent error */
export function notifyError(sessionId: string, message?: string): void {
  if (!getNotifyConfig().onError) return;
  send("aimux", `${sessionId} error${message ? `: ${message}` : ""}`);
}

/** Notify that an agent completed (exited cleanly) */
export function notifyComplete(sessionId: string): void {
  if (!getNotifyConfig().onComplete) return;
  send("aimux", `${sessionId} finished`);
}

export function notifyAlert(event: AlertEvent): void {
  const config = getNotifyConfig();
  if (!config.enabled) return;
  if (shouldSuppressNotification(event)) return;

  if (
    (event.kind === "notification" ||
      event.kind === "needs_input" ||
      event.kind === "message_waiting" ||
      event.kind === "handoff_waiting" ||
      event.kind === "task_assigned" ||
      event.kind === "review_waiting") &&
    !config.onPrompt
  ) {
    return;
  }
  if (event.kind === "task_done" && !config.onComplete) return;
  if ((event.kind === "task_failed" || event.kind === "blocked") && !config.onError) return;

  send(event.title || "aimux", event.message || event.sessionId || event.kind);
}
