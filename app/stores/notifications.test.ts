import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import type { NotificationRecord } from "@/lib/api";
import {
  applyNotificationLocalReadState,
  applyNotificationFeedFailureAtom,
  applyNotificationFeedSuccessAtom,
  beginNotificationFeedRefreshAtom,
  clearNotificationFeedResourceAtom,
  markNotificationRecordsReadLocalAtom,
  notificationEffectiveUnread,
  notificationFeedErrorFamily,
  notificationFeedFamily,
  notificationFeedResourceFamily,
  notificationLocalReadKey,
  notificationLocalReadStateAtom,
  notificationUnreadCountFamily,
  NOTIFICATION_LOCAL_UNREAD_WINDOW_MS,
  type ProjectNotificationFeed,
} from "./notifications";

function notification(id: string): NotificationRecord {
  return {
    id,
    title: "Needs input",
    body: "Agent is waiting",
    sessionId: "agent-1",
    projectRoot: "/repo",
    unread: true,
    cleared: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function feed(overrides: Partial<ProjectNotificationFeed> = {}): ProjectNotificationFeed {
  return {
    notifications: [notification("notice-1")],
    unreadCount: 1,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("notification feed resource lifecycle", () => {
  it("marks an in-flight refresh stale when a previous feed exists", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = feed();

    store.set(applyNotificationFeedSuccessAtom, {
      projectPath,
      feed: current,
      updatedAt: 10,
    });
    store.set(beginNotificationFeedRefreshAtom, projectPath);

    expect(store.get(notificationFeedResourceFamily(projectPath))).toEqual({
      value: current,
      error: null,
      pending: true,
      stale: true,
      updatedAt: 10,
    });
  });

  it("clears stale refresh errors when retrying with a previous feed", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = feed();

    store.set(applyNotificationFeedSuccessAtom, {
      projectPath,
      feed: current,
      updatedAt: 10,
    });
    store.set(applyNotificationFeedFailureAtom, {
      projectPath,
      error: "request timed out after 10000ms",
    });
    store.set(beginNotificationFeedRefreshAtom, projectPath);

    expect(store.get(notificationFeedResourceFamily(projectPath))).toMatchObject({
      value: current,
      error: null,
      pending: true,
      stale: true,
    });
  });

  it("keeps the last good feed after a refresh failure", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = feed();

    store.set(applyNotificationFeedSuccessAtom, {
      projectPath,
      feed: current,
      updatedAt: 10,
    });
    store.set(applyNotificationFeedFailureAtom, {
      projectPath,
      error: "service unavailable",
    });

    expect(store.get(notificationFeedFamily(projectPath))).toBe(current);
    expect(store.get(notificationFeedErrorFamily(projectPath))).toBe("service unavailable");
    expect(store.get(notificationFeedResourceFamily(projectPath))).toMatchObject({
      value: current,
      error: "service unavailable",
      pending: false,
      stale: true,
    });
  });

  it("clears stale/error metadata after the feed recovers", () => {
    const store = createStore();
    const projectPath = "/repo";
    const current = feed();
    const recovered = feed({
      notifications: [notification("notice-2")],
      unreadCount: 2,
    });

    store.set(applyNotificationFeedSuccessAtom, {
      projectPath,
      feed: current,
      updatedAt: 10,
    });
    store.set(applyNotificationFeedFailureAtom, {
      projectPath,
      error: "service unavailable",
    });
    store.set(applyNotificationFeedSuccessAtom, {
      projectPath,
      feed: recovered,
      updatedAt: 20,
    });

    expect(store.get(notificationFeedResourceFamily(projectPath))).toEqual({
      value: recovered,
      error: null,
      pending: false,
      stale: false,
      updatedAt: 20,
    });
  });

  it("clears the resource when the project service endpoint disappears", () => {
    const store = createStore();
    const projectPath = "/repo";

    store.set(applyNotificationFeedSuccessAtom, {
      projectPath,
      feed: feed(),
      updatedAt: 10,
    });
    store.set(clearNotificationFeedResourceAtom, projectPath);

    expect(store.get(notificationFeedResourceFamily(projectPath))).toEqual({
      value: null,
      error: null,
      pending: false,
      stale: false,
      updatedAt: null,
    });
  });

  it("derives unread count from the resource value", () => {
    const store = createStore();
    const projectPath = "/repo";

    store.set(applyNotificationFeedSuccessAtom, {
      projectPath,
      feed: feed({ unreadCount: 3 }),
      updatedAt: 10,
    });

    expect(store.get(notificationUnreadCountFamily(projectPath))).toBe(3);
  });
});

describe("local notification read state", () => {
  it("keys reads by project path and notification id", () => {
    expect(notificationLocalReadKey("/repo", "notice-1")).toBe("/repo\u0000notice-1");
    expect(notificationLocalReadKey(" ", "notice-1")).toBeNull();
    expect(notificationLocalReadKey("/repo", "")).toBeNull();
  });

  it("treats locally read notifications as read on the same device", () => {
    const readState = {
      readAtByKey: {
        [notificationLocalReadKey("/repo", "notice-1")!]: "2026-01-01T00:05:00.000Z",
      },
    };

    expect(
      notificationEffectiveUnread({
        projectPath: "/repo",
        notification: notification("notice-1"),
        readState,
        nowMs: Date.parse("2026-01-01T00:10:00.000Z"),
      }),
    ).toBe(false);
    expect(
      notificationEffectiveUnread({
        projectPath: "/other",
        notification: notification("notice-1"),
        readState,
        nowMs: Date.parse("2026-01-01T00:10:00.000Z"),
      }),
    ).toBe(true);
  });

  it("expires unread status after the local unread window", () => {
    const record = notification("notice-1");
    const nowMs = Date.parse(record.createdAt) + NOTIFICATION_LOCAL_UNREAD_WINDOW_MS + 1;

    expect(
      notificationEffectiveUnread({
        projectPath: "/repo",
        notification: record,
        readState: { readAtByKey: {} },
        nowMs,
      }),
    ).toBe(false);
  });

  it("applies local read state without mutating notification records", () => {
    const record = notification("notice-1");
    const readState = {
      readAtByKey: {
        [notificationLocalReadKey("/repo", "notice-1")!]: "2026-01-01T00:05:00.000Z",
      },
    };

    const [updated] = applyNotificationLocalReadState("/repo", [record], readState);

    expect(record.unread).toBe(true);
    expect(updated).toMatchObject({ id: "notice-1", unread: false });
  });

  it("persists local reads through the write atom", () => {
    const store = createStore();

    store.set(markNotificationRecordsReadLocalAtom, {
      projectPath: "/repo",
      ids: ["notice-1", undefined],
      readAt: "2026-01-01T00:05:00.000Z",
    });

    expect(store.get(notificationLocalReadStateAtom).readAtByKey).toMatchObject({
      [notificationLocalReadKey("/repo", "notice-1")!]: "2026-01-01T00:05:00.000Z",
    });
  });
});
