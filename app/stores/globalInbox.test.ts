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
  mergeGlobalRowsWithPrevious,
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

    const initialKey = globalInboxRequestKey("notifications", "initial", 0);
    store.set(beginGlobalNotificationRefreshAtom, { requestKey: initialKey });
    store.set(applyGlobalNotificationSuccessAtom, {
      requestKey: initialKey,
      value: current,
      updatedAt: 10,
    });
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

    const initialKey = globalInboxRequestKey("threads", "initial", 0);
    store.set(beginGlobalThreadRefreshAtom, { requestKey: initialKey });
    store.set(applyGlobalThreadSuccessAtom, {
      requestKey: initialKey,
      value: current,
      updatedAt: 10,
    });
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

    const initialKey = globalInboxRequestKey("notifications", "initial", 0);
    store.set(beginGlobalNotificationRefreshAtom, { requestKey: initialKey });
    store.set(applyGlobalNotificationSuccessAtom, {
      requestKey: initialKey,
      value: current,
      updatedAt: 10,
    });
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

    const initialKey = globalInboxRequestKey("threads", "initial", 0);
    store.set(beginGlobalThreadRefreshAtom, { requestKey: initialKey });
    store.set(applyGlobalThreadSuccessAtom, {
      requestKey: initialKey,
      value: current,
      updatedAt: 10,
    });
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

    const initialNotificationKey = globalInboxRequestKey("notifications", "initial", 0);
    const currentNotificationKey = globalInboxRequestKey("notifications", "projects-a", 1);
    const initialThreadKey = globalInboxRequestKey("threads", "initial", 0);
    const currentThreadKey = globalInboxRequestKey("threads", "projects-a", 1);

    store.set(beginGlobalNotificationRefreshAtom, { requestKey: initialNotificationKey });
    store.set(applyGlobalNotificationSuccessAtom, {
      requestKey: initialNotificationKey,
      value: currentNotifications,
      updatedAt: 10,
    });
    store.set(beginGlobalNotificationRefreshAtom, {
      requestKey: currentNotificationKey,
    });
    store.set(applyGlobalNotificationSuccessAtom, {
      requestKey: currentNotificationKey,
      value: recoveredNotifications,
      updatedAt: 20,
    });
    store.set(beginGlobalThreadRefreshAtom, { requestKey: initialThreadKey });
    store.set(applyGlobalThreadSuccessAtom, {
      requestKey: initialThreadKey,
      value: currentThreads,
      updatedAt: 10,
    });
    store.set(beginGlobalThreadRefreshAtom, {
      requestKey: currentThreadKey,
    });
    store.set(applyGlobalThreadSuccessAtom, {
      requestKey: currentThreadKey,
      value: recoveredThreads,
      updatedAt: 20,
    });

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

    const initialNotificationKey = globalInboxRequestKey("notifications", "initial", 0);
    const failingNotificationKey = globalInboxRequestKey("notifications", "projects-a", 1);
    const initialThreadKey = globalInboxRequestKey("threads", "initial", 0);
    const failingThreadKey = globalInboxRequestKey("threads", "projects-a", 1);

    store.set(beginGlobalNotificationRefreshAtom, { requestKey: initialNotificationKey });
    store.set(applyGlobalNotificationSuccessAtom, {
      requestKey: initialNotificationKey,
      value: currentNotifications,
      updatedAt: 10,
    });
    store.set(beginGlobalNotificationRefreshAtom, {
      requestKey: failingNotificationKey,
    });
    store.set(applyGlobalNotificationFailureAtom, {
      requestKey: failingNotificationKey,
      error: "token failed",
    });
    store.set(beginGlobalThreadRefreshAtom, { requestKey: initialThreadKey });
    store.set(applyGlobalThreadSuccessAtom, {
      requestKey: initialThreadKey,
      value: currentThreads,
      updatedAt: 10,
    });
    store.set(beginGlobalThreadRefreshAtom, {
      requestKey: failingThreadKey,
    });
    store.set(applyGlobalThreadFailureAtom, {
      requestKey: failingThreadKey,
      error: "token failed",
    });

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

  it("ignores stale global inbox success and failure requests", () => {
    const store = createStore();
    const currentNotifications = notificationValue();
    const currentNotificationKey = globalInboxRequestKey("notifications", "projects-a", 2);
    const staleNotificationKey = globalInboxRequestKey("notifications", "projects-a", 1);
    const currentThreadKey = globalInboxRequestKey("threads", "projects-a", 2);
    const staleThreadKey = globalInboxRequestKey("threads", "projects-a", 1);

    store.set(beginGlobalNotificationRefreshAtom, { requestKey: currentNotificationKey });
    store.set(applyGlobalNotificationSuccessAtom, {
      requestKey: staleNotificationKey,
      value: currentNotifications,
      updatedAt: 10,
    });
    store.set(beginGlobalThreadRefreshAtom, { requestKey: currentThreadKey });
    store.set(applyGlobalThreadFailureAtom, {
      requestKey: staleThreadKey,
      error: "stale failed",
    });

    expect(store.get(globalNotificationResourceAtom)).toMatchObject({
      value: null,
      pending: true,
      pendingRequestKey: currentNotificationKey,
    });
    expect(store.get(globalThreadResourceAtom)).toMatchObject({
      value: null,
      error: null,
      pending: true,
      pendingRequestKey: currentThreadKey,
    });
  });

  it("retains previous failed-project rows during partial refresh failures", () => {
    const previousRows = [
      { projectPath: "/repo-a", projectName: "A", notification: notification("old-a") },
      { projectPath: "/repo-b", projectName: "B", notification: notification("old-b") },
    ];
    const nextRows = [
      { projectPath: "/repo-a", projectName: "A", notification: notification("new-a") },
    ];

    expect(mergeGlobalRowsWithPrevious(previousRows, nextRows, new Set(["/repo-b"]))).toEqual([
      nextRows[0],
      previousRows[1],
    ]);
  });
});
