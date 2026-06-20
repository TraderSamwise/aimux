import { describe, expect, it, vi } from "vitest";

import { refreshProjectObservability } from "./project.js";

describe("refreshProjectObservability", () => {
  it("loads the project model from the project service", async () => {
    const project = {
      summary: {
        agentsRunning: 1,
        agentsWaiting: 0,
        agentsOffline: 0,
        services: 0,
        worktrees: 1,
        openTasks: 0,
        doneTasks: 0,
        unreadNotifications: 0,
      },
      progress: { pending: 0, assigned: 0, in_progress: 0, blocked: 0, done: 0, failed: 0, total: 0 },
      story: [{ id: "notif:1", kind: "notification", title: "Needs input", meta: "needs_input", createdAt: "now" }],
    };
    const host: any = {
      projectIndex: 9,
      getFromProjectService: vi.fn(async () => ({ ok: true, project })),
    };

    await expect(refreshProjectObservability(host)).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledWith("/project-observability");
    expect(host.projectObservability).toBe(project);
    expect(host.projectIndex).toBe(0);
  });

  it("initializes an empty model instead of building from local stores on failure", async () => {
    const host: any = {
      getDashboardSessions: vi.fn(() => [{ status: "running" }]),
      getFromProjectService: vi.fn(async () => ({ ok: true, project: { summary: {}, progress: {} } })),
    };

    await expect(refreshProjectObservability(host)).resolves.toBe(false);

    expect(host.getDashboardSessions).not.toHaveBeenCalled();
    expect(host.projectObservability.story).toEqual([]);
  });
});
