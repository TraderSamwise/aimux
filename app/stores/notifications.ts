import { atom } from "jotai";
import { atomFamily, atomWithStorage, unwrap } from "jotai/utils";
import type { NotificationRecord } from "@/lib/api";
import { createSsrSafeJsonStorage } from "@/lib/jotai-storage";

export interface ProjectNotificationFeed {
  notifications: NotificationRecord[];
  unreadCount: number;
  fetchedAt: string;
}

export interface NotificationFeedResource {
  value: ProjectNotificationFeed | null;
  error: string | null;
  pending: boolean;
  stale: boolean;
  updatedAt: number | null;
}

export interface ApplyNotificationFeedSuccessInput {
  projectPath: string;
  feed: ProjectNotificationFeed;
  updatedAt?: number;
}

export interface ApplyNotificationFeedFailureInput {
  projectPath: string;
  error: string;
}

const emptyNotificationFeedResource = (): NotificationFeedResource => ({
  value: null,
  error: null,
  pending: false,
  stale: false,
  updatedAt: null,
});

export const NOTIFICATION_LOCAL_UNREAD_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export interface NotificationLocalReadState {
  readAtByKey: Record<string, string>;
}

const defaultNotificationLocalReadState: NotificationLocalReadState = { readAtByKey: {} };

const asyncNotificationLocalReadStateAtom = atomWithStorage<NotificationLocalReadState>(
  "aimux-notification-read-state",
  defaultNotificationLocalReadState,
  createSsrSafeJsonStorage<NotificationLocalReadState>(),
  { getOnInit: true },
);

export const notificationLocalReadStateAtom = unwrap(
  asyncNotificationLocalReadStateAtom,
  (previous) => previous ?? defaultNotificationLocalReadState,
);

export function notificationLocalReadKey(
  projectPath: string | null | undefined,
  notificationId: string | null | undefined,
): string | null {
  const normalizedProjectPath = projectPath?.trim();
  const normalizedNotificationId = notificationId?.trim();
  if (!normalizedProjectPath || !normalizedNotificationId) return null;
  return `${normalizedProjectPath}\u0000${normalizedNotificationId}`;
}

function notificationIsInsideUnreadWindow(
  notification: NotificationRecord,
  nowMs: number,
): boolean {
  const createdAtMs = Date.parse(notification.createdAt);
  if (!Number.isFinite(createdAtMs)) return true;
  return nowMs - createdAtMs <= NOTIFICATION_LOCAL_UNREAD_WINDOW_MS;
}

export function notificationEffectiveUnread(input: {
  projectPath: string | null | undefined;
  notification: NotificationRecord;
  readState: NotificationLocalReadState;
  nowMs?: number;
}): boolean {
  const { projectPath, notification, readState, nowMs = Date.now() } = input;
  if (!notification.unread) return false;
  if (!notificationIsInsideUnreadWindow(notification, nowMs)) return false;
  const key = notificationLocalReadKey(projectPath, notification.id);
  return key ? !readState.readAtByKey[key] : true;
}

export function applyNotificationLocalReadState(
  projectPath: string | null | undefined,
  notifications: NotificationRecord[],
  readState: NotificationLocalReadState,
  nowMs = Date.now(),
): NotificationRecord[] {
  return notifications.map((notification) => {
    const unread = notificationEffectiveUnread({ projectPath, notification, readState, nowMs });
    return unread === notification.unread ? notification : { ...notification, unread };
  });
}

function pruneReadAtByKey(
  readAtByKey: Record<string, string>,
  nowMs: number,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, readAt] of Object.entries(readAtByKey)) {
    const readAtMs = Date.parse(readAt);
    if (!Number.isFinite(readAtMs) || nowMs - readAtMs <= NOTIFICATION_LOCAL_UNREAD_WINDOW_MS) {
      next[key] = readAt;
    }
  }
  return next;
}

export const markNotificationRecordsReadLocalAtom = atom(
  null,
  (
    get,
    set,
    input: {
      projectPath: string | null | undefined;
      ids: Iterable<string | null | undefined>;
      readAt?: string;
    },
  ) => {
    const nowMs = Date.now();
    const readAt = input.readAt ?? new Date(nowMs).toISOString();
    const previous = get(notificationLocalReadStateAtom);
    const readAtByKey = pruneReadAtByKey(previous.readAtByKey, nowMs);
    let changed = false;
    for (const id of input.ids) {
      const key = notificationLocalReadKey(input.projectPath, id);
      if (!key || readAtByKey[key] === readAt) continue;
      readAtByKey[key] = readAt;
      changed = true;
    }
    if (changed) set(asyncNotificationLocalReadStateAtom, { readAtByKey });
  },
);

export const notificationFeedResourceFamily = atomFamily((_projectPath: string) =>
  atom<NotificationFeedResource>(emptyNotificationFeedResource()),
);

export const notificationFeedFamily = atomFamily((projectPath: string) =>
  atom(
    (get) => get(notificationFeedResourceFamily(projectPath)).value,
    (get, set, value: ProjectNotificationFeed | null) => {
      const current = get(notificationFeedResourceFamily(projectPath));
      set(notificationFeedResourceFamily(projectPath), {
        ...current,
        value,
        error: value ? null : current.error,
        pending: false,
        stale: false,
        updatedAt: value ? Date.now() : current.updatedAt,
      });
    },
  ),
);

export const notificationFeedErrorFamily = atomFamily((projectPath: string) =>
  atom(
    (get) => get(notificationFeedResourceFamily(projectPath)).error,
    (get, set, error: string | null) => {
      const current = get(notificationFeedResourceFamily(projectPath));
      set(notificationFeedResourceFamily(projectPath), {
        ...current,
        error,
      });
    },
  ),
);

export const notificationObservedIdsFamily = atomFamily((_projectPath: string) =>
  atom<ReadonlySet<string>>(new Set<string>()),
);

export const markNotificationRecordsObservedAtom = atom(
  null,
  (get, set, input: { projectPath: string; ids: Iterable<string | undefined> }) => {
    const projectPath = input.projectPath.trim();
    if (!projectPath) return;
    const scopedAtom = notificationObservedIdsFamily(projectPath);
    const previous = get(scopedAtom);
    const next = new Set(previous);
    let changed = false;
    for (const id of input.ids) {
      const normalized = id?.trim();
      if (!normalized || next.has(normalized)) continue;
      next.add(normalized);
      changed = true;
    }
    if (changed) set(scopedAtom, next);
  },
);

export const notificationFeedRefreshNonceAtom = atom(0);

export const kickNotificationFeedRefreshAtom = atom(null, (get, set) => {
  set(notificationFeedRefreshNonceAtom, get(notificationFeedRefreshNonceAtom) + 1);
});

export const beginNotificationFeedRefreshAtom = atom(null, (get, set, projectPath: string) => {
  const current = get(notificationFeedResourceFamily(projectPath));
  set(notificationFeedResourceFamily(projectPath), {
    ...current,
    error: null,
    pending: true,
    stale: current.value !== null,
  });
});

export const applyNotificationFeedSuccessAtom = atom(
  null,
  (_get, set, { projectPath, feed, updatedAt }: ApplyNotificationFeedSuccessInput) => {
    set(notificationFeedResourceFamily(projectPath), {
      value: feed,
      error: null,
      pending: false,
      stale: false,
      updatedAt: updatedAt ?? Date.now(),
    });
  },
);

export const applyNotificationFeedFailureAtom = atom(
  null,
  (get, set, { projectPath, error }: ApplyNotificationFeedFailureInput) => {
    const current = get(notificationFeedResourceFamily(projectPath));
    set(notificationFeedResourceFamily(projectPath), {
      ...current,
      error,
      pending: false,
      stale: current.value !== null,
    });
  },
);

export const clearNotificationFeedResourceAtom = atom(null, (_get, set, projectPath: string) => {
  set(notificationFeedResourceFamily(projectPath), emptyNotificationFeedResource());
});

export const notificationUnreadCountFamily = atomFamily((projectPath: string) =>
  atom((get) => get(notificationFeedFamily(projectPath))?.unreadCount ?? 0),
);
