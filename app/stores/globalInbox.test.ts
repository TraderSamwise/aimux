import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import type { NotificationRecord, ThreadSummaryResponse } from "@/lib/api";
import {
  applyGlobalNotificationSuccessAtom,
  applyGlobalNotificationFailureAtom,
  applyGlobalThreadFailureAtom,
  applyGlobalThreadSuccessAtom,
  beginGlobalNotificationRefreshAtom,
  beginGlobalThreadRefreshAtom,
  globalInboxRequestKey,
  globalNotificationResourceAtom,
  globalThreadResourceAtom,
  settleGlobalNotificationRefreshAtom,
  settleGlobalThreadRefreshAtom,
  type GlobalInboxValue,
  type GlobalNotificationRow,
  type GlobalThreadRow,
} from "./globalInbox";

function notification(id: string): NotificationRecord {
  return {
    id,
    sessionId: "claude-1",
    title: "Needs reply",
    body: "Please respond",
    kind: "agent",
    unread: true,
    cleared: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function thread(id: string): ThreadSummaryResponse {
  return {
    thread: {
      id,
      kind: "conversation",
      title: "Thread",
      status: "open",
    },
    latestMessage: {
      body: "Latest",
      ts: "2026-01-01T00:00:00.000Z",
    },
    unreadCount: 1,
  };
}

function notificationValue(
  overrides: Partial<GlobalInboxValue<GlobalNotificationRow>> = {},
): GlobalInboxValue<GlobalNotificationRow> {
  return {
    rows: [{ projectName: "Aimux", projectPath: "/repo", notification: notification("n1") }],
    errors: [],
    projectCount: 1,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function threadValue(
  overrides: Partial<GlobalInboxValue<GlobalThreadRow>> = {},
): GlobalInboxValue<GlobalThreadRow> {
  return {
    rows: [{ projectName: "Aimux", projectPath: "/repo", thread: thread("t1") }],
    errors: [],
    projectCount: 1,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("global inbox resources", () => {
  it("keeps stale global notifications while a refresh is in flight", () => {
    const store = createStore();
    const current = notificationValue();
    const requestKey = globalInboxRequestKey("notifications", "projects-a", 1);

    store.set(applyGlobalNotificationSuccessAtom, { value: current, updatedAt: 10 });
    store.set(beginGlobalNotificationRefreshAtom, { requestKey });

    expect(store.get(globalNotificationResourceAtom)).toEqual({
      value: current,
      error: null,
      pending: true,
      pendingRequestKey: requestKey,
      stale: true,
      updatedAt: 10,
    });
  });

  it("keeps stale global threads while a refresh is in flight", () => {
    const store = createStore();
    const current = threadValue();
    const requestKey = globalInboxRequestKey("threads", "projects-a", 1);

    store.set(applyGlobalThreadSuccessAtom, { value: current, updatedAt: 10 });
    store.set(beginGlobalThreadRefreshAtom, { requestKey });

    expect(store.get(globalThreadResourceAtom)).toEqual({
      value: current,
      error: null,
      pending: true,
      pendingRequestKey: requestKey,
      stale: true,
      updatedAt: 10,
    });
  });

  it("settles only the global notification request that owns pending", () => {
    const store = createStore();
    const current = notificationValue();
    const staleRequest = globalInboxRequestKey("notifications", "projects-a", 1);
    const currentRequest = globalInboxRequestKey("notifications", "projects-b", 2);

    store.set(applyGlobalNotificationSuccessAtom, { value: current, updatedAt: 10 });
    store.set(beginGlobalNotificationRefreshAtom, { requestKey: staleRequest });
    store.set(beginGlobalNotificationRefreshAtom, { requestKey: currentRequest });
    store.set(settleGlobalNotificationRefreshAtom, { requestKey: staleRequest });

    expect(store.get(globalNotificationResourceAtom)).toMatchObject({
      value: current,
      pending: true,
      pendingRequestKey: currentRequest,
      stale: true,
    });

    store.set(settleGlobalNotificationRefreshAtom, { requestKey: currentRequest });

    expect(store.get(globalNotificationResourceAtom)).toMatchObject({
      value: current,
      pending: false,
      pendingRequestKey: null,
      stale: true,
    });
  });

  it("settles only the global thread request that owns pending", () => {
    const store = createStore();
    const current = threadValue();
    const staleRequest = globalInboxRequestKey("threads", "projects-a", 1);
    const currentRequest = globalInboxRequestKey("threads", "projects-b", 2);

    store.set(applyGlobalThreadSuccessAtom, { value: current, updatedAt: 10 });
    store.set(beginGlobalThreadRefreshAtom, { requestKey: staleRequest });
    store.set(beginGlobalThreadRefreshAtom, { requestKey: currentRequest });
    store.set(settleGlobalThreadRefreshAtom, { requestKey: staleRequest });

    expect(store.get(globalThreadResourceAtom)).toMatchObject({
      value: current,
      pending: true,
      pendingRequestKey: currentRequest,
      stale: true,
    });

    store.set(settleGlobalThreadRefreshAtom, { requestKey: currentRequest });

    expect(store.get(globalThreadResourceAtom)).toMatchObject({
      value: current,
      pending: false,
      pendingRequestKey: null,
      stale: true,
    });
  });

  it("clears stale metadata when global inbox resources recover", () => {
    const store = createStore();
    const currentNotifications = notificationValue();
    const currentThreads = threadValue();
    const recoveredNotifications = notificationValue({ rows: [] });
    const recoveredThreads = threadValue({ rows: [] });

    store.set(applyGlobalNotificationSuccessAtom, { value: currentNotifications, updatedAt: 10 });
    store.set(beginGlobalNotificationRefreshAtom, {
      requestKey: globalInboxRequestKey("notifications", "projects-a", 1),
    });
    store.set(applyGlobalNotificationSuccessAtom, {
      value: recoveredNotifications,
      updatedAt: 20,
    });
    store.set(applyGlobalThreadSuccessAtom, { value: currentThreads, updatedAt: 10 });
    store.set(beginGlobalThreadRefreshAtom, {
      requestKey: globalInboxRequestKey("threads", "projects-a", 1),
    });
    store.set(applyGlobalThreadSuccessAtom, { value: recoveredThreads, updatedAt: 20 });

    expect(store.get(globalNotificationResourceAtom)).toEqual({
      value: recoveredNotifications,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: 20,
    });
    expect(store.get(globalThreadResourceAtom)).toEqual({
      value: recoveredThreads,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: 20,
    });
  });

  it("keeps stale global inbox values after total refresh failures", () => {
    const store = createStore();
    const currentNotifications = notificationValue();
    const currentThreads = threadValue();

    store.set(applyGlobalNotificationSuccessAtom, { value: currentNotifications, updatedAt: 10 });
    store.set(beginGlobalNotificationRefreshAtom, {
      requestKey: globalInboxRequestKey("notifications", "projects-a", 1),
    });
    store.set(applyGlobalNotificationFailureAtom, { error: "token failed" });
    store.set(applyGlobalThreadSuccessAtom, { value: currentThreads, updatedAt: 10 });
    store.set(beginGlobalThreadRefreshAtom, {
      requestKey: globalInboxRequestKey("threads", "projects-a", 1),
    });
    store.set(applyGlobalThreadFailureAtom, { error: "token failed" });

    expect(store.get(globalNotificationResourceAtom)).toMatchObject({
      value: currentNotifications,
      error: "token failed",
      pending: false,
      pendingRequestKey: null,
      stale: true,
    });
    expect(store.get(globalThreadResourceAtom)).toMatchObject({
      value: currentThreads,
      error: "token failed",
      pending: false,
      pendingRequestKey: null,
      stale: true,
    });
  });
});
