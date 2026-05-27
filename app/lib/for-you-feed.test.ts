import { describe, expect, it } from "vitest";
import type { NotificationRecord } from "@/lib/api";
import type { DesktopState } from "@/lib/desktop-state";
import type { SecurityInboxEvent } from "@/stores/security";
import { buildForYouFeed, classifyNotification } from "@/lib/for-you-feed";

function notification(input: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: input.id ?? "n1",
    title: input.title ?? "Agent update",
    body: input.body ?? "",
    unread: input.unread ?? false,
    cleared: false,
    createdAt: input.createdAt ?? "2026-05-27T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-05-27T00:00:00.000Z",
    ...input,
  };
}

describe("For You feed classifier", () => {
  it("classifies notification language into OpenRig-style lenses", () => {
    expect(classifyNotification(notification({ kind: "approval_requested" }))).toBe("approval");
    expect(classifyNotification(notification({ body: "handoff waiting for human" }))).toBe(
      "action-required",
    );
    expect(classifyNotification(notification({ title: "slice shipped" }))).toBe("shipped");
    expect(classifyNotification(notification({ kind: "activity" }))).toBe("progress");
    expect(classifyNotification(notification({ kind: "watchdog" }))).toBe("observation");
  });

  it("merges security alerts, notifications, and pending lifecycle state", () => {
    const security: SecurityInboxEvent = {
      id: "sec-1",
      kind: "relay_join",
      title: "New relay participant",
      body: "A guest joined",
      createdAt: "2026-05-27T00:01:00.000Z",
      receivedAt: "2026-05-27T00:01:01.000Z",
    };
    const desktopState: DesktopState = {
      ok: true,
      sessions: [
        {
          id: "agent-1",
          status: "waiting",
          pendingAction: "Needs approval",
        },
      ],
      services: [
        {
          id: "web",
          status: "running",
          pendingAction: "Restart required",
        },
      ],
      worktrees: [],
    };

    const feed = buildForYouFeed({
      securityEvents: [security],
      notifications: [
        notification({
          id: "n1",
          title: "Tests completed",
          body: "done",
          unread: false,
        }),
      ],
      desktopState,
    });

    expect(feed.counts["action-required"]).toBe(3);
    expect(feed.counts.shipped).toBe(1);
    expect(feed.cards.map((card) => card.id)).toEqual(
      expect.arrayContaining([
        "security:sec-1",
        "agent:agent-1:attention",
        "service:web:attention",
        "notification:n1",
      ]),
    );
  });
});
