import { describe, expect, it, vi } from "vitest";

const renderProjectScreen = vi.hoisted(() => vi.fn());

vi.mock("../tui/screens/subscreen-renderers.js", () => ({
  renderProjectScreen,
}));

import { handleProjectKey, refreshProjectObservability } from "./project.js";

describe("refreshProjectObservability", () => {
  function projectModel(story: any[] = []) {
    return {
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
      story,
    };
  }

  it("loads the project model from the project service", async () => {
    const project = projectModel([
      { id: "notif:1", kind: "notification", title: "Needs input", meta: "needs_input", createdAt: "now" },
    ]);
    const host: any = {
      projectIndex: -1,
      getFromProjectService: vi.fn(async () => ({ ok: true, project })),
    };

    await expect(refreshProjectObservability(host)).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledWith("/project-observability");
    expect(host.projectObservability).toBe(project);
    expect(host.projectObservabilityLoaded).toBe(true);
    expect(host.projectIndex).toBe(0);
  });

  it("coalesces concurrent project refreshes through the TUI API runtime", async () => {
    const project = projectModel([
      { id: "notif:1", kind: "notification", title: "Needs input", meta: "needs_input", createdAt: "now" },
    ]);
    let resolveRefresh!: (value: unknown) => void;
    const host: any = {
      projectIndex: -1,
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
    };

    const first = refreshProjectObservability(host);
    const second = refreshProjectObservability(host);
    resolveRefresh({ ok: true, project });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    expect(host.getFromProjectService).toHaveBeenCalledTimes(1);
    expect(host.projectObservability).toBe(project);
  });

  it("initializes an empty model instead of building from local stores on failure", async () => {
    const host: any = {
      getDashboardSessions: vi.fn(() => [{ status: "running" }]),
      getFromProjectService: vi.fn(async () => ({ ok: true, project: { summary: {}, progress: {}, story: [] } })),
    };

    await expect(refreshProjectObservability(host)).resolves.toBe(false);

    expect(host.getDashboardSessions).not.toHaveBeenCalled();
    expect(host.projectObservabilityLoaded).toBe(true);
    expect(host.projectObservability.story).toEqual([]);
  });

  it("preserves the loaded project model when a refresh payload is invalid", async () => {
    const project = projectModel([{ id: "task:1", kind: "task", title: "Keep me", meta: "open", createdAt: "now" }]);
    const invalidProject = projectModel([
      { id: "thread:1", kind: "thread", title: "Bad", meta: "open", createdAt: "now" },
    ]);
    const host: any = {
      projectObservability: project,
      projectObservabilityLoaded: true,
      projectIndex: 0,
      getFromProjectService: vi.fn(async () => ({ ok: true, project: invalidProject })),
    };

    await expect(refreshProjectObservability(host)).resolves.toBe(false);

    expect(host.projectObservability).toBe(project);
    expect(host.projectObservability.story[0].title).toBe("Keep me");
  });

  it("preserves the loaded project model when the service request rejects", async () => {
    const project = projectModel([
      { id: "task:1", kind: "task", title: "Still here", meta: "assigned", createdAt: "now" },
    ]);
    const host: any = {
      projectObservability: project,
      projectObservabilityLoaded: true,
      getFromProjectService: vi.fn(async () => {
        throw new Error("offline");
      }),
    };

    await expect(refreshProjectObservability(host)).resolves.toBe(false);

    expect(host.projectObservability).toBe(project);
  });

  it("applies a valid empty project model over previously loaded state", async () => {
    const project = projectModel([{ id: "task:old", kind: "task", title: "Old", meta: "assigned", createdAt: "now" }]);
    const emptyProject = projectModel([]);
    const host: any = {
      projectObservability: project,
      projectObservabilityLoaded: true,
      getFromProjectService: vi.fn(async () => ({ ok: true, project: emptyProject })),
    };

    await expect(refreshProjectObservability(host)).resolves.toBe(true);

    expect(host.projectObservability).toBe(emptyProject);
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

  it("keeps the old project model when a pending lifecycle refresh completes after navigation", async () => {
    let resolveRefresh!: (value: unknown) => void;
    const previous = projectModel([
      { id: "task:old", kind: "task", title: "Old", meta: "assigned", createdAt: "now" },
    ]);
    const next = projectModel([
      { id: "task:new", kind: "task", title: "New", meta: "assigned", createdAt: "now" },
    ]);
    const host: any = {
      dashboardInputEpoch: 1,
      projectObservability: previous,
      projectObservabilityLoaded: true,
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
    };

    const refresh = refreshProjectObservability(host, {
      lifecycle: { mode: "dashboard", inputEpoch: 1, requiresInputEpoch: true },
    });
    host.dashboardInputEpoch = 2;
    resolveRefresh({ ok: true, project: next });

    await expect(refresh).resolves.toBe(false);
    expect(host.projectObservability).toBe(previous);
  });

  it("redraws project after manual refresh when input changes but the screen stays active", async () => {
    vi.clearAllMocks();
    let resolveRefresh!: (value: unknown) => void;
    const project = projectModel([]);
    const host: any = {
      dashboardInputEpoch: 1,
      projectObservability: { story: [] },
      getFromProjectService: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      isDashboardScreen: vi.fn((screen: string) => screen === "project"),
      handleDashboardSubscreenNavigationKey: vi.fn(() => false),
    };

    handleProjectKey(host, Buffer.from("r"));
    host.dashboardInputEpoch = 2;
    resolveRefresh({ ok: true, project });

    await vi.waitFor(() => expect(renderProjectScreen).toHaveBeenCalled());
  });
});
