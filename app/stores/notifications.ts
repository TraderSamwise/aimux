import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { NotificationRecord } from "@/lib/api";

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
