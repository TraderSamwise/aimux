import { describe, expect, it } from "vitest";

import {
  buildCoordinationModel,
  isNotificationStale,
  type CoordinationSessionLike,
  type BuildCoordinationModelInput,
} from "./coordination-model.js";
import type { NotificationRecord } from "./notifications.js";
import type { WorkflowEntry } from "./workflow.js";

function notif(over: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: "n",
    title: "title",
    body: "body",
    unread: true,
    cleared: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function session(id: string, label?: string, attentionScore = 0, status = "running"): CoordinationSessionLike {
  return {
    id,
    status,
    command: "claude",
    semantic: { user: { label }, presentation: { attentionScore } },
  };
}

function threadEntry(over: { participants?: string[]; owner?: string; waitingOn?: string[]; urgency?: number; pendingDeliveries?: number }): WorkflowEntry {
  return {
    thread: { id: "t", participants: over.participants ?? [], owner: over.owner, waitingOn: over.waitingOn },
    urgency: over.urgency ?? 0,
    pendingDeliveries: over.pendingDeliveries ?? 0,
  } as unknown as WorkflowEntry;
}

function build(input: Partial<BuildCoordinationModelInput>) {
  return buildCoordinationModel({ sessions: [], notifications: [], ...input });
}

describe("coordination model", () => {
  it("puts a live needs-input agent at the top and marks it actionable", () => {
    const model = build({
      sessions: [session("a", "needs_input", 4)],
      notifications: [notif({ id: "1", sessionId: "a", kind: "needs_input" })],
    });
    expect(model.items[0]!.sessionId).toBe("a");
    expect(model.items[0]!.reachability).toBe("live");
    expect(model.items[0]!.actionable).toBe(true);
    expect(model.actionable).toHaveLength(1);
  });

  it("orders offline-actionable below live-actionable", () => {
    const model = build({
      sessions: [session("a", "needs_input", 4), session("c", "offline", 0, "offline")],
      notifications: [
        notif({ id: "1", sessionId: "a", kind: "needs_input" }),
        notif({ id: "2", sessionId: "c", kind: "needs_input" }),
      ],
    });
    expect(model.items.map((i) => i.sessionId)).toEqual(["a", "c"]);
    expect(model.items[1]!.reachability).toBe("offline");
    expect(model.items[1]!.actionable).toBe(true);
  });

  it("classifies a vanished target as missing and unreachable, not actionable", () => {
    const model = build({
      sessions: [],
      notifications: [notif({ id: "1", sessionId: "ghost", kind: "needs_input" })],
    });
    expect(model.items[0]!.reachability).toBe("missing");
    expect(model.items[0]!.actionable).toBe(false);
    expect(model.unreachable).toHaveLength(1);
  });

  it("marks a live agent that moved on as stale (not actionable, not unreachable)", () => {
    const model = build({
      sessions: [session("b", "working", 0)],
      notifications: [notif({ id: "1", sessionId: "b", kind: "needs_input" })],
    });
    const item = model.items[0]!;
    expect(item.stale).toBe(true);
    expect(item.actionable).toBe(false);
    expect(model.unreachable).toHaveLength(0);
    expect(model.actionable).toHaveLength(0);
  });

  it("rolls multiple notifications for one agent into a single item", () => {
    const model = build({
      sessions: [session("a", "needs_input", 4)],
      notifications: [
        notif({ id: "1", sessionId: "a", kind: "needs_input" }),
        notif({ id: "2", sessionId: "a", kind: "needs_input", createdAt: "2026-01-02T00:00:00.000Z" }),
      ],
    });
    expect(model.items).toHaveLength(1);
    expect(model.items[0]!.unreadCount).toBe(2);
    expect(model.items[0]!.notifications).toHaveLength(2);
    expect(model.items[0]!.latestUnread?.id).toBe("2");
  });

  it("resolves teammate targets so they are not misclassified as missing", () => {
    const model = build({
      sessions: [],
      teammates: [session("tm", "needs_input", 4)],
      notifications: [notif({ id: "1", sessionId: "tm", kind: "needs_input" })],
    });
    expect(model.items[0]!.reachability).toBe("live");
  });

  it("keys sessionless notifications by dedupeKey and treats unread ones as actionable", () => {
    const model = build({
      notifications: [notif({ id: "1", dedupeKey: "dk", kind: "info" })],
    });
    expect(model.items[0]!.key).toBe("dk");
    expect(model.items[0]!.reachability).toBe("none");
    expect(model.items[0]!.actionable).toBe(true);
  });

  it("isNotificationStale: true only when a needs-input notice lingers past a waiting label", () => {
    expect(isNotificationStale("working", true)).toBe(true);
    expect(isNotificationStale("ready", true)).toBe(true);
    expect(isNotificationStale("needs_input", true)).toBe(false);
    expect(isNotificationStale("blocked", true)).toBe(false);
    expect(isNotificationStale(undefined, true)).toBe(false);
    expect(isNotificationStale("working", false)).toBe(false);
  });

  it("collapses sessionless notifications that share a dedupeKey into one item", () => {
    const model = build({
      notifications: [
        notif({ id: "1", dedupeKey: "proj-alert", kind: "info" }),
        notif({ id: "2", dedupeKey: "proj-alert", kind: "info", createdAt: "2026-01-02T00:00:00.000Z" }),
        notif({ id: "3", dedupeKey: "other", kind: "info" }),
      ],
    });
    expect(model.items).toHaveLength(2);
    const grouped = model.items.find((i) => i.key === "proj-alert")!;
    expect(grouped.unreadCount).toBe(2);
    expect(grouped.notifications).toHaveLength(2);
  });

  it("annotates an agent item with its genuine thread and pending deliveries", () => {
    const entry = threadEntry({ participants: ["aimux", "a"], urgency: 5, pendingDeliveries: 1 });
    const model = build({
      sessions: [session("a", "needs_input", 4)],
      notifications: [notif({ id: "1", sessionId: "a", kind: "needs_input" })],
      threads: [entry],
    });
    expect(model.items[0]!.thread).toBe(entry);
    expect(model.items[0]!.pendingDeliveries).toBe(1);
  });
});
