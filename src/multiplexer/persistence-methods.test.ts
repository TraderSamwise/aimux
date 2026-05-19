import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listWorktreesMock, spawnMock } = vi.hoisted(() => ({
  listWorktreesMock: vi.fn(() => []),
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("../worktree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree.js")>();
  return {
    ...actual,
    findMainRepo: vi.fn(() => "/repo"),
    getWorktreeBaseDir: vi.fn(() => "/repo/.aimux/worktrees"),
    getWorktreeCreatePath: vi.fn((name: string) => `/repo/.aimux/worktrees/${name}`),
    getWorktreeAddArgs: vi.fn((name: string, targetPath: string) => ["worktree", "add", "-b", name, targetPath]),
    isToolInternalWorktree: vi.fn(() => false),
    listWorktrees: listWorktreesMock,
  };
});

vi.mock("../dashboard/operation-failures.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dashboard/operation-failures.js")>();
  return {
    ...actual,
    addDashboardOperationFailure: vi.fn((input) => ({
      id: "failure",
      createdAt: "2026-05-01T00:00:00.000Z",
      ...input,
    })),
    clearDashboardOperationFailures: vi.fn(),
    listDashboardOperationFailures: vi.fn(() => []),
  };
});

vi.mock("./worktree-graveyard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worktree-graveyard.js")>();
  return {
    ...actual,
    listWorktreeGraveyardEntries: vi.fn(() => []),
    listWorktreeGraveyardPaths: vi.fn(() => new Set<string>()),
    writeWorktreeGraveyardEntries: vi.fn(),
  };
});

import { DashboardPendingActions } from "../dashboard/pending-actions.js";
import { persistenceMethods } from "./persistence-methods.js";

describe("persistenceMethods", () => {
  beforeEach(() => {
    listWorktreesMock.mockReset();
    listWorktreesMock.mockReturnValue([]);
    spawnMock.mockReset();
  });

  it("seeds desktop-state projection when creating a worktree", () => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      stdout: EventEmitter;
    };
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    spawnMock.mockReturnValueOnce(child);

    const pending = new DashboardPendingActions(() => {});
    const host = {
      desktopStateSnapshot: {
        sessions: [],
        services: [],
        worktrees: [],
        operationFailures: [],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
        mainCheckoutPath: "/repo",
      },
      dashboardPendingActions: pending,
      footerFlash: "",
      footerFlashTicks: 0,
      listDesktopWorktrees: vi.fn(() => []),
      mode: "project-service",
      pendingWorktreeCreates: new Map(),
      refreshLocalDashboardModel: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshDesktopStateSnapshot: vi.fn(),
      buildDesktopStateSnapshot: vi.fn(),
      buildStatuslineSnapshot: vi.fn(() => ({})),
    };

    const result = persistenceMethods.createDesktopWorktree.call(host, "demo");
    const state = persistenceMethods.buildDesktopState.call(host);

    expect(result).toEqual({ path: "/repo/.aimux/worktrees/demo", status: "creating" });
    expect(spawnMock).toHaveBeenCalledWith("git", ["worktree", "add", "-b", "demo", "/repo/.aimux/worktrees/demo"], {
      cwd: "/repo",
      stdio: ["ignore", "ignore", "pipe"],
    });
    expect(state.worktrees).toEqual([
      expect.objectContaining({
        name: "demo",
        branch: "demo",
        path: "/repo/.aimux/worktrees/demo",
        isBare: false,
        pending: true,
        pendingAction: "creating",
        optimistic: true,
      }),
    ]);
    expect(host.refreshDesktopStateSnapshot).not.toHaveBeenCalled();
  });

  it("projects in-flight worktree creates into desktop-state snapshots", () => {
    const pending = new DashboardPendingActions(() => {});
    const worktreePath = "/repo/.aimux/worktrees/demo";
    pending.setWorktreeAction(worktreePath, "creating", {
      worktreeSeed: {
        name: "demo",
        branch: "demo",
        path: worktreePath,
        createdAt: "2026-05-01T00:00:00.000Z",
        status: "offline",
        isBare: false,
        sessions: [],
        services: [],
      },
    });
    const host = {
      desktopStateSnapshot: {
        sessions: [],
        services: [],
        worktrees: [],
        operationFailures: [],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
        mainCheckoutPath: "/repo",
      },
      dashboardPendingActions: pending,
      refreshDesktopStateSnapshot: vi.fn(),
      buildDesktopStateSnapshot: vi.fn(),
      buildStatuslineSnapshot: vi.fn(() => ({})),
    };

    const state = persistenceMethods.buildDesktopState.call(host);

    expect(state.worktrees).toEqual([
      expect.objectContaining({
        name: "demo",
        branch: "demo",
        path: worktreePath,
        isBare: false,
        pending: true,
        pendingAction: "creating",
        optimistic: true,
      }),
    ]);
    expect(host.refreshDesktopStateSnapshot).not.toHaveBeenCalled();
  });

  it("projects in-flight worktree creates into projected worktree lists", () => {
    const pending = new DashboardPendingActions(() => {});
    const worktreePath = "/repo/.aimux/worktrees/demo";
    pending.setWorktreeAction(worktreePath, "creating", {
      worktreeSeed: {
        name: "demo",
        branch: "demo",
        path: worktreePath,
        createdAt: "2026-05-01T00:00:00.000Z",
        status: "offline",
        isBare: false,
        sessions: [],
        services: [],
      },
    });
    const host = {
      dashboardPendingActions: pending,
      pendingWorktreeRemovals: new Map(),
    };

    host.listDesktopWorktrees = vi.fn(() => []);

    const worktrees = persistenceMethods.listProjectedDesktopWorktrees.call(host);

    expect(worktrees).toEqual([
      expect.objectContaining({
        name: "demo",
        branch: "demo",
        path: worktreePath,
        isBare: false,
        pending: true,
        pendingAction: "creating",
        optimistic: true,
      }),
    ]);
  });

  it("projects remove worktree pending actions into desktop-state snapshots", () => {
    const pending = new DashboardPendingActions(() => {});
    const worktree = {
      name: "demo",
      branch: "demo",
      path: "/repo/.aimux/worktrees/demo",
      status: "offline",
      isBare: false,
      sessions: [],
      services: [],
    };
    pending.setWorktreeAction(worktree.path, "removing");
    const host = {
      desktopStateSnapshot: {
        sessions: [],
        services: [],
        worktrees: [worktree],
        operationFailures: [],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
        mainCheckoutPath: "/repo",
      },
      dashboardPendingActions: pending,
      refreshDesktopStateSnapshot: vi.fn(),
      buildDesktopStateSnapshot: vi.fn(),
      buildStatuslineSnapshot: vi.fn(() => ({})),
    };

    const state = persistenceMethods.buildDesktopState.call(host);

    expect(state.worktrees).toEqual([
      expect.objectContaining({
        path: worktree.path,
        pending: true,
        pendingAction: "removing",
        removing: true,
        optimistic: true,
      }),
    ]);
  });

  it("projects session and service pending actions into desktop-state snapshots", () => {
    const pending = new DashboardPendingActions(() => {});
    const session = {
      index: 1,
      id: "claude-1",
      command: "claude",
      label: "claude",
      status: "running" as const,
      active: false,
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const service = {
      id: "service-1",
      command: "shell",
      args: [],
      label: "shell",
      status: "offline" as const,
      active: false,
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    pending.setSessionAction(session.id, "stopping", { sessionSeed: session });
    pending.setServiceAction(service.id, "removing", { serviceSeed: service });
    const host = {
      desktopStateSnapshot: {
        sessions: [session],
        services: [service],
        worktrees: [],
        operationFailures: [],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
        mainCheckoutPath: "/repo",
      },
      dashboardPendingActions: pending,
      refreshDesktopStateSnapshot: vi.fn(),
      buildDesktopStateSnapshot: vi.fn(),
      buildStatuslineSnapshot: vi.fn(() => ({})),
    };

    const state = persistenceMethods.buildDesktopState.call(host);

    expect(state.sessions).toEqual([
      expect.objectContaining({
        id: session.id,
        pending: true,
        pendingAction: "stopping",
        optimistic: true,
      }),
    ]);
    expect(state.services).toEqual([
      expect.objectContaining({
        id: service.id,
        pending: true,
        pendingAction: "removing",
        optimistic: true,
      }),
    ]);
  });

  it("does not retain stale session or service pending flags when reapplying pending actions", () => {
    const pending = new DashboardPendingActions(() => {});
    const host = {
      dashboardPendingActions: pending,
      dashboardSessionsCache: [
        {
          index: 1,
          id: "claude-1",
          command: "claude",
          status: "offline",
          active: false,
          pending: true,
          pendingAction: "stopping",
          optimistic: true,
        },
      ],
      dashboardServicesCache: [
        {
          id: "service-1",
          command: "shell",
          args: [],
          status: "offline",
          active: false,
          pending: true,
          pendingAction: "removing",
          optimistic: true,
        },
      ],
      dashboardWorktreeGroupsCache: [],
      dashboardUiStateStore: { orderWorktreeGroups: vi.fn((groups) => groups) },
    };

    persistenceMethods.reapplyDashboardPendingActions.call(host);

    expect(host.dashboardSessionsCache[0]).not.toHaveProperty("pending");
    expect(host.dashboardSessionsCache[0]).not.toHaveProperty("pendingAction");
    expect(host.dashboardSessionsCache[0]).not.toHaveProperty("optimistic");
    expect(host.dashboardServicesCache[0]).not.toHaveProperty("pending");
    expect(host.dashboardServicesCache[0]).not.toHaveProperty("pendingAction");
    expect(host.dashboardServicesCache[0]).not.toHaveProperty("optimistic");
  });

  it("keeps raw worktree lists free of pending removal projection", () => {
    const pending = new DashboardPendingActions(() => {});
    const worktreePath = "/repo/.aimux/worktrees/demo";
    listWorktreesMock.mockReturnValue([
      {
        name: "demo",
        branch: "demo",
        path: worktreePath,
        isBare: false,
      },
    ]);
    pending.setWorktreeAction(worktreePath, "removing");
    const host = {
      dashboardPendingActions: pending,
      pendingWorktreeRemovals: new Map([[worktreePath, Promise.resolve({ path: worktreePath, status: "removed" })]]),
    };

    const worktrees = persistenceMethods.listDesktopWorktrees.call(host);

    expect(worktrees).toEqual([
      expect.objectContaining({
        name: "demo",
        path: worktreePath,
      }),
    ]);
    expect(worktrees[0]).not.toHaveProperty("pending");
    expect(worktrees[0]).not.toHaveProperty("pendingAction");
    expect(worktrees[0]).not.toHaveProperty("removing");
  });

  it("projects raw worktree removal state only through projected worktree lists", () => {
    const pending = new DashboardPendingActions(() => {});
    const worktreePath = "/repo/.aimux/worktrees/demo";
    listWorktreesMock.mockReturnValue([
      {
        name: "demo",
        branch: "demo",
        path: worktreePath,
        isBare: false,
      },
    ]);
    pending.setWorktreeAction(worktreePath, "removing");
    const host = {
      dashboardPendingActions: pending,
      listDesktopWorktrees: vi.fn(() =>
        persistenceMethods.listDesktopWorktrees.call({ dashboardPendingActions: pending }),
      ),
    };

    const worktrees = persistenceMethods.listProjectedDesktopWorktrees.call(host);

    expect(worktrees).toEqual([
      expect.objectContaining({
        name: "demo",
        path: worktreePath,
        pending: true,
        pendingAction: "removing",
        removing: true,
        optimistic: true,
      }),
    ]);
  });
});
