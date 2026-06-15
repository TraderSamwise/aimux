import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSession } from "@/lib/desktop-state";
import { defaultNotificationSettings } from "@/lib/notification-settings";
import {
  evaluateAgentNotification,
  evaluateAlertEvent,
  evaluateNotificationRecordBatch,
  evaluateNotificationRecord,
  isRecentNotificationRecord,
  snapshotSessionForNotifications,
} from "@/lib/notification-policy";

const enabledSettings = {
  ...defaultNotificationSettings,
  enabled: true,
};

function session(overrides: Partial<DesktopSession>): DesktopSession {
  return {
    id: "claude-a1",
    command: "claude",
    status: "running",
    label: "claude",
    attention: "none",
    activity: "running",
    unseenCount: 0,
    ...overrides,
  };
}

describe("notification policy", () => {
  const now = new Date("2026-05-23T00:00:10.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not emit from the initial snapshot", () => {
    expect(
      evaluateAgentNotification(session({ attention: "needs_input" }), undefined, enabledSettings),
    ).toBeNull();
  });

  it("emits when an agent starts needing input", () => {
    const previous = snapshotSessionForNotifications(session({ attention: "none" }));
    const event = evaluateAgentNotification(
      session({ attention: "needs_input", headline: "Waiting for input" }),
      previous,
      enabledSettings,
      { projectName: "glyde-frontend", projectPath: "/Users/sam/cs/glyde-frontend" },
    );

    expect(event).toMatchObject({
      category: "agent",
      kind: "needs_input",
      title: "glyde-frontend: Agent needs input",
      body: "Waiting for input",
      dedupeKey: "agent:claude-a1:attention:needs_input",
      target: {
        projectPath: "/Users/sam/cs/glyde-frontend",
        sessionId: "claude-a1",
      },
    });
  });

  it("honors category toggles", () => {
    const previous = snapshotSessionForNotifications(session({ attention: "none" }));
    const settings = {
      ...enabledSettings,
      categories: {
        ...enabledSettings.categories,
        agent: {
          ...enabledSettings.categories.agent,
          needsInput: false,
        },
      },
    };

    expect(
      evaluateAgentNotification(session({ attention: "needs_input" }), previous, settings),
    ).toBeNull();
  });

  it("emits optional completion alerts only when enabled", () => {
    const previous = snapshotSessionForNotifications(session({ activity: "running" }));
    const doneSession = session({ status: "idle", activity: "done" });

    expect(evaluateAgentNotification(doneSession, previous, enabledSettings)).toBeNull();

    const event = evaluateAgentNotification(doneSession, previous, {
      ...enabledSettings,
      categories: {
        ...enabledSettings.categories,
        agent: {
          ...enabledSettings.categories.agent,
          completed: true,
        },
      },
    });

    expect(event).toMatchObject({
      kind: "completed",
      title: "Agent completed",
    });
  });

  it("maps daemon notification records through the same category settings", () => {
    const event = evaluateNotificationRecord(
      {
        id: "notice-1",
        title: "Need input",
        body: "Approve deploy",
        sessionId: "claude-a1",
        kind: "needs_input",
        unread: true,
        cleared: false,
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      enabledSettings,
      { projectName: "glyde-frontend", projectPath: "/Users/sam/cs/glyde-frontend" },
    );

    expect(event).toMatchObject({
      id: "notice-1",
      category: "agent",
      kind: "needs_input",
      title: "glyde-frontend: Need input",
      body: "Approve deploy",
      dedupeKey: "notification:notice-1",
      target: {
        projectPath: "/Users/sam/cs/glyde-frontend",
        sessionId: "claude-a1",
      },
    });
  });

  it("does not add a duplicate client project prefix to server-labeled records", () => {
    const event = evaluateNotificationRecord(
      {
        id: "notice-1",
        title: "[Needs input] aimux / notifications",
        body: "Agent is waiting for input.",
        sessionId: "claude-a1",
        kind: "needs_input",
        projectName: "aimux",
        worktreeName: "notifications",
        unread: true,
        cleared: false,
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      enabledSettings,
      { projectName: "aimux", projectPath: "/Users/sam/cs/aimux" },
    );

    expect(event).toMatchObject({
      title: "[Needs input] aimux / notifications",
      dedupeKey: "notification:notice-1",
    });
  });

  it("maps live alert events without waiting for notification polling", () => {
    const event = evaluateAlertEvent(
      {
        type: "alert",
        projectId: "glyde-frontend-123",
        kind: "needs_input",
        sessionId: "claude-a1",
        title: "claude needs input",
        message: "Agent is waiting for input.",
        ts: now.toISOString(),
        notificationId: "notice-1",
      },
      enabledSettings,
      { projectName: "glyde-frontend", projectPath: "/Users/sam/cs/glyde-frontend" },
    );

    expect(event).toMatchObject({
      id: "notice-1",
      category: "agent",
      kind: "needs_input",
      title: "glyde-frontend: claude needs input",
      body: "Agent is waiting for input.",
      dedupeKey: "notification:notice-1",
      target: {
        projectPath: "/Users/sam/cs/glyde-frontend",
        sessionId: "claude-a1",
      },
    });
  });

  it("maps next-step live alert events to needs-input browser notifications", () => {
    const event = evaluateAlertEvent(
      {
        type: "alert",
        projectId: "aimux-123",
        kind: "next_step",
        sessionId: "codex-p4bb3m",
        title: "[Next step] aimux / notifications",
        message: "Agent stopped after a turn: codex @ notifications ready for next step.",
        ts: now.toISOString(),
        notificationId: "notice-next-step",
      },
      enabledSettings,
      { projectName: "aimux", projectPath: "/Users/sam/cs/aimux" },
    );

    expect(event).toMatchObject({
      id: "notice-next-step",
      category: "agent",
      kind: "needs_input",
      title: "[Next step] aimux / notifications",
      body: "Agent stopped after a turn: codex @ notifications ready for next step.",
      dedupeKey: "notification:notice-next-step",
      target: {
        projectPath: "/Users/sam/cs/aimux",
        sessionId: "codex-p4bb3m",
      },
    });
  });

  it("does not notify stale records discovered by delayed polling", () => {
    vi.setSystemTime(new Date("2026-05-23T00:01:00.000Z"));
    expect(
      isRecentNotificationRecord(
        {
          id: "notice-old",
          title: "Old alert",
          body: "Already happened",
          kind: "needs_input",
          unread: true,
          cleared: false,
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:00.000Z",
        },
        Date.parse("2026-05-23T00:01:00.000Z"),
      ),
    ).toBe(false);
    expect(
      evaluateNotificationRecord(
        {
          id: "notice-old",
          title: "Old alert",
          body: "Already happened",
          sessionId: "claude-a1",
          kind: "needs_input",
          unread: true,
          cleared: false,
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:00.000Z",
        },
        enabledSettings,
      ),
    ).toBeNull();
  });

  it("maps prompt-like daemon records to needs-input browser notifications", () => {
    for (const kind of [
      "next_step",
      "interaction_request",
      "message_waiting",
      "handoff_waiting",
      "task_assigned",
      "review_waiting",
    ]) {
      expect(
        evaluateNotificationRecord(
          {
            id: `notice-${kind}`,
            title: "Needs attention",
            body: "Respond in aimux",
            sessionId: "claude-a1",
            kind,
            unread: true,
            cleared: false,
            createdAt: "2026-05-23T00:00:00.000Z",
            updatedAt: "2026-05-23T00:00:00.000Z",
          },
          enabledSettings,
        ),
      ).toMatchObject({ kind: "needs_input" });
    }
  });

  it("maps next-step daemon records through needs-input settings", () => {
    const event = evaluateNotificationRecord(
      {
        id: "notice-next-step",
        title: "[Next step] aimux / notifications",
        body: "Agent stopped after a turn.",
        sessionId: "codex-p4bb3m",
        kind: "next_step",
        unread: true,
        cleared: false,
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      enabledSettings,
      { projectName: "aimux", projectPath: "/Users/sam/cs/aimux" },
    );

    expect(event).toMatchObject({
      id: "notice-next-step",
      category: "agent",
      kind: "needs_input",
      title: "[Next step] aimux / notifications",
      dedupeKey: "notification:notice-next-step",
      target: {
        projectPath: "/Users/sam/cs/aimux",
        sessionId: "codex-p4bb3m",
      },
    });
  });

  it("caps polled notification catch-up to the newest unobserved browser notification", () => {
    const result = evaluateNotificationRecordBatch(
      [
        {
          id: "notice-newest",
          title: "Newest",
          body: "Respond here",
          sessionId: "codex-2",
          kind: "needs_input",
          unread: true,
          cleared: false,
          createdAt: "2026-05-23T00:00:09.000Z",
          updatedAt: "2026-05-23T00:00:09.000Z",
        },
        {
          id: "notice-older",
          title: "Older",
          body: "Also respond",
          sessionId: "codex-1",
          kind: "needs_input",
          unread: true,
          cleared: false,
          createdAt: "2026-05-23T00:00:08.000Z",
          updatedAt: "2026-05-23T00:00:08.000Z",
        },
      ],
      enabledSettings,
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: "notice-newest",
      title: "Newest",
      target: { sessionId: "codex-2" },
    });
    expect(result.observedIds).toEqual(["notice-newest", "notice-older"]);
  });

  it("skips durable records already delivered by the live alert stream", () => {
    const result = evaluateNotificationRecordBatch(
      [
        {
          id: "notice-live",
          title: "Already live",
          body: "SSE handled this",
          sessionId: "codex-2",
          kind: "needs_input",
          unread: true,
          cleared: false,
          createdAt: "2026-05-23T00:00:09.000Z",
          updatedAt: "2026-05-23T00:00:09.000Z",
        },
        {
          id: "notice-polled",
          title: "Polled",
          body: "Fallback delivery",
          sessionId: "codex-1",
          kind: "needs_input",
          unread: true,
          cleared: false,
          createdAt: "2026-05-23T00:00:08.000Z",
          updatedAt: "2026-05-23T00:00:08.000Z",
        },
      ],
      enabledSettings,
      {},
      new Set(["notice-live"]),
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: "notice-polled" });
    expect(result.observedIds).toEqual(["notice-polled"]);
  });

  it("does not emit read, cleared, or disabled daemon records", () => {
    const baseRecord = {
      id: "notice-1",
      title: "Done",
      body: "Task completed",
      sessionId: "claude-a1",
      kind: "task_done",
      unread: true,
      cleared: false,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
    };

    expect(evaluateNotificationRecord(baseRecord, enabledSettings)).toBeNull();
    expect(
      evaluateNotificationRecord(
        { ...baseRecord, kind: "needs_input", unread: false },
        enabledSettings,
      ),
    ).toBeNull();
    expect(
      evaluateNotificationRecord(
        { ...baseRecord, kind: "needs_input", cleared: true },
        enabledSettings,
      ),
    ).toBeNull();
  });
});
