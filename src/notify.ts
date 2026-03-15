import { execSync } from "node:child_process";
import { loadConfig, type NotificationConfig } from "./config.js";
import { debug } from "./debug.js";

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

  try {
    execSync(
      `terminal-notifier -title ${JSON.stringify(title)} -message ${JSON.stringify(message)} -sound default`,
      { stdio: "ignore", timeout: 3000 }
    );
    debug(`notification: ${message}`, "notify");
  } catch {
    // terminal-notifier not installed or failed — try osascript fallback
    try {
      execSync(
        `osascript -e 'display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}'`,
        { stdio: "ignore", timeout: 3000 }
      );
    } catch {
      // No notification system available — skip silently
    }
  }
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
