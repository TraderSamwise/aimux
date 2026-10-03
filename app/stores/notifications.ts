import { atom } from "jotai";
import { parseProjectKey, type ProjectStateKey } from "@/lib/project-key";
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
  projectStateKey: ProjectStateKey;
  feed: ProjectNotificationFeed;
  updatedAt?: number;
}

export interface ApplyNotificationFeedFailureInput {
  projectStateKey: ProjectStateKey;
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
  projectStateKey: string | null | undefined,
  notificationId: string | null | undefined,
): string | null {
  const normalizedProjectStateKey = projectStateKey?.trim();
  const normalizedNotificationId = notificationId?.trim();
  if (!normalizedProjectStateKey || !normalizedNotificationId) return null;
  return `${normalizedProjectStateKey}\u0000${normalizedNotificationId}`;
}

// What a build before machines existed wrote: the project PATH and the id.
//
// These marks are read-only and never written again, because a mark must now
// say which machine. Without reading them, every notification Sam had read in
// the last three days would come back unread the moment the app updated.
export function legacyNotificationLocalReadKey(
  projectStateKey: string | null | undefined,
  notificationId: string | null | undefined,
): string | null {
  const ref = parseProjectKey(projectStateKey);
  if (!ref) return null;
  const normalizedNotificationId = notificationId?.trim();
  if (!normalizedNotificationId) return null;
  return `${ref.path}\u0000${normalizedNotificationId}`;
}

function notificationWasReadLocally(
  readState: NotificationLocalReadState,
  projectStateKey: string | null | undefined,
  notificationId: string | null | undefined,
): boolean {
  const key = notificationLocalReadKey(projectStateKey, notificationId);
  if (key && readState.readAtByKey[key]) return true;
  const legacy = legacyNotificationLocalReadKey(projectStateKey, notificationId);
  return Boolean(legacy && readState.readAtByKey[legacy]);
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
  projectStateKey: string | null | undefined;
  notification: NotificationRecord;
  readState: NotificationLocalReadState;
  nowMs?: number;
}): boolean {
  const { projectStateKey, notification, readState, nowMs = Date.now() } = input;
  if (!notification.unread) return false;
  if (!notificationIsInsideUnreadWindow(notification, nowMs)) return false;
  if (!notificationLocalReadKey(projectStateKey, notification.id)) return true;
  return !notificationWasReadLocally(readState, projectStateKey, notification.id);
}

export function applyNotificationLocalReadState(
  projectStateKey: string | null | undefined,
  notifications: NotificationRecord[],
  readState: NotificationLocalReadState,
  nowMs = Date.now(),
): NotificationRecord[] {
  return notifications.map((notification) => {
    const unread = notificationEffectiveUnread({ projectStateKey, notification, readState, nowMs });
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
      projectStateKey: string | null | undefined;
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
      const key = notificationLocalReadKey(input.projectStateKey, id);
      if (!key || readAtByKey[key] === readAt) continue;
      readAtByKey[key] = readAt;
      changed = true;
    }
    if (changed) set(asyncNotificationLocalReadStateAtom, { readAtByKey });
  },
);

export const notificationFeedResourceFamily = atomFamily((_projectStateKey: ProjectStateKey) =>
  atom<NotificationFeedResource>(emptyNotificationFeedResource()),
);

export const notificationFeedFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom(
    (get) => get(notificationFeedResourceFamily(projectStateKey)).value,
    (get, set, value: ProjectNotificationFeed | null) => {
      const current = get(notificationFeedResourceFamily(projectStateKey));
      set(notificationFeedResourceFamily(projectStateKey), {
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

export const notificationFeedErrorFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom(
    (get) => get(notificationFeedResourceFamily(projectStateKey)).error,
    (get, set, error: string | null) => {
      const current = get(notificationFeedResourceFamily(projectStateKey));
      set(notificationFeedResourceFamily(projectStateKey), {
        ...current,
        error,
      });
    },
  ),
);

export const notificationObservedIdsFamily = atomFamily((_projectStateKey: ProjectStateKey) =>
  atom<ReadonlySet<string>>(new Set<string>()),
);

export const markNotificationRecordsObservedAtom = atom(
  null,
  (get, set, input: { projectStateKey: ProjectStateKey; ids: Iterable<string | undefined> }) => {
    const projectStateKey = input.projectStateKey;
    if (!projectStateKey) return;
    const scopedAtom = notificationObservedIdsFamily(projectStateKey);
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

export const beginNotificationFeedRefreshAtom = atom(
  null,
  (get, set, projectStateKey: ProjectStateKey) => {
    const current = get(notificationFeedResourceFamily(projectStateKey));
    set(notificationFeedResourceFamily(projectStateKey), {
      ...current,
      error: null,
      pending: true,
      stale: current.value !== null,
    });
  },
);

export const applyNotificationFeedSuccessAtom = atom(
  null,
  (_get, set, { projectStateKey, feed, updatedAt }: ApplyNotificationFeedSuccessInput) => {
    set(notificationFeedResourceFamily(projectStateKey), {
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
  (get, set, { projectStateKey, error }: ApplyNotificationFeedFailureInput) => {
    const current = get(notificationFeedResourceFamily(projectStateKey));
    set(notificationFeedResourceFamily(projectStateKey), {
      ...current,
      error,
      pending: false,
      stale: current.value !== null,
    });
  },
);

export const clearNotificationFeedResourceAtom = atom(
  null,
  (_get, set, projectStateKey: ProjectStateKey) => {
    set(notificationFeedResourceFamily(projectStateKey), emptyNotificationFeedResource());
  },
);

export const notificationUnreadCountFamily = atomFamily((projectStateKey: ProjectStateKey) =>
  atom((get) => get(notificationFeedFamily(projectStateKey))?.unreadCount ?? 0),
);
