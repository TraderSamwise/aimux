import { describe, expect, it } from "vitest";
import type { NotificationRecord } from "./notifications.js";
import type { Task } from "./tasks.js";
import { buildProjectObservability } from "./project-observability.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    status: "pending",
    assignedBy: "user",
    description: "do a thing",
    prompt: "do a thing",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    ...over,
  } as Task;
}

function notif(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "n1",
    title: "Needs input",
    body: "please respond",
    unread: true,
    cleared: false,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    ...over,
  } as NotificationRecord;
}

describe("buildProjectObservability", () => {
  it("rolls up agent/service/worktree/task/notification summary", () => {
    const result = buildProjectObservability({
      sessions: [
        { status: "running" },
        { status: "idle" },
        { status: "ready" },
        { status: "waiting" },
        { status: "offline" },
        { status: "exited" },
      ],
      services: [{}, {}],
      worktrees: [{}],
      tasks: [
        task({ id: "a", status: "in_progress" }),
        task({ id: "b", status: "done" }),
        task({ id: "c", status: "failed" }),
      ],
      notifications: [notif({ id: "n1", unread: true }), notif({ id: "n2", unread: false })],
    });
    expect(result.summary).toMatchObject({
      agentsRunning: 3,
      agentsWaiting: 1,
      agentsOffline: 2,
      services: 2,
      worktrees: 1,
      openTasks: 1,
      doneTasks: 1,
      unreadNotifications: 1,
    });
  });

  it("counts task progress by status", () => {
    const result = buildProjectObservability({
      sessions: [],
      services: [],
      worktrees: [],
      tasks: [
        task({ id: "a", status: "pending" }),
        task({ id: "b", status: "assigned" }),
        task({ id: "c", status: "in_progress" }),
        task({ id: "d", status: "blocked" }),
        task({ id: "e", status: "done" }),
        task({ id: "f", status: "failed" }),
        task({ id: "g", status: "pending" }),
      ],
      notifications: [],
    });
    expect(result.progress).toEqual({
      pending: 2,
      assigned: 1,
      in_progress: 1,
      blocked: 1,
      done: 1,
      failed: 1,
      total: 7,
    });
  });

  it("merges tasks and notifications into a story sorted newest-first", () => {
    const result = buildProjectObservability({
      sessions: [],
      services: [],
      worktrees: [],
      tasks: [task({ id: "old", description: "old task", updatedAt: "2026-06-17T01:00:00.000Z" })],
      notifications: [notif({ id: "new", title: "new notif", createdAt: "2026-06-17T02:00:00.000Z" })],
    });
    expect(result.story.map((s) => s.id)).toEqual(["notif:new", "task:old"]);
    expect(result.story[0]).toMatchObject({ kind: "notification", title: "new notif", status: "unread" });
    expect(result.story[1]).toMatchObject({ kind: "task", title: "old task", status: "pending" });
  });

  it("tags review tasks distinctly and caps the story to storyLimit", () => {
    const tasks = Array.from({ length: 40 }, (_, i) =>
      task({ id: `t${i}`, updatedAt: `2026-06-17T00:00:${String(i).padStart(2, "0")}.000Z` }),
    );
    tasks.push(task({ id: "rev", type: "review", description: "review it", updatedAt: "2026-06-17T03:00:00.000Z" }));
    const result = buildProjectObservability({
      sessions: [],
      services: [],
      worktrees: [],
      tasks,
      notifications: [],
      storyLimit: 5,
    });
    expect(result.story).toHaveLength(5);
    expect(result.story[0]).toMatchObject({ id: "task:rev", kind: "review" });
  });

  it("handles empty inputs without throwing", () => {
    const result = buildProjectObservability({
      sessions: [],
      services: [],
      worktrees: [],
      tasks: [],
      notifications: [],
    });
    expect(result.summary.openTasks).toBe(0);
    expect(result.progress.total).toBe(0);
    expect(result.story).toEqual([]);
  });
});
