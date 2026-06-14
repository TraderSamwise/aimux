import { loadConfig, type NotificationConfig } from "./config.js";
import { debug } from "./debug.js";
import type { AlertEvent } from "./project-events.js";
import { shouldSuppressNotification } from "./notification-context.js";
import { forwardAlertToMobilePush } from "./mobile-push-bridge.js";
import { sendDesktopNotification } from "./desktop-notifier.js";

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

  sendDesktopNotification({ title, message, sound: true });
  debug(`notification: ${message}`, "notify");
}

function sendSecurity(title: string, message: string): void {
  sendDesktopNotification({ title, message, sound: true });
  debug(`security notification: ${message}`, "notify");
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

export function notifyAlert(event: AlertEvent): boolean {
  const config = getNotifyConfig();
  if (!config.enabled) return false;
  if (shouldSuppressNotification(event)) return false;
  if (event.kind === "interaction_request" && event.interaction?.telemetry) return false;

  if (
    (event.kind === "notification" ||
      event.kind === "needs_input" ||
      event.kind === "message_waiting" ||
      event.kind === "handoff_waiting" ||
      event.kind === "task_assigned" ||
      event.kind === "review_waiting" ||
      event.kind === "interaction_request") &&
    !config.onPrompt
  ) {
    return false;
  }
  if (event.kind === "task_done" && !config.onComplete) return false;
  if ((event.kind === "task_failed" || event.kind === "blocked") && !config.onError) return false;

  send(event.title || "aimux", event.message || event.sessionId || event.kind);
  forwardAlertToMobilePush(event);
  return true;
}

export function notifyRemoteClientConnected(input: { title?: unknown; body?: unknown }): void {
  const title = typeof input.title === "string" && input.title.trim().length > 0 ? input.title : "aimux remote access";
  const body = typeof input.body === "string" && input.body.trim().length > 0 ? input.body : "Remote client connected";
  sendSecurity(title, body);
}
