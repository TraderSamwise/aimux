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

export const notificationFeedRefreshNonceAtom = atom(0);

export const kickNotificationFeedRefreshAtom = atom(null, (get, set) => {
  set(notificationFeedRefreshNonceAtom, get(notificationFeedRefreshNonceAtom) + 1);
});

export const notificationUnreadCountFamily = atomFamily((projectPath: string) =>
  atom((get) => get(notificationFeedFamily(projectPath))?.unreadCount ?? 0),
);
