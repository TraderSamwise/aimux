import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getNotificationsPath } from "./paths.js";

export interface NotificationRecord {
  id: string;
  title: string;
  subtitle?: string;
  body: string;
  sessionId?: string;
  kind?: string;
  unread: boolean;
  cleared: boolean;
  createdAt: string;
  updatedAt: string;
  dedupeKey?: string;
}

interface NotificationState {
  version: 1;
  notifications: NotificationRecord[];
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function loadState(): NotificationState {
  const path = getNotificationsPath();
  if (!existsSync(path)) return { version: 1, notifications: [] };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as NotificationState;
    if (parsed.version !== 1 || !Array.isArray(parsed.notifications)) {
      return { version: 1, notifications: [] };
    }
    return parsed;
  } catch {
    return { version: 1, notifications: [] };
  }
}

function saveState(state: NotificationState): void {
  const path = getNotificationsPath();
  ensureParent(path);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

export function addNotification(input: {
  title: string;
  subtitle?: string;
  body: string;
  sessionId?: string;
  kind?: string;
  dedupeKey?: string;
  createdAt?: string;
}): NotificationRecord {
  const now = input.createdAt ?? new Date().toISOString();
  const state = loadState();
  const record: NotificationRecord = {
    id: randomUUID(),
    title: input.title.trim() || "aimux",
    subtitle: input.subtitle?.trim() || undefined,
    body: input.body.trim() || input.title.trim() || "aimux",
    sessionId: input.sessionId?.trim() || undefined,
    kind: input.kind?.trim() || undefined,
    unread: true,
    cleared: false,
    createdAt: now,
    updatedAt: now,
    dedupeKey: input.dedupeKey?.trim() || undefined,
  };
  state.notifications.unshift(record);
  saveState(state);
  return record;
}

export function listNotifications(opts?: {
  unreadOnly?: boolean;
  includeCleared?: boolean;
  sessionId?: string;
}): NotificationRecord[] {
  const state = loadState();
  return state.notifications.filter((record) => {
    if (!opts?.includeCleared && record.cleared) return false;
    if (opts?.unreadOnly && !record.unread) return false;
    if (opts?.sessionId && record.sessionId !== opts.sessionId) return false;
    return true;
  });
}

export function markNotificationsRead(opts?: { id?: string; sessionId?: string }): number {
  const state = loadState();
  let changed = 0;
  const now = new Date().toISOString();
  state.notifications = state.notifications.map((record) => {
    if (record.cleared || !record.unread) return record;
    const matchesId = opts?.id ? record.id === opts.id : true;
    const matchesSession = opts?.sessionId ? record.sessionId === opts.sessionId : true;
    if (!matchesId || !matchesSession) return record;
    changed += 1;
    return {
      ...record,
      unread: false,
      updatedAt: now,
    };
  });
  if (changed > 0) saveState(state);
  return changed;
}

export function clearNotifications(opts?: { id?: string; sessionId?: string }): number {
  const state = loadState();
  let changed = 0;
  const now = new Date().toISOString();
  state.notifications = state.notifications.map((record) => {
    if (record.cleared) return record;
    const matchesId = opts?.id ? record.id === opts.id : true;
    const matchesSession = opts?.sessionId ? record.sessionId === opts.sessionId : true;
    if (!matchesId || !matchesSession) return record;
    changed += 1;
    return {
      ...record,
      unread: false,
      cleared: true,
      updatedAt: now,
    };
  });
  if (changed > 0) saveState(state);
  return changed;
}

export function unreadNotificationCount(opts?: { sessionId?: string }): number {
  return listNotifications({ unreadOnly: true, sessionId: opts?.sessionId }).length;
}

export interface SessionNotificationSummary {
  unreadCount: number;
  latestUnread?: NotificationRecord;
}

export function summarizeUnreadNotificationsBySession(): Map<string, SessionNotificationSummary> {
  const summaries = new Map<string, SessionNotificationSummary>();
  for (const notification of listNotifications({ unreadOnly: true })) {
    if (!notification.sessionId) continue;
    const current = summaries.get(notification.sessionId);
    if (!current) {
      summaries.set(notification.sessionId, {
        unreadCount: 1,
        latestUnread: notification,
      });
      continue;
    }
    current.unreadCount += 1;
    if (!current.latestUnread || Date.parse(notification.createdAt) > Date.parse(current.latestUnread.createdAt)) {
      current.latestUnread = notification;
    }
  }
  return summaries;
}
