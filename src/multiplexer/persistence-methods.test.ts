import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  };
});

vi.mock("../metadata-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../metadata-store.js")>();
  return {
    ...actual,
    loadMetadataState: vi.fn(() => ({ sessions: {} })),
  };
});

import { DashboardPendingActions } from "../dashboard/pending-actions.js";
import {
  getContextDir,
  getHistoryDir,
  getPlansDir,
  getRecordingsDir,
  getStatePath,
  getStatusDir,
  initPaths,
} from "../paths.js";
import { persistenceMethods } from "./persistence-methods.js";
import { createRuntimeExchangeStore } from "../runtime-core/exchange-store.js";
import {
  listTopologySessionStates,
  moveTopologySessionToGraveyard,
  upsertTopologySession,
} from "../runtime-core/topology-sessions.js";
import { listTopologyServiceStates, upsertTopologyService } from "../runtime-core/topology-services.js";
import {
  listTopologyWorktreeGraveyard,
  listTopologyWorktreeStates,
  moveTopologyWorktreeToGraveyard,
  upsertTopologyWorktree,
} from "../runtime-core/topology-worktrees.js";
import { addDashboardOperationFailure } from "../dashboard/operation-failures.js";

describe("persistenceMethods", () => {
  let pathsRoot = "";

  beforeEach(async () => {
    pathsRoot = mkdtempSync(join(tmpdir(), "aimux-persistence-paths-"));
    await initPaths(pathsRoot);
    listWorktreesMock.mockReset();
    listWorktreesMock.mockReturnValue([]);
    spawnMock.mockReset();
  });

  afterEach(() => {
    rmSync(pathsRoot, { recursive: true, force: true });
  });

  function createStatuslineHost(overrides: Record<string, unknown> = {}) {
    return {
      mode: "project-service",
      sessions: [{ id: "codex-1" }],
      dashboardState: { screen: "dashboard" },
      dashboardUiStateStore: { loadSharedState: vi.fn() },
      repairManagedTmuxTargets: vi.fn(),
      syncTmuxWindowMetadata: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshDesktopStateSnapshot: vi.fn(),
      buildStatuslineSnapshot: vi.fn(() => ({
        project: "repo",
        dashboardScreen: "dashboard",
        sessions: [],
        teammates: [],
        tasks: { pending: 0, assigned: 0 },
        controlPlane: { daemonAlive: true, projectServiceAlive: true },
        flash: null,
        metadata: {},
        updatedAt: "2026-06-21T00:00:00.000Z",
      })),
      lastStatuslineSnapshotKey: null,
      writePrecomputedTmuxStatuslineFiles: vi.fn(),
      tmuxRuntimeManager: { refreshStatus: vi.fn() },
      ...overrides,
    };
  }

  it("writes automatic statusline snapshots without live tmux repair or refresh", () => {
    const host = createStatuslineHost();

    persistenceMethods.writeStatuslineFile.call(host);

    expect(host.repairManagedTmuxTargets).not.toHaveBeenCalled();
    expect(host.syncTmuxWindowMetadata).not.toHaveBeenCalled();
    expect(host.refreshDesktopStateSnapshot).toHaveBeenCalledWith({ includeRuntimeInfo: false });
    expect(host.writePrecomputedTmuxStatuslineFiles).toHaveBeenCalledOnce();
    expect(host.tmuxRuntimeManager.refreshStatus).not.toHaveBeenCalled();
  });

  it("keeps explicit statusline repair on the forced refresh path", () => {
    const host = createStatuslineHost();
    Object.assign(host, {
      writeStatuslineFile: (input?: { force?: boolean; repairTmux?: boolean; refreshTmux?: boolean }) =>
        persistenceMethods.writeStatuslineFile.call(host, input),
    });

    const result = persistenceMethods.refreshProjectStatusline.call(host, { force: true });

    expect(result).toEqual({ ok: true });
    expect(host.repairManagedTmuxTargets).toHaveBeenCalledOnce();
    expect(host.syncTmuxWindowMetadata).toHaveBeenCalledWith("codex-1");
    expect(host.refreshDesktopStateSnapshot).toHaveBeenCalledWith({ includeRuntimeInfo: false });
    expect(host.writePrecomputedTmuxStatuslineFiles).toHaveBeenCalledOnce();
    expect(host.tmuxRuntimeManager.refreshStatus).toHaveBeenCalledOnce();
  });

  it("seeds desktop state when creating a worktree", () => {
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
        worktreeGroups: [
          {
            name: "Main Checkout",
            branch: "master",
            path: undefined,
            status: "offline",
            sessions: [],
            services: [],
          },
        ],
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
    expect(state.worktreeGroups).toEqual([
      expect.objectContaining({
        name: "demo",
        path: "/repo/.aimux/worktrees/demo",
        pending: true,
        pendingAction: "creating",
      }),
      expect.objectContaining({ name: "Main Checkout", path: undefined }),
    ]);
    expect(host.refreshDesktopStateSnapshot).not.toHaveBeenCalled();
  });

  it("records duplicate worktree create failures through the service owner", () => {
    const addFailureMock = vi.mocked(addDashboardOperationFailure);
    addFailureMock.mockClear();
    const pending = new DashboardPendingActions(() => {});
    const host = {
      dashboardPendingActions: pending,
      listDesktopWorktrees: vi.fn(() => [
        {
          name: "demo",
          branch: "demo",
          path: "/repo/.aimux/worktrees/demo",
          status: "offline",
          sessions: [],
          services: [],
        },
      ]),
      mode: "project-service",
      pendingWorktreeCreates: new Map(),
      publishAlert: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      metadataServer: { notifyChange: vi.fn() },
    };

    expect(() => persistenceMethods.createDesktopWorktree.call(host, "demo")).toThrow('Worktree "demo" already exists');

    expect(addFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: "worktree",
        operation: "create",
        worktreePath: "/repo/.aimux/worktrees/demo",
        message: 'Worktree "demo" already exists',
      }),
    );
    expect(host.publishAlert).toHaveBeenCalledWith(expect.objectContaining({ kind: "task_failed" }));
    expect(host.invalidateDesktopStateSnapshot).toHaveBeenCalledOnce();
    expect(host.refreshLocalDashboardModel).toHaveBeenCalledOnce();
    expect(host.metadataServer.notifyChange).toHaveBeenCalledOnce();
  });

  it("cleans up expired standalone graveyard agents and refreshes projections", async () => {
    upsertTopologySession(
      {
        id: "codex-old",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
        createdAt: "2026-05-01T00:00:00.000Z",
      },
      "offline",
      { now: "2026-05-01T00:00:00.000Z", projectRoot: pathsRoot },
    );
    moveTopologySessionToGraveyard("codex-old", { now: "2026-05-30T00:00:00.000Z" });

    const host = {
      mode: "project-service",
      offlineSessions: [{ id: "codex-old" }],
      deleteGraveyardWorktree: vi.fn(),
      loadOfflineTopologySessions: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      writeStatuslineFile: vi.fn(),
      metadataServer: { notifyChange: vi.fn() },
    };

    const result = await persistenceMethods.cleanupGraveyard.call(host, {
      now: "2026-06-14T00:00:00.000Z",
    });

    expect(result.results).toEqual([
      {
        kind: "agent",
        id: "codex-old",
        status: "removed",
        removedAssets: [],
      },
    ]);
    expect(listTopologySessionStates({ statuses: ["graveyard"] })).toEqual([]);
    expect(host.offlineSessions).toEqual([]);
    expect(host.deleteGraveyardWorktree).not.toHaveBeenCalled();
    expect(host.loadOfflineTopologySessions).toHaveBeenCalledOnce();
    expect(host.writeStatuslineFile).toHaveBeenCalledWith({ force: true });
    expect(host.metadataServer.notifyChange).toHaveBeenCalledOnce();
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
    expect(state.worktreeGroups).toEqual([
      expect.objectContaining({ name: "demo", path: worktreePath, pending: true, pendingAction: "creating" }),
    ]);
    expect(host.refreshDesktopStateSnapshot).not.toHaveBeenCalled();
  });

  it("can build API desktop state without the statusline snapshot", () => {
    const pending = new DashboardPendingActions(() => {});
    const host = {
      desktopStateSnapshot: {
        sessions: [],
        teammates: [],
        services: [],
        worktrees: [],
        worktreeGroups: [],
        operationFailures: [],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
        mainCheckoutPath: "/repo",
      },
      dashboardPendingActions: pending,
      refreshDesktopStateSnapshot: vi.fn(),
      buildDesktopStateSnapshot: vi.fn(),
      buildStatuslineSnapshot: vi.fn(() => ({ sessions: [] })),
    };

    const state = persistenceMethods.buildDesktopState.call(host, { includeStatusline: false });

    expect(state).not.toHaveProperty("statusline");
    expect(host.buildStatuslineSnapshot).not.toHaveBeenCalled();
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
        worktrees: [{ name: "demo", branch: "demo", path: "/repo/.aimux/worktrees/demo", isBare: false }],
        worktreeGroups: [
          {
            name: "demo",
            branch: "demo",
            path: "/repo/.aimux/worktrees/demo",
            status: "active",
            sessions: [session],
            services: [service],
          },
        ],
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
    expect(state.worktreeGroups[0]?.sessions).toEqual([
      expect.objectContaining({ id: session.id, pending: true, pendingAction: "stopping" }),
    ]);
    expect(state.worktreeGroups[0]?.services).toEqual([
      expect.objectContaining({ id: service.id, pending: true, pendingAction: "removing" }),
    ]);
  });

  it("keeps normal pending sessions out of teammate desktop-state payloads", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setSessionAction("codex-normal", "creating", {
      sessionSeed: {
        index: 0,
        id: "codex-normal",
        command: "codex",
        status: "running",
        active: false,
      },
    });
    pending.setSessionAction("codex-teammate", "creating", {
      sessionSeed: {
        index: 1,
        id: "codex-teammate",
        command: "codex",
        status: "running",
        active: false,
        team: { teamId: "team-1", parentSessionId: "claude-parent", role: "reviewer" },
      },
    });
    const host = {
      desktopStateSnapshot: {
        sessions: [],
        teammates: [],
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

    expect(state.sessions.map((session) => session.id)).toEqual(["codex-normal"]);
    expect(state.teammates.map((session) => session.id)).toEqual(["codex-teammate"]);
  });

  it("projects pending teammates into the statusline teammate payload only", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setSessionAction("codex-normal", "creating", {
      sessionSeed: {
        index: 0,
        id: "codex-normal",
        command: "codex",
        status: "running",
        active: false,
      },
    });
    pending.setSessionAction("codex-teammate", "creating", {
      sessionSeed: {
        index: 1,
        id: "codex-teammate",
        command: "codex",
        status: "running",
        active: true,
        team: { teamId: "team-1", parentSessionId: "claude-parent", role: "reviewer", label: "review" },
      },
    });
    const host = {
      desktopStateSnapshot: {
        sessions: [],
        teammates: [],
        services: [],
        worktrees: [],
        operationFailures: [],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
        mainCheckoutPath: "/repo",
      },
      dashboardPendingActions: pending,
      dashboardUiStateStore: {
        orderSessionsForWorktree: vi.fn((sessions) => sessions),
        orderServicesForWorktree: vi.fn((services) => services),
      },
      dashboardState: { screen: "dashboard" },
      footerFlash: null,
      refreshDesktopStateSnapshot: vi.fn(),
      buildDesktopStateSnapshot: vi.fn(),
    };

    const statusline = persistenceMethods.buildStatuslineSnapshot.call(host);

    expect(statusline.sessions.map((session) => session.id)).toEqual([]);
    expect(statusline.teammates.map((session) => session.id)).toEqual(["codex-teammate"]);
    expect(statusline.teammates[0]).toEqual(
      expect.objectContaining({
        id: "codex-teammate",
        active: true,
        team: expect.objectContaining({ parentSessionId: "claude-parent" }),
      }),
    );
  });

  it("derives statusline task counts from runtime exchange", () => {
    createRuntimeExchangeStore().update((exchange) => ({
      ...exchange,
      tasks: [
        {
          id: "task-pending",
          description: "Queued",
          prompt: "queued",
          status: "pending",
          assignedBy: "user",
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:00.000Z",
        },
        {
          id: "task-assigned",
          description: "Assigned",
          prompt: "assigned",
          status: "assigned",
          assignedBy: "user",
          assignedTo: "codex-1",
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:00.000Z",
        },
        {
          id: "task-done",
          description: "Done",
          prompt: "done",
          status: "done",
          assignedBy: "user",
          assignedTo: "codex-1",
          createdAt: "2026-05-25T00:00:00.000Z",
          updatedAt: "2026-05-25T00:00:00.000Z",
        },
      ],
    }));

    const host = {
      desktopStateSnapshot: {
        sessions: [],
        teammates: [],
        services: [],
        worktrees: [],
        operationFailures: [],
        mainCheckoutInfo: { name: "Main Checkout", branch: "master" },
      },
      dashboardPendingActions: new DashboardPendingActions(() => {}),
      dashboardUiStateStore: {
        orderSessionsForWorktree: vi.fn((sessions) => sessions),
        orderServicesForWorktree: vi.fn((services) => services),
      },
      dashboardState: { screen: "dashboard" },
      footerFlash: null,
      refreshDesktopStateSnapshot: vi.fn(),
      buildDesktopStateSnapshot: vi.fn(),
    };

    const statusline = persistenceMethods.buildStatuslineSnapshot.call(host);

    expect(statusline.tasks).toEqual({ pending: 1, assigned: 1 });
  });

  it("does not retain stale session or service pending flags when reapplying pending actions", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setSessionAction("codex-normal", "creating", {
      sessionSeed: {
        index: 9,
        id: "codex-normal",
        command: "codex",
        status: "running",
        active: false,
      },
    });
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
          pendingStartedAt: "2026-05-09T12:00:00.000Z",
          optimistic: true,
        },
      ],
      dashboardTeammatesCache: [
        {
          index: 2,
          id: "teammate-1",
          command: "codex",
          status: "offline",
          active: false,
          team: { teamId: "team-1", parentSessionId: "claude-1", role: "reviewer" },
          pending: true,
          pendingAction: "stopping",
          pendingStartedAt: "2026-05-09T12:00:00.000Z",
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
          pendingStartedAt: "2026-05-09T12:00:00.000Z",
          optimistic: true,
        },
      ],
      dashboardWorktreeGroupsCache: [],
      dashboardUiStateStore: { orderWorktreeGroups: vi.fn((groups) => groups) },
    };

    persistenceMethods.reapplyDashboardPendingActions.call(host);

    expect(host.dashboardSessionsCache[0]).not.toHaveProperty("pending");
    expect(host.dashboardSessionsCache[0]).not.toHaveProperty("pendingAction");
    expect(host.dashboardSessionsCache[0]).not.toHaveProperty("pendingStartedAt");
    expect(host.dashboardSessionsCache[0]).not.toHaveProperty("optimistic");
    expect(host.dashboardTeammatesCache.map((session: any) => session.id)).toEqual(["teammate-1"]);
    expect(host.dashboardTeammatesCache[0]).not.toHaveProperty("pending");
    expect(host.dashboardTeammatesCache[0]).not.toHaveProperty("pendingAction");
    expect(host.dashboardTeammatesCache[0]).not.toHaveProperty("pendingStartedAt");
    expect(host.dashboardTeammatesCache[0]).not.toHaveProperty("optimistic");
    expect(host.dashboardServicesCache[0]).not.toHaveProperty("pending");
    expect(host.dashboardServicesCache[0]).not.toHaveProperty("pendingAction");
    expect(host.dashboardServicesCache[0]).not.toHaveProperty("pendingStartedAt");
    expect(host.dashboardServicesCache[0]).not.toHaveProperty("optimistic");
  });

  it("does not turn synthetic pending rows into rendered rows after clearing pending actions", () => {
    const pending = new DashboardPendingActions(() => {});
    const sessionSeed = { index: -1, id: "codex-1", command: "codex", status: "offline", active: false };
    const serviceSeed = { id: "service-1", command: "shell", args: [], status: "offline", active: false };
    const worktreeSeed = {
      name: "demo",
      branch: "demo",
      path: "/repo/.aimux/worktrees/demo",
      sessions: [],
      services: [],
    };
    pending.setSessionAction(sessionSeed.id, "graveyarding", { sessionSeed });
    pending.setServiceAction(serviceSeed.id, "removing", { serviceSeed });
    pending.setWorktreeAction(worktreeSeed.path, "graveyarding", { worktreeSeed });
    const host = {
      dashboardPendingActions: pending,
      dashboardRawSessionsCache: [],
      dashboardRawTeammatesCache: [],
      dashboardRawServicesCache: [],
      dashboardRawWorktreeGroupsCache: [],
      dashboardSessionsCache: pending.applyToSessions([]),
      dashboardTeammatesCache: [],
      dashboardServicesCache: pending.applyToServices([]),
      dashboardWorktreeGroupsCache: pending.applyToWorktrees([]),
      dashboardUiStateStore: { orderWorktreeGroups: vi.fn((groups) => groups) },
    };

    pending.clearSessionAction(sessionSeed.id);
    pending.clearServiceAction(serviceSeed.id);
    pending.clearWorktreeAction(worktreeSeed.path);
    persistenceMethods.reapplyDashboardPendingActions.call(host);

    expect(host.dashboardSessionsCache).toEqual([]);
    expect(host.dashboardTeammatesCache).toEqual([]);
    expect(host.dashboardServicesCache).toEqual([]);
    expect(host.dashboardWorktreeGroupsCache).toEqual([]);
  });

  it("keeps raw worktree lists free of pending removal state", () => {
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
    expect(worktrees[0]).not.toHaveProperty("pendingStartedAt");
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

  it("graveyards a worktree into topology", async () => {
    const worktreePath = "/repo/.aimux/worktrees/demo";
    upsertTopologySession({ id: "codex-demo", tool: "codex", command: "codex", args: [], worktreePath }, "offline");
    upsertTopologyService({ id: "service-demo", command: "zsh", worktreePath }, "stopped");
    const host = {
      listDesktopWorktrees: vi.fn(() => [{ name: "demo", branch: "demo", path: worktreePath }]),
      sessions: [],
      sessionWorktreePaths: new Map(),
      isSessionRuntimeLive: vi.fn(() => false),
      offlineSessions: [],
      offlineServices: [],
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
    };

    await expect(persistenceMethods.graveyardDesktopWorktree.call(host, worktreePath)).resolves.toEqual({
      path: worktreePath,
      status: "graveyarded",
    });

    expect(listTopologyWorktreeStates({ statuses: ["graveyard"] })).toMatchObject([{ path: worktreePath }]);
    expect(listTopologyWorktreeGraveyard()).toMatchObject([{ path: worktreePath, name: "demo" }]);
    expect(listTopologySessionStates().filter((session) => session.worktreePath === worktreePath)).toMatchObject([
      { id: "codex-demo", status: "offline" },
    ]);
    expect(listTopologyServiceStates().filter((service) => service.worktreePath === worktreePath)).toMatchObject([
      { id: "service-demo", status: "stopped" },
    ]);
  });

  it("stops live worktree services without deleting their topology records when graveyarding", async () => {
    const worktreePath = "/repo/.aimux/worktrees/demo";
    const target = { sessionName: "aimux-test", windowId: "@service", windowIndex: 1, windowName: "shell" };
    const killWindow = vi.fn();
    const host = {
      listDesktopWorktrees: vi.fn(() => [{ name: "demo", branch: "demo", path: worktreePath }]),
      sessions: [],
      sessionWorktreePaths: new Map(),
      isSessionRuntimeLive: vi.fn(() => false),
      offlineSessions: [],
      offlineServices: [],
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => [
          {
            target,
            metadata: {
              kind: "service",
              sessionId: "service-demo",
              command: "zsh",
              args: ["-l"],
              toolConfigKey: "service",
              createdAt: "2026-05-01T00:00:00.000Z",
              worktreePath,
              label: "shell",
              launchCommandLine: "yarn web",
            },
          },
        ]),
        killWindow,
      },
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
    };

    await expect(persistenceMethods.graveyardDesktopWorktree.call(host, worktreePath)).resolves.toEqual({
      path: worktreePath,
      status: "graveyarded",
    });

    expect(killWindow).toHaveBeenCalledWith(target);
    expect(host.offlineServices).toMatchObject([{ id: "service-demo", worktreePath, launchCommandLine: "yarn web" }]);
    expect(listTopologyServiceStates({ statuses: ["stopped"] })).toMatchObject([
      { id: "service-demo", worktreePath, launchCommandLine: "yarn web" },
    ]);
  });

  it("resurrects topology worktree graveyard entries", async () => {
    const worktreePath = join(pathsRoot, "worktrees", "demo");
    mkdirSync(worktreePath, { recursive: true });
    upsertTopologyWorktree({ path: worktreePath, name: "demo", branch: "demo" }, "active");
    upsertTopologySession({ id: "codex-demo", tool: "codex", command: "codex", args: [], worktreePath }, "offline");
    upsertTopologyService({ id: "service-demo", command: "zsh", worktreePath }, "stopped");
    moveTopologyWorktreeToGraveyard(worktreePath);
    const host = {
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      metadataServer: { notifyChange: vi.fn() },
    };

    await expect(persistenceMethods.resurrectGraveyardWorktree.call(host, worktreePath)).resolves.toEqual({
      path: worktreePath,
      status: "active",
    });

    expect(listTopologyWorktreeGraveyard()).toEqual([]);
    expect(listTopologyWorktreeStates({ statuses: ["active"] })).toMatchObject([{ path: worktreePath }]);
    expect(listTopologySessionStates().filter((session) => session.worktreePath === worktreePath)).toMatchObject([
      { id: "codex-demo", status: "offline" },
    ]);
    expect(listTopologyServiceStates().filter((service) => service.worktreePath === worktreePath)).toMatchObject([
      { id: "service-demo", status: "stopped" },
    ]);
    expect(host.metadataServer.notifyChange).toHaveBeenCalled();
  });

  it("does not resurrect graveyarded worktrees when the checkout is missing", async () => {
    const worktreePath = join(pathsRoot, "worktrees", "missing");
    upsertTopologyWorktree({ path: worktreePath, name: "missing", branch: "missing" }, "active");
    moveTopologyWorktreeToGraveyard(worktreePath);
    const host = {
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      metadataServer: { notifyChange: vi.fn() },
    };

    await expect(persistenceMethods.resurrectGraveyardWorktree.call(host, worktreePath)).rejects.toThrow(
      `Cannot resurrect worktree "${worktreePath}" because the checkout is missing`,
    );

    expect(listTopologyWorktreeGraveyard()).toMatchObject([{ path: worktreePath }]);
    expect(listTopologyWorktreeStates({ statuses: ["active"] })).toEqual([]);
    expect(host.invalidateDesktopStateSnapshot).not.toHaveBeenCalled();
    expect(host.metadataServer.notifyChange).not.toHaveBeenCalled();
  });

  it("keeps graveyard entries visible when delete physical removal fails", async () => {
    const worktreePath = join(pathsRoot, "worktrees", "demo");
    mkdirSync(worktreePath, { recursive: true });
    upsertTopologyWorktree({ path: worktreePath, name: "demo", branch: "demo" }, "active");
    upsertTopologySession({ id: "codex-demo", tool: "codex", command: "codex", args: [], worktreePath }, "offline");
    moveTopologyWorktreeToGraveyard(worktreePath);
    const contextDir = join(getContextDir(), "codex-demo");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(getRecordingsDir(), { recursive: true });
    writeFileSync(join(contextDir, "live.md"), "live\n");
    writeFileSync(join(getRecordingsDir(), "codex-demo.log"), "raw\n");
    const child = createSpawnChild();
    spawnMock.mockReturnValueOnce(child);
    const host = {
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      metadataServer: { notifyChange: vi.fn() },
    };

    const result = persistenceMethods.deleteGraveyardWorktree.call(host, worktreePath);
    child.stderr.emit("data", Buffer.from("remove failed\n"));
    child.emit("close", 1);

    await expect(result).rejects.toThrow("remove failed");

    expect(listTopologyWorktreeGraveyard()).toMatchObject([{ path: worktreePath }]);
    expect(existsSync(contextDir)).toBe(true);
    expect(existsSync(join(getRecordingsDir(), "codex-demo.log"))).toBe(true);
    expect(host.invalidateDesktopStateSnapshot).not.toHaveBeenCalled();
  });

  it("deletes existing graveyarded worktree checkouts even when hidden from active worktree lists", async () => {
    const worktreePath = join(pathsRoot, "external-worktrees", "demo");
    mkdirSync(worktreePath, { recursive: true });
    upsertTopologyWorktree({ path: worktreePath, name: "demo", branch: "demo" }, "active");
    upsertTopologySession({ id: "codex-demo", tool: "codex", command: "codex", args: [], worktreePath }, "offline");
    upsertTopologyService({ id: "service-demo", command: "zsh", worktreePath }, "stopped");
    moveTopologyWorktreeToGraveyard(worktreePath);
    const child = createSpawnChild();
    spawnMock.mockReturnValueOnce(child);
    const host = {
      listDesktopWorktrees: vi.fn(() => []),
      offlineSessions: [{ id: "codex-demo", worktreePath }],
      offlineServices: [{ id: "service-demo", worktreePath }],
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      metadataServer: { notifyChange: vi.fn() },
    };

    const result = persistenceMethods.deleteGraveyardWorktree.call(host, worktreePath);
    child.emit("close", 0);

    await expect(result).resolves.toEqual({ path: worktreePath, status: "removed" });

    expect(spawnMock).toHaveBeenCalledWith("git", ["worktree", "remove", worktreePath, "--force"], {
      cwd: "/repo",
      stdio: ["ignore", "ignore", "pipe"],
    });
    expect(listTopologyWorktreeGraveyard()).toEqual([]);
    expect(listTopologySessionStates().filter((session) => session.worktreePath === worktreePath)).toEqual([]);
    expect(listTopologyServiceStates().filter((service) => service.worktreePath === worktreePath)).toEqual([]);
    expect(host.offlineSessions).toEqual([]);
    expect(host.offlineServices).toEqual([]);
    expect(host.saveState).toHaveBeenCalled();
    expect(host.metadataServer.notifyChange).toHaveBeenCalled();
  });

  it("preserves deleted graveyard audit history when the worktree path is already gone", async () => {
    const worktreePath = join(pathsRoot, "worktrees", "gone");
    upsertTopologyWorktree({ path: worktreePath, name: "gone", branch: "gone" }, "active");
    upsertTopologySession({ id: "codex-gone", tool: "codex", command: "codex", args: [], worktreePath }, "offline");
    upsertTopologyService({ id: "service-gone", command: "zsh", worktreePath }, "stopped");
    moveTopologyWorktreeToGraveyard(worktreePath);
    spawnMock.mockImplementation(() => {
      const child = createSpawnChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    const host = {
      offlineSessions: [{ id: "codex-gone", worktreePath }],
      offlineServices: [{ id: "service-gone", worktreePath }],
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      metadataServer: { notifyChange: vi.fn() },
    };

    await expect(persistenceMethods.deleteGraveyardWorktree.call(host, worktreePath)).resolves.toEqual({
      path: worktreePath,
      status: "removed",
    });

    expect(listTopologyWorktreeGraveyard()).toEqual([]);
    expect(listTopologyWorktreeGraveyard({ includeDeleted: true })).toMatchObject([
      { path: worktreePath, deletedAt: expect.any(String) },
    ]);
    expect(listTopologySessionStates().filter((session) => session.worktreePath === worktreePath)).toEqual([]);
    expect(listTopologyServiceStates().filter((service) => service.worktreePath === worktreePath)).toEqual([]);
    expect(host.offlineSessions).toEqual([]);
    expect(host.offlineServices).toEqual([]);
    expect(spawnMock).toHaveBeenCalledWith("git", ["worktree", "prune"], {
      cwd: "/repo",
      stdio: ["ignore", "ignore", "ignore"],
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("deletes dependent agent assets when deleting a graveyarded worktree", async () => {
    const worktreePath = join(pathsRoot, "worktrees", "with-agent-assets");
    upsertTopologyWorktree({ path: worktreePath, name: "with-agent-assets", branch: "with-agent-assets" }, "active");
    upsertTopologySession({ id: "codex-assets", tool: "codex", command: "codex", args: [], worktreePath }, "offline");
    moveTopologyWorktreeToGraveyard(worktreePath);
    const contextDir = join(getContextDir(), "codex-assets");
    mkdirSync(contextDir, { recursive: true });
    mkdirSync(getRecordingsDir(), { recursive: true });
    writeFileSync(join(contextDir, "live.md"), "live\n");
    writeFileSync(join(getRecordingsDir(), "codex-assets.log"), "raw\n");
    writeFileSync(join(getRecordingsDir(), "codex-assets.txt"), "text\n");
    writeFileSync(join(getHistoryDir(), "codex-assets.jsonl"), "{}\n");
    writeFileSync(join(getPlansDir(), "codex-assets.md"), "# plan\n");
    writeFileSync(join(getStatusDir(), "codex-assets.md"), "status\n");
    const host = {
      offlineSessions: [{ id: "codex-assets", worktreePath }],
      offlineServices: [],
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      metadataServer: { notifyChange: vi.fn() },
    };

    await expect(persistenceMethods.deleteGraveyardWorktree.call(host, worktreePath)).resolves.toEqual({
      path: worktreePath,
      status: "removed",
    });

    expect(existsSync(contextDir)).toBe(false);
    expect(existsSync(join(getRecordingsDir(), "codex-assets.log"))).toBe(false);
    expect(existsSync(join(getRecordingsDir(), "codex-assets.txt"))).toBe(false);
    expect(existsSync(join(getHistoryDir(), "codex-assets.jsonl"))).toBe(false);
    expect(existsSync(join(getPlansDir(), "codex-assets.md"))).toBe(false);
    expect(existsSync(join(getStatusDir(), "codex-assets.md"))).toBe(false);
    expect(listTopologySessionStates().filter((session) => session.worktreePath === worktreePath)).toEqual([]);
  });

  it("does not detach worktree services when graveyarding is blocked by a live agent", async () => {
    const pending = new DashboardPendingActions(() => {});
    const worktreePath = "/repo/.aimux/worktrees/demo";
    const service = {
      id: "service-1",
      command: "shell",
      label: "shell",
      worktreePath,
    };
    const serviceTarget = { sessionName: "aimux", windowName: "service" };
    const killWindow = vi.fn();
    listWorktreesMock.mockReturnValue([
      {
        name: "demo",
        branch: "demo",
        path: worktreePath,
        isBare: false,
      },
    ]);
    const liveSession = {
      id: "claude-1",
      command: "claude",
      backendSessionId: "backend-claude-1",
      startTime: Date.parse("2026-05-01T00:00:00.000Z"),
      exited: false,
      kill: vi.fn(),
    };
    const host = {
      dashboardPendingActions: pending,
      footerFlash: "",
      footerFlashTicks: 0,
      syncSessionsFromTopology: vi.fn(),
      listDesktopWorktrees: vi.fn(() => [{ name: "demo", branch: "demo", path: worktreePath }]),
      listWorktreeGraveyardEntries: vi.fn(() => []),
      invalidateDesktopStateSnapshot: vi.fn(),
      refreshLocalDashboardModel: vi.fn(),
      mode: "project-service",
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => [
          {
            target: serviceTarget,
            metadata: {
              kind: "service",
              sessionId: service.id,
              worktreePath,
            },
          },
        ]),
        killWindow,
      },
      offlineServices: [service],
      buildLiveServiceStates: vi.fn(() => [service]),
      offlineSessions: [],
      sessions: [liveSession],
      sessionWorktreePaths: new Map([["claude-1", worktreePath]]),
      sessionToolKeys: new Map([["claude-1", "claude"]]),
      sessionOriginalArgs: new Map([["claude-1", []]]),
      stoppingSessionIds: new Set(),
      getSessionLabel: vi.fn(() => "claude"),
      deriveHeadline: vi.fn(() => "working"),
      noteLastUsedItem: vi.fn(),
      isSessionRuntimeLive: vi.fn(() => true),
      saveState: vi.fn(),
      debug: vi.fn(),
    };

    await expect(persistenceMethods.graveyardDesktopWorktree.call(host, worktreePath)).rejects.toThrow(
      'Cannot graveyard "demo" while agent "claude-1" is attached',
    );

    expect(liveSession.kill).not.toHaveBeenCalled();
    expect(host.offlineServices).toEqual([service]);
    expect(killWindow).not.toHaveBeenCalled();
    expect(pending.getWorktreeAction(worktreePath)).toBeUndefined();
  });

  it("resurrects graveyard sessions into offline topology state", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-resurrect-team-"));
    try {
      await initPaths(repoRoot);
      const parent = { id: "claude-parent", command: "claude", toolConfigKey: "claude", args: [] };
      const teammate = {
        id: "codex-reviewer",
        command: "codex",
        toolConfigKey: "codex",
        args: [],
        team: { teamId: "team-claude-parent", parentSessionId: "claude-parent", role: "reviewer" },
      };
      const nested = {
        id: "claude-nested",
        command: "claude",
        toolConfigKey: "claude",
        args: [],
        team: { teamId: "team-codex-reviewer", parentSessionId: "codex-reviewer", role: "reviewer" },
      };
      const independent = { id: "codex-independent", command: "codex", toolConfigKey: "codex", args: [] };
      for (const session of [parent, teammate, nested, independent]) {
        upsertTopologySession(
          { ...session, tool: session.command, lifecycle: "offline", worktreePath: repoRoot },
          "graveyard",
        );
      }
      writeFileSync(getStatePath(), JSON.stringify({ savedAt: "now", cwd: repoRoot, sessions: [] }, null, 2) + "\n");
      const host = {
        offlineSessions: [],
        loadOfflineTopologySessions: vi.fn(),
        listGraveyardEntries: vi.fn(() => listTopologySessionStates({ statuses: ["graveyard"] })),
      };

      await expect(persistenceMethods.resurrectGraveyardSession.call(host, "claude-parent")).resolves.toEqual({
        sessionId: "claude-parent",
        status: "offline",
      });

      expect(host.offlineSessions.map((session: any) => session.id)).toEqual(["claude-parent"]);
      expect(listTopologySessionStates({ statuses: ["graveyard"] }).map((session: any) => session.id)).toEqual([
        "codex-reviewer",
        "claude-nested",
        "codex-independent",
      ]);
      expect(listTopologySessionStates({ statuses: ["offline"] }).map((session: any) => session.id)).toEqual([
        "claude-parent",
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("resurrects teammate graveyard sessions without resurrecting the parent", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-resurrect-teammate-"));
    try {
      await initPaths(repoRoot);
      const parent = { id: "claude-parent", command: "claude", toolConfigKey: "claude", args: [] };
      const teammate = {
        id: "codex-reviewer",
        command: "codex",
        toolConfigKey: "codex",
        args: [],
        team: { teamId: "team-claude-parent", parentSessionId: "claude-parent", role: "reviewer" },
      };
      for (const session of [parent, teammate]) {
        upsertTopologySession(
          { ...session, tool: session.command, lifecycle: "offline", worktreePath: repoRoot },
          "graveyard",
        );
      }
      writeFileSync(getStatePath(), JSON.stringify({ savedAt: "now", cwd: repoRoot, sessions: [] }, null, 2) + "\n");
      const host = {
        offlineSessions: [],
        loadOfflineTopologySessions: vi.fn(),
        listGraveyardEntries: vi.fn(() => listTopologySessionStates({ statuses: ["graveyard"] })),
      };

      await expect(persistenceMethods.resurrectGraveyardSession.call(host, "codex-reviewer")).resolves.toEqual({
        sessionId: "codex-reviewer",
        status: "offline",
      });

      expect(host.offlineSessions.map((session: any) => session.id)).toEqual(["codex-reviewer"]);
      expect(listTopologySessionStates({ statuses: ["graveyard"] }).map((session: any) => session.id)).toEqual([
        "claude-parent",
      ]);
      expect(listTopologySessionStates({ statuses: ["offline"] }).map((session: any) => session.id)).toEqual([
        "codex-reviewer",
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

function createSpawnChild(): EventEmitter & { stderr: EventEmitter; stdout: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; stdout: EventEmitter };
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  return child;
}
