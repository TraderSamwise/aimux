import { randomUUID } from "node:crypto";
import { deriveRuntimeExchangeIndexes } from "./runtime-core/exchange-derived.js";
import {
  createRuntimeExchangeStore,
  type RuntimeExchange,
  type RuntimeExchangeInboxEntry,
  type RuntimeExchangeMessage,
  type RuntimeExchangeThread,
} from "./runtime-core/exchange-store.js";

export interface NotificationRecord {
  id: string;
  title: string;
  subtitle?: string;
  body: string;
  sessionId?: string;
  targetKey?: string;
  targetKind?: "session" | "generic";
  kind?: string;
  unread: boolean;
  cleared: boolean;
  createdAt: string;
  updatedAt: string;
  dedupeKey?: string;
}

const PROJECT_NOTIFICATION_PARTICIPANT = "project";
const NOTIFICATION_TAG = "notification";

function normalizeTargetKey(input: { targetKey?: string; sessionId?: string }): string | undefined {
  const targetKey = input.targetKey?.trim();
  if (targetKey) return targetKey;
  const sessionId = input.sessionId?.trim();
  return sessionId ? `session:${sessionId}` : undefined;
}

function normalizeTargetKind(input: {
  targetKind?: "session" | "generic";
  sessionId?: string;
}): "session" | "generic" | undefined {
  if (input.targetKind) return input.targetKind;
  return input.sessionId?.trim() ? "session" : "generic";
}

function metadataString(message: RuntimeExchangeMessage | undefined, key: string): string | undefined {
  const value = message?.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function metadataBoolean(message: RuntimeExchangeMessage | undefined, key: string): boolean {
  return message?.metadata?.[key] === true;
}

function notificationThreadId(targetKey?: string): string {
  if (!targetKey) return `notification-${randomUUID()}`;
  return `notification-${Buffer.from(targetKey).toString("base64url")}`;
}

function threadLatestMessage(exchange: RuntimeExchange, threadId: string): RuntimeExchangeMessage | undefined {
  return exchange.messages
    .filter((message) => message.threadId === threadId)
    .sort((a, b) => b.ts.localeCompare(a.ts))[0];
}

function entryForThread(
  exchange: RuntimeExchange,
  thread: RuntimeExchangeThread,
): RuntimeExchangeInboxEntry | undefined {
  return exchange.inbox.find((entry) => entry.subjectKind === "thread" && entry.subjectId === thread.id);
}

function notificationRecord(
  exchange: RuntimeExchange,
  thread: RuntimeExchangeThread,
  message: RuntimeExchangeMessage,
): NotificationRecord {
  const entry = entryForThread(exchange, thread);
  const sessionId = metadataString(message, "notificationSessionId");
  const targetKey = metadataString(message, "notificationTargetKey");
  const targetKind = metadataString(message, "notificationTargetKind") as "session" | "generic" | undefined;
  return {
    id: metadataString(message, "notificationRecordId") ?? thread.id,
    title: thread.title,
    subtitle: metadataString(message, "notificationSubtitle"),
    body: message.body,
    sessionId,
    targetKey,
    targetKind,
    kind: metadataString(message, "notificationKind"),
    unread: Boolean(entry && entry.state !== "done"),
    cleared: metadataBoolean(message, "notificationCleared"),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    dedupeKey: metadataString(message, "notificationDedupeKey"),
  };
}

function notificationRecords(exchange = createRuntimeExchangeStore().read()): NotificationRecord[] {
  return exchange.threads
    .filter((thread) => thread.tags?.includes(NOTIFICATION_TAG))
    .map((thread) => {
      const message = threadLatestMessage(exchange, thread.id);
      return message ? notificationRecord(exchange, thread, message) : undefined;
    })
    .filter((record): record is NotificationRecord => Boolean(record))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function writeNotification(input: {
  title: string;
  subtitle?: string;
  body: string;
  sessionId?: string;
  targetKey?: string;
  targetKind?: "session" | "generic";
  kind?: string;
  dedupeKey?: string;
  createdAt?: string;
  unread?: boolean;
  replaceTarget?: boolean;
}): NotificationRecord {
  const now = input.createdAt ?? new Date().toISOString();
  const sessionId = input.sessionId?.trim() || undefined;
  const targetKey = normalizeTargetKey(input);
  const targetKind = normalizeTargetKind(input);
  const threadId = input.replaceTarget ? notificationThreadId(targetKey) : notificationThreadId();
  const participantId = sessionId ?? PROJECT_NOTIFICATION_PARTICIPANT;
  const thread: RuntimeExchangeThread = {
    id: threadId,
    title: input.title.trim() || "aimux",
    kind: "conversation",
    status: "open",
    createdAt: now,
    updatedAt: now,
    createdBy: "aimux",
    participants: ["aimux", participantId],
    lastMessageId: `message-${threadId}`,
    unreadBy: input.unread === false ? [] : [participantId],
    tags: [NOTIFICATION_TAG],
  };
  const message: RuntimeExchangeMessage = {
    id: `message-${threadId}`,
    threadId,
    ts: now,
    from: "aimux",
    to: [participantId],
    kind: "note",
    body: input.body.trim() || input.title.trim() || "aimux",
    metadata: {
      notificationRecordId: randomUUID(),
      notificationSubtitle: input.subtitle?.trim() || null,
      notificationSessionId: sessionId ?? null,
      notificationTargetKey: targetKey ?? null,
      notificationTargetKind: targetKind ?? null,
      notificationKind: input.kind?.trim() || null,
      notificationDedupeKey: input.dedupeKey?.trim() || null,
      notificationCleared: false,
    },
  };
  let record: NotificationRecord | undefined;
  createRuntimeExchangeStore().update((exchange) => {
    const next = deriveRuntimeExchangeIndexes({
      ...exchange,
      generatedAt: now,
      threads: [...exchange.threads.filter((existing) => existing.id !== threadId), thread],
      messages: [...exchange.messages.filter((existing) => existing.threadId !== threadId), message],
    });
    const inbox =
      input.unread === false
        ? next.inbox.map((entry) =>
            entry.subjectKind === "thread" && entry.subjectId === threadId
              ? { ...entry, state: "done" as const }
              : entry,
          )
        : next.inbox;
    const updated = { ...next, inbox };
    record = notificationRecord(updated, thread, message);
    return updated;
  });
  if (!record) throw new Error("failed to write notification");
  return record;
}

export function addNotification(input: {
  title: string;
  subtitle?: string;
  body: string;
  sessionId?: string;
  targetKey?: string;
  targetKind?: "session" | "generic";
  kind?: string;
  dedupeKey?: string;
  createdAt?: string;
  unread?: boolean;
}): NotificationRecord {
  return writeNotification(input);
}

export function upsertNotification(input: {
  title: string;
  subtitle?: string;
  body: string;
  sessionId?: string;
  targetKey?: string;
  targetKind?: "session" | "generic";
  kind?: string;
  dedupeKey?: string;
  createdAt?: string;
  unread?: boolean;
}): NotificationRecord {
  return writeNotification({ ...input, replaceTarget: Boolean(normalizeTargetKey(input)) });
}

export function listNotifications(opts?: {
  unreadOnly?: boolean;
  includeCleared?: boolean;
  sessionId?: string;
}): NotificationRecord[] {
  return notificationRecords().filter((record) => {
    if (!opts?.includeCleared && record.cleared) return false;
    if (opts?.unreadOnly && !record.unread) return false;
    if (opts?.sessionId && record.sessionId !== opts.sessionId) return false;
    return true;
  });
}

export function markNotificationsRead(opts?: { id?: string; sessionId?: string }): number {
  const store = createRuntimeExchangeStore();
  const records = notificationRecords(store.read()).filter((record) => {
    if (record.cleared || !record.unread) return false;
    if (opts?.id && record.id !== opts.id) return false;
    if (opts?.sessionId && record.sessionId !== opts.sessionId) return false;
    return true;
  });
  if (records.length === 0) return 0;
  const threadIds = new Set(
    records
      .map((record) => {
        const exchange = store.read();
        return exchange.threads.find((thread) => {
          const message = threadLatestMessage(exchange, thread.id);
          return message && notificationRecord(exchange, thread, message).id === record.id;
        })?.id;
      })
      .filter((id): id is string => Boolean(id)),
  );
  store.update((exchange) => ({
    ...exchange,
    inbox: exchange.inbox.map((entry) =>
      entry.subjectKind === "thread" && threadIds.has(entry.subjectId) ? { ...entry, state: "done" } : entry,
    ),
  }));
  return records.length;
}

export function clearNotifications(opts?: { id?: string; sessionId?: string }): number {
  const store = createRuntimeExchangeStore();
  const records = notificationRecords(store.read()).filter((record) => {
    if (record.cleared) return false;
    if (opts?.id && record.id !== opts.id) return false;
    if (opts?.sessionId && record.sessionId !== opts.sessionId) return false;
    return true;
  });
  if (records.length === 0) return 0;
  const recordIds = new Set(records.map((record) => record.id));
  store.update((exchange) => {
    const threadIds = new Set(
      exchange.threads
        .map((thread) => {
          const message = threadLatestMessage(exchange, thread.id);
          return message && recordIds.has(notificationRecord(exchange, thread, message).id) ? thread.id : undefined;
        })
        .filter((id): id is string => Boolean(id)),
    );
    return {
      ...exchange,
      messages: exchange.messages.map((message) =>
        message.threadId && threadIds.has(message.threadId)
          ? { ...message, metadata: { ...(message.metadata ?? {}), notificationCleared: true } }
          : message,
      ),
      inbox: exchange.inbox.map((entry) =>
        entry.subjectKind === "thread" && threadIds.has(entry.subjectId) ? { ...entry, state: "done" } : entry,
      ),
    };
  });
  return records.length;
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
