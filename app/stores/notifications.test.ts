import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import type { NotificationRecord } from "@/lib/api";
import {
  applyNotificationFeedFailureAtom,
  applyNotificationFeedSuccessAtom,
  beginNotificationFeedRefreshAtom,
  clearNotificationFeedResourceAtom,
  notificationFeedErrorFamily,
  notificationFeedFamily,
  notificationFeedResourceFamily,
  notificationUnreadCountFamily,
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
