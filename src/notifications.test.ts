import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "./paths.js";
import {
  addNotification,
  clearNotifications,
  listNotifications,
  markNotificationsRead,
  unreadNotificationCount,
} from "./notifications.js";
import { updateNotificationContext } from "./notification-context.js";
import { ProjectEventBus } from "./project-events.js";

describe("notifications store", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-notifications-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("stores unread notifications and filters by session", () => {
    addNotification({ title: "Build done", body: "All tests passed", sessionId: "claude-1", kind: "task_done" });
    addNotification({ title: "Need input", body: "Approve migration", sessionId: "claude-2", kind: "needs_input" });

    expect(unreadNotificationCount()).toBe(2);
    expect(unreadNotificationCount({ sessionId: "claude-1" })).toBe(1);
    expect(listNotifications({ sessionId: "claude-2" })).toHaveLength(1);
  });

  it("marks notifications read and clears them", () => {
    const first = addNotification({ title: "Build done", body: "All tests passed", sessionId: "claude-1" });
    addNotification({ title: "Need input", body: "Approve migration", sessionId: "claude-1" });

    expect(markNotificationsRead({ id: first.id })).toBe(1);
    expect(listNotifications({ unreadOnly: true, sessionId: "claude-1" })).toHaveLength(1);

    expect(clearNotifications({ sessionId: "claude-1" })).toBe(2);
    expect(listNotifications()).toHaveLength(0);
    expect(listNotifications({ includeCleared: true, sessionId: "claude-1" })).toHaveLength(2);
  });

  it("records focused-session alerts without marking them unread", () => {
    updateNotificationContext("tui", {
      focused: true,
      sessionId: "codex-1",
      screen: "agent",
    });
    const bus = new ProjectEventBus();

    expect(
      bus.publishAlert({
        kind: "needs_input",
        sessionId: "codex-1",
        title: "codex needs input",
        message: "ready",
      }),
    ).toBe(true);

    expect(listNotifications({ includeCleared: true, sessionId: "codex-1" })).toHaveLength(1);
    expect(unreadNotificationCount({ sessionId: "codex-1" })).toBe(0);
  });
});
