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
  upsertNotification,
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

  it("upserts user-facing notifications by session target", () => {
    const first = upsertNotification({
      title: "codex needs input",
      body: "approve command",
      sessionId: "codex-1",
      kind: "needs_input",
    });
    const second = upsertNotification({
      title: "codex finished",
      body: "done",
      sessionId: "codex-1",
      kind: "task_done",
    });

    expect(second.id).not.toBe(first.id);
    expect(listNotifications({ includeCleared: true, sessionId: "codex-1" })).toHaveLength(1);
    expect(listNotifications({ sessionId: "codex-1" })[0]).toMatchObject({
      title: "codex finished",
      body: "done",
      kind: "task_done",
      targetKey: "session:codex-1",
    });
  });

  it("records directly focused-session alerts without marking them unread", () => {
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

  it("does not treat dashboard row selection as direct session focus", () => {
    updateNotificationContext("tui", {
      focused: true,
      sessionId: "codex-1",
      screen: "dashboard",
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

    expect(unreadNotificationCount({ sessionId: "codex-1" })).toBe(1);
  });

  it("coalesces duplicate alert sources into one session notification", () => {
    const bus = new ProjectEventBus();

    expect(
      bus.publishAlert({
        kind: "needs_input",
        sessionId: "claude-1",
        title: "claude-1 needs input",
        message: "from hook",
      }),
    ).toBe(true);
    expect(
      bus.publishAlert({
        kind: "notification",
        sessionId: "claude-1",
        title: "Claude Code",
        message: "from terminal notification",
      }),
    ).toBe(true);

    const notifications = listNotifications({ includeCleared: true, sessionId: "claude-1" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      title: "Claude Code",
      body: "from terminal notification",
      targetKey: "session:claude-1",
    });
  });
});
