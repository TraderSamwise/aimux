import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./atomic-write.js";
import { getNotificationContextPath } from "./paths.js";
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

function loadState(): NotificationContextState {
  const path = getNotificationContextPath();
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

function saveState(state: NotificationContextState): void {
  writeJsonAtomic(getNotificationContextPath(), state);
}

function isFresh(entry: NotificationContextEntry | undefined): boolean {
  if (!entry?.updatedAt) return false;
  const updated = Date.parse(entry.updatedAt);
  return Number.isFinite(updated) && Date.now() - updated <= CONTEXT_FRESH_MS;
}

export function updateNotificationContext(
  source: NotificationContextSource,
  patch: Partial<Omit<NotificationContextEntry, "source" | "updatedAt">>,
): NotificationContextEntry {
  const state = loadState();
  const next: NotificationContextEntry = {
    source,
    focused: patch.focused ?? state.contexts[source]?.focused ?? false,
    screen: patch.screen ?? state.contexts[source]?.screen,
    sessionId: patch.sessionId ?? state.contexts[source]?.sessionId,
    panelOpen: patch.panelOpen ?? state.contexts[source]?.panelOpen ?? false,
    updatedAt: new Date().toISOString(),
  };
  state.contexts[source] = next;
  saveState(state);
  return next;
}

export function loadNotificationContexts(): NotificationContextState {
  return loadState();
}

export function isSessionNotificationFocused(sessionId: string): boolean {
  if (!sessionId) return false;
  const { contexts } = loadState();
  for (const entry of Object.values(contexts)) {
    if (!entry || !isFresh(entry) || !entry.focused) continue;
    if (entry.sessionId === sessionId) return true;
  }
  return false;
}

export function shouldSuppressNotification(event: AlertEvent): boolean {
  if (event.forceNotify) return false;
  const { contexts } = loadState();
  for (const entry of Object.values(contexts)) {
    if (!entry || !isFresh(entry) || !entry.focused) continue;
    if (entry.panelOpen) return true;
    if (event.sessionId && entry.sessionId && entry.sessionId === event.sessionId) return true;
    if (!event.sessionId && entry.screen) return true;
  }
  return false;
}
