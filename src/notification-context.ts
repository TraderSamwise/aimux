import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./atomic-write.js";
import { getNotificationContextPath, getReadOnlyProjectPathsFor } from "./paths.js";
import type { AlertEvent } from "./project-events.js";

export type NotificationContextSource = "desktop" | "tui";

export interface NotificationContextEntry {
  source: NotificationContextSource;
  focused: boolean;
  screen?: string;
  sessionId?: string;
  panelOpen?: boolean;
  updatedAt: string;
}

interface NotificationContextState {
  version: 1;
  contexts: Partial<Record<NotificationContextSource, NotificationContextEntry>>;
}

// Active direct-chat panes can stay in focus for minutes without any explicit
// context refresh, so a 30s expiry causes long Codex/Claude back-and-forth
// sessions to start accumulating "unread" as if they were backgrounded.
const CONTEXT_FRESH_MS = 15 * 60_000;

function notificationContextPath(projectRoot?: string): string {
  return projectRoot?.trim()
    ? getReadOnlyProjectPathsFor(projectRoot).notificationContextPath
    : getNotificationContextPath();
}

function loadState(projectRoot?: string): NotificationContextState {
  const path = notificationContextPath(projectRoot);
  if (!existsSync(path)) return { version: 1, contexts: {} };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as NotificationContextState;
    if (parsed.version !== 1 || !parsed.contexts || typeof parsed.contexts !== "object") {
      return { version: 1, contexts: {} };
    }
    return parsed;
  } catch {
    return { version: 1, contexts: {} };
  }
}

function saveState(state: NotificationContextState, projectRoot?: string): void {
  writeJsonAtomic(notificationContextPath(projectRoot), state);
}

function isFresh(entry: NotificationContextEntry | undefined): boolean {
  if (!entry?.updatedAt) return false;
  const updated = Date.parse(entry.updatedAt);
  return Number.isFinite(updated) && Date.now() - updated <= CONTEXT_FRESH_MS;
}

function isDirectSessionFocus(entry: NotificationContextEntry, sessionId: string): boolean {
  return entry.sessionId === sessionId && entry.screen !== "dashboard" && !entry.panelOpen;
}

export function updateNotificationContext(
  source: NotificationContextSource,
  patch: Partial<Omit<NotificationContextEntry, "source" | "updatedAt">>,
  projectRoot?: string,
): NotificationContextEntry {
  const state = loadState(projectRoot);
  const previous = state.contexts[source];
  const has = (key: keyof typeof patch) => Object.prototype.hasOwnProperty.call(patch, key);
  const nextSessionId = has("sessionId") ? patch.sessionId : previous?.sessionId;
  const nextScreen = has("screen") ? patch.screen : has("sessionId") && nextSessionId ? "session" : previous?.screen;
  const next: NotificationContextEntry = {
    source,
    focused: has("focused") ? (patch.focused ?? false) : (previous?.focused ?? false),
    screen: nextScreen,
    sessionId: nextSessionId,
    panelOpen: has("panelOpen") ? (patch.panelOpen ?? false) : (previous?.panelOpen ?? false),
    updatedAt: new Date().toISOString(),
  };
  state.contexts[source] = next;
  saveState(state, projectRoot);
  return next;
}

export function loadNotificationContexts(projectRoot?: string): NotificationContextState {
  return loadState(projectRoot);
}

export function isSessionNotificationFocused(sessionId: string, projectRoot?: string): boolean {
  if (!sessionId) return false;
  const { contexts } = loadState(projectRoot);
  for (const entry of Object.values(contexts)) {
    if (!entry || !isFresh(entry) || !entry.focused) continue;
    if (isDirectSessionFocus(entry, sessionId)) return true;
  }
  return false;
}

export function shouldSuppressNotification(event: AlertEvent, projectRoot?: string): boolean {
  if (event.forceNotify) return false;
  const { contexts } = loadState(projectRoot);
  for (const entry of Object.values(contexts)) {
    if (!entry || !isFresh(entry) || !entry.focused) continue;
    if (event.sessionId && isDirectSessionFocus(entry, event.sessionId)) return true;
    if (!event.sessionId && entry.screen && entry.screen !== "dashboard" && !entry.panelOpen) return true;
  }
  return false;
}
