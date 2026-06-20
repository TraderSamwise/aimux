import { describe, expect, it, vi } from "vitest";

const renderProjectScreen = vi.hoisted(() => vi.fn());

vi.mock("../tui/screens/subscreen-renderers.js", () => ({
  renderProjectScreen,
}));

import { handleProjectKey, refreshProjectObservability } from "./project.js";

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

  it("does not redraw project after manual refresh when the user has navigated away", async () => {
    let resolveRefresh!: (value: unknown) => void;
    const host: any = {
      projectObservability: { story: [] },
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      isDashboardScreen: vi.fn(() => false),
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
    };

    handleProjectKey(host, Buffer.from("r"));
    resolveRefresh({ ok: true, project: { summary: {}, progress: {}, story: [] } });
    await vi.waitFor(() => expect(host.getFromProjectService).toHaveBeenCalledWith("/project-observability"));
    await Promise.resolve();

    expect(renderProjectScreen).not.toHaveBeenCalled();
  });
});
