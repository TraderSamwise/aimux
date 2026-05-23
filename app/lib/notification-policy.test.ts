import { describe, expect, it } from "vitest";
import type { DesktopSession } from "@/lib/desktop-state";
import { defaultNotificationSettings } from "@/lib/notification-settings";
import {
  evaluateAgentNotification,
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
});
