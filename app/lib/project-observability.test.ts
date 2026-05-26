import { describe, expect, it } from "vitest";
import type { NotificationRecord, TaskSummaryResponse } from "@/lib/api";
import type { DesktopState } from "@/lib/desktop-state";
import { buildProjectObservability } from "@/lib/project-observability";

function notification(input: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: input.id ?? "n1",
    title: input.title ?? "Update",
    body: input.body ?? "",
    unread: input.unread ?? false,
    cleared: false,
    createdAt: input.createdAt ?? "2026-05-27T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-05-27T00:00:00.000Z",
    ...input,
  };
}

describe("project observability model", () => {
  it("rolls desktop state, tasks, and notifications into project sections", () => {
    const desktopState: DesktopState = {
      ok: true,
      sessions: [
        { id: "a1", status: "running" },
        { id: "a2", status: "waiting" },
      ],
      services: [{ id: "web", status: "offline" }],
      worktrees: [{ name: "feature", path: "/repo/feature", branch: "feature" }],
    };
    const tasks: TaskSummaryResponse[] = [
      { id: "t1", description: "Ship topology", status: "pending" },
      { id: "t2", description: "Close review", status: "completed" },
    ];

    const model = buildProjectObservability({
      desktopState,
      tasks,
      notifications: [
        notification({ id: "n1", title: "Proof screenshot captured", unread: true }),
        notification({ id: "n2", title: "Tests passed", unread: false }),
      ],
    });

    expect(model.summary).toMatchObject({
      agents: 2,
      services: 1,
      worktrees: 1,
      running: 1,
      waiting: 1,
      offline: 1,
      tasks: 2,
      openTasks: 1,
      unreadNotifications: 1,
    });
    expect(model.openTasks.map((task) => task.id)).toEqual(["t1"]);
    expect(model.completedTasks.map((task) => task.id)).toEqual(["t2"]);
    expect(model.artifactHints.map((item) => item.id)).toContain("notification:n1");
    expect(model.verificationHints.map((item) => item.id)).toContain("notification:n2");
  });
});
