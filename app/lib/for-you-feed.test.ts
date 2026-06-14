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

  it("separates actionable interaction requests from telemetry", () => {
    expect(
      classifyNotification(
        notification({
          kind: "interaction_request",
          interaction: { id: "i1", type: "question" },
          unread: true,
        }),
      ),
    ).toBe("action-required");
    expect(
      classifyNotification(
        notification({
          kind: "interaction_request",
          interaction: { id: "i2", type: "permission" },
          unread: true,
        }),
      ),
    ).toBe("approval");
    expect(
      classifyNotification(
        notification({
          kind: "interaction_request",
          interaction: { id: "i3", type: "permission", telemetry: true },
          unread: true,
        }),
      ),
    ).toBe("observation");
  });

  it("marks interaction cards actionable only when the interaction is resolvable", () => {
    const feed = buildForYouFeed({
      securityEvents: [],
      desktopState: null,
      notifications: [
        notification({
          id: "action",
          kind: "interaction_request",
          interaction: { id: "i1", type: "question" },
          unread: true,
        }),
        notification({
          id: "telemetry",
          kind: "interaction_request",
          interaction: { id: "i2", type: "permission", telemetry: true },
          unread: true,
        }),
      ],
    });

    expect(feed.cards.find((card) => card.notificationId === "action")).toMatchObject({
      actionable: true,
      kind: "action-required",
    });
    expect(feed.cards.find((card) => card.notificationId === "telemetry")).toMatchObject({
      actionable: false,
      kind: "observation",
    });
  });

  it("shows structured category and project/worktree metadata on notification cards", () => {
    const feed = buildForYouFeed({
      securityEvents: [],
      desktopState: null,
      notifications: [
        notification({
          id: "n-meta",
          title: "[Needs input] aimux / notifications",
          body: "Agent is waiting for input.",
          kind: "needs_input",
          categoryLabel: "Needs input",
          projectName: "aimux",
          worktreeName: "notifications",
          sessionId: "codex-1",
          unread: true,
        }),
      ],
    });

    expect(feed.cards[0]).toMatchObject({
      title: "[Needs input] aimux / notifications",
      subtitle: "Needs input · aimux / notifications · codex-1",
    });
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
