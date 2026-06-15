import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { NotificationRecord } from "@/lib/api";

export interface ProjectNotificationFeed {
  notifications: NotificationRecord[];
  unreadCount: number;
  fetchedAt: string;
}

export const notificationFeedFamily = atomFamily((_projectPath: string) =>
  atom<ProjectNotificationFeed | null>(null),
);

export const notificationFeedErrorFamily = atomFamily((_projectPath: string) =>
  atom<string | null>(null),
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

export const notificationUnreadCountFamily = atomFamily((projectPath: string) =>
  atom((get) => get(notificationFeedFamily(projectPath))?.unreadCount ?? 0),
);
