import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
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
    listWorktrees: vi.fn(() => []),
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

  it("projects in-flight worktree creates into worktree lists", () => {
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

    const worktrees = persistenceMethods.listDesktopWorktrees.call(host);

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

  it("does not project non-create worktree pending actions into desktop-state snapshots", () => {
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

    expect(state.worktrees).toEqual([worktree]);
  });
});
