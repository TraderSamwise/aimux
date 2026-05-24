import { describe, expect, it } from "vitest";
import type { DesktopSession } from "@/lib/desktop-state";
import { defaultNotificationSettings } from "@/lib/notification-settings";
import {
  evaluateAgentNotification,
  evaluateNotificationRecord,
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
