import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DashboardPendingActions } from "../dashboard/pending-actions.js";
import { initPaths } from "../paths.js";
import { saveRuntimeTopologySessions } from "../runtime-core/topology-sessions.js";
import {
  applyDashboardModel,
  buildDashboardWorktreeGroups,
  composeDashboardWorktreeGroups,
  startProjectServices,
  withMetadataServicePending,
  withMetadataSessionPending,
} from "./dashboard-model.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("buildDashboardWorktreeGroups", () => {
  it("always includes main checkout as the first group", () => {
    const groups = buildDashboardWorktreeGroups(
      {},
      [
        {
          index: 0,
          id: "main-agent",
          command: "codex",
          status: "running",
          active: false,
        },
      ],
      [],
      [
        {
          name: "Main Checkout",
          path: "/repo",
          branch: "master",
          isBare: false,
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        {
          name: "feature-a",
          path: "/repo/.aimux/worktrees/feature-a",
          branch: "feature-a",
          isBare: false,
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ],
      "/repo",
    );

    expect(groups.map((group) => [group.path, group.name, group.branch])).toEqual([
      [undefined, "Main Checkout", "master"],
      ["/repo/.aimux/worktrees/feature-a", "feature-a", "feature-a"],
    ]);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["main-agent"]);
  });

  it("places optimistic creating sessions into the correct worktree group", () => {
    const groups = composeDashboardWorktreeGroups(
      [
        {
          name: "Main Checkout",
          branch: "master",
          path: undefined,
          status: "offline",
          sessions: [],
          services: [],
        },
        {
          name: "demo",
          branch: "demo",
          path: "/repo/.aimux/worktrees/demo",
          status: "offline",
          sessions: [],
          services: [],
        },
      ],
      [
        {
          index: -1,
          id: "claude-new",
          command: "claude",
          label: "claude",
          status: "waiting",
          active: false,
          worktreePath: "/repo/.aimux/worktrees/demo",
          pendingAction: "creating",
          optimistic: true,
        },
      ],
      [],
    );

    expect(groups[1]?.sessions.map((session) => session.id)).toEqual(["claude-new"]);
    expect(groups[1]?.status).toBe("active");
  });

  it("preserves worktree operation failure state in grouped rows", () => {
    const groups = buildDashboardWorktreeGroups(
      {},
      [],
      [],
      [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          branch: "(failed)",
          isBare: false,
          operationFailure: {
            id: "failure-1",
            targetKind: "worktree",
            operation: "create",
            title: 'Failed to create worktree "demo"',
            message: "branch already exists",
            worktreePath: "/repo/.aimux/worktrees/demo",
            worktreeName: "demo",
            createdAt: "2026-05-01T00:00:00.000Z",
          },
        },
      ],
      "/repo",
    );

    expect(groups[1]?.operationFailure?.message).toBe("branch already exists");
  });
});

describe("applyDashboardModel", () => {
  it("rebuilds derived caches when only pending actions change", () => {
    const pending = new DashboardPendingActions(() => {});
    const host: any = {
      dashboardPendingActions: pending,
      dashboardUiStateStore: {
        orderWorktreeGroups: (groups: unknown) => groups,
        markSelectionDirty: () => {},
      },
    };
    const mainCheckoutInfo = { name: "Main Checkout", branch: "master" };
    const worktreeGroups = [
      {
        name: "Main Checkout",
        branch: "master",
        path: undefined,
        status: "offline" as const,
        sessions: [],
        services: [],
      },
    ];

    pending.setServiceAction("service-new", "creating", {
      serviceSeed: {
        id: "service-new",
        command: "shell",
        args: [],
        label: "shell",
        status: "running",
        active: false,
      },
    });

    expect(applyDashboardModel(host, [], [], [], worktreeGroups, mainCheckoutInfo)).toBe(true);
    expect(host.dashboardServicesCache).toEqual([
      expect.objectContaining({ id: "service-new", pendingAction: "creating", optimistic: true }),
    ]);

    pending.clearServiceAction("service-new");

    expect(applyDashboardModel(host, [], [], [], worktreeGroups, mainCheckoutInfo)).toBe(true);
    expect(host.dashboardServicesCache).toEqual([]);
  });
});

describe("metadata pending actions", () => {
  it("tags teammate lifecycle pending seeds without tagging normal spawns", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-model-"));
    const pending = new DashboardPendingActions(() => {});
    const setSessionAction = vi.spyOn(pending, "setSessionAction");
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
      eventBus: undefined,
      buildDesktopState: vi.fn(),
      listProjectedDesktopWorktrees: vi.fn(),
      dashboardSessionsCache: [],
      dashboardServicesCache: [],
      dashboardWorktreeGroupsCache: [],
      sessions: [],
      services: [],
      offlineServices: [],
      sessionWorktreePaths: new Map(),
      sessionTmuxTargets: new Map(),
      getSessionLabel: vi.fn(),
      serviceLabelForCommand: vi.fn(),
      refreshProjectStatusline: vi.fn(),
      createDesktopWorktree: vi.fn(),
      removeDesktopWorktree: vi.fn(),
      graveyardDesktopWorktree: vi.fn(),
      listWorktreeGraveyardEntries: vi.fn(),
      resurrectGraveyardWorktree: vi.fn(),
      deleteGraveyardWorktree: vi.fn(),
      createService: vi.fn(),
      stopService: vi.fn(),
      resumeOfflineServiceById: vi.fn(),
      removeOfflineService: vi.fn(),
      resumeOfflineSession: vi.fn((session: any) => {
        host.offlineSessions = host.offlineSessions.filter((entry: any) => entry.id !== session.id);
        host.sessions.push({ ...session, lifecycle: "live", exited: false });
      }),
      listGraveyardEntries: vi.fn(),
      resurrectGraveyardSession: vi.fn(),
      sendOrchestrationMessage: vi.fn(),
      sendHandoffMessage: vi.fn(),
      spawnAgent: vi.fn(() => {
        throw new Error("spawn sentinel");
      }),
      createTeammateAgent: vi.fn(() => {
        throw new Error("teammate sentinel");
      }),
      forkAgent: vi.fn(),
      stopAgent: vi.fn(),
      interruptAgent: vi.fn(),
      renameAgent: vi.fn(),
      migrateAgent: vi.fn(),
      killAgent: vi.fn(),
      readAgentOutput: vi.fn(),
    };

    try {
      await initPaths(repoRoot);
      await startProjectServices(host);
      const lifecycle = (host.metadataServer as any).options.lifecycle;

      await expect(lifecycle.spawnAgent({ sessionId: "codex-1", tool: "codex" })).rejects.toThrow("spawn sentinel");
      expect(setSessionAction).toHaveBeenLastCalledWith(
        "codex-1",
        "creating",
        expect.objectContaining({
          sessionSeed: expect.not.objectContaining({ team: expect.anything() }),
        }),
      );

      await expect(
        lifecycle.createTeammateAgent({
          sessionId: "codex-reviewer",
          parentSessionId: "claude-parent",
          role: " reviewer ",
          label: " review ",
          tool: "codex",
          worktreePath: "/tmp/review-worktree",
          extraArgs: ["--model", "gpt-5.5"],
          open: true,
          order: 2,
        }),
      ).rejects.toThrow("teammate sentinel");
      expect(host.createTeammateAgent).toHaveBeenLastCalledWith({
        parentSessionId: "claude-parent",
        role: " reviewer ",
        label: " review ",
        toolConfigKey: "codex",
        targetSessionId: "codex-reviewer",
        targetWorktreePath: "/tmp/review-worktree",
        open: true,
        extraArgs: ["--model", "gpt-5.5"],
        order: 2,
      });
      expect(setSessionAction).toHaveBeenLastCalledWith(
        "codex-reviewer",
        "creating",
        expect.objectContaining({
          sessionSeed: expect.objectContaining({
            command: "codex",
            label: "codex",
            worktreePath: "/tmp/review-worktree",
            team: expect.objectContaining({
              teamId: "team-claude-parent",
              parentSessionId: "claude-parent",
              role: "reviewer",
              label: "review",
              order: 2,
            }),
          }),
        }),
      );
    } finally {
      host.metadataServer?.stop?.();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("resumes direct offline teammates after resuming a primary agent", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-resume-team-"));
    const pending = new DashboardPendingActions(() => {});
    const setSessionAction = vi.spyOn(pending, "setSessionAction");
    const resumeOrder: string[] = [];
    const parent = {
      id: "claude-parent",
      command: "claude",
      toolConfigKey: "claude",
      args: [],
      lifecycle: "offline",
      backendSessionId: "backend-parent",
    };
    const teammate = {
      id: "codex-reviewer",
      command: "codex",
      toolConfigKey: "codex",
      args: [],
      lifecycle: "offline",
      backendSessionId: "backend-reviewer",
      team: { teamId: "team-claude-parent", parentSessionId: "claude-parent", role: "reviewer", order: 0 },
    };
    const nested = {
      id: "claude-nested",
      command: "claude",
      toolConfigKey: "claude",
      args: [],
      lifecycle: "offline",
      backendSessionId: "backend-nested",
      team: { teamId: "team-codex-reviewer", parentSessionId: "codex-reviewer", role: "reviewer", order: 0 },
    };
    const independent = {
      id: "codex-independent",
      command: "codex",
      toolConfigKey: "codex",
      args: [],
      lifecycle: "offline",
      backendSessionId: "backend-independent",
    };
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
      eventBus: undefined,
      buildDesktopState: vi.fn(),
      listProjectedDesktopWorktrees: vi.fn(),
      dashboardSessionsCache: [],
      dashboardServicesCache: [],
      dashboardWorktreeGroupsCache: [],
      sessions: [],
      services: [],
      offlineSessions: [parent, teammate, nested, independent],
      offlineServices: [],
      sessionWorktreePaths: new Map(),
      sessionTmuxTargets: new Map(),
      getSessionLabel: vi.fn(),
      serviceLabelForCommand: vi.fn(),
      refreshProjectStatusline: vi.fn(),
      createDesktopWorktree: vi.fn(),
      removeDesktopWorktree: vi.fn(),
      graveyardDesktopWorktree: vi.fn(),
      listWorktreeGraveyardEntries: vi.fn(),
      resurrectGraveyardWorktree: vi.fn(),
      deleteGraveyardWorktree: vi.fn(),
      createService: vi.fn(),
      stopService: vi.fn(),
      resumeOfflineServiceById: vi.fn(),
      removeOfflineService: vi.fn(),
      resumeOfflineSession: vi.fn((session: any) => {
        resumeOrder.push(session.id);
        host.offlineSessions = host.offlineSessions.filter((entry: any) => entry.id !== session.id);
        host.sessions.push({ ...session, lifecycle: "live", exited: false });
      }),
      listGraveyardEntries: vi.fn(),
      resurrectGraveyardSession: vi.fn(),
      sendOrchestrationMessage: vi.fn(),
      sendHandoffMessage: vi.fn(),
      spawnAgent: vi.fn(),
      createTeammateAgent: vi.fn(),
      forkAgent: vi.fn(),
      stopAgent: vi.fn(),
      interruptAgent: vi.fn(),
      renameAgent: vi.fn(),
      migrateAgent: vi.fn(),
      killAgent: vi.fn(),
      readAgentOutput: vi.fn(),
    };

    try {
      await initPaths(repoRoot);
      await startProjectServices(host);
      const desktop = (host.metadataServer as any).options.desktop;

      await expect(desktop.resumeAgent({ sessionId: "claude-parent" })).resolves.toEqual({
        sessionId: "claude-parent",
        status: "running",
      });

      expect(resumeOrder).toEqual(["claude-parent", "codex-reviewer"]);
      expect(host.offlineSessions.map((session: any) => session.id)).toEqual(["claude-nested", "codex-independent"]);
      expect(setSessionAction).toHaveBeenCalledWith(
        "codex-reviewer",
        "starting",
        expect.objectContaining({
          sessionSeed: expect.objectContaining({
            team: expect.objectContaining({ parentSessionId: "claude-parent", role: "reviewer" }),
          }),
        }),
      );
    } finally {
      host.metadataServer?.stop?.();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("serializes project-service agent resumes until each launch settles", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-resume-queue-"));
    const pending = new DashboardPendingActions(() => {});
    const resumeOrder: string[] = [];
    const firstSettled = deferred<boolean>();
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
      eventBus: undefined,
      buildDesktopState: vi.fn(),
      listProjectedDesktopWorktrees: vi.fn(),
      dashboardSessionsCache: [],
      dashboardServicesCache: [],
      dashboardWorktreeGroupsCache: [],
      sessions: [],
      services: [],
      offlineSessions: [
        {
          id: "claude-first",
          command: "claude",
          toolConfigKey: "claude",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-first",
        },
        {
          id: "codex-second",
          command: "codex",
          toolConfigKey: "codex",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-second",
        },
      ],
      offlineServices: [],
      sessionWorktreePaths: new Map(),
      sessionTmuxTargets: new Map(),
      getSessionLabel: vi.fn(),
      serviceLabelForCommand: vi.fn(),
      refreshProjectStatusline: vi.fn(),
      createDesktopWorktree: vi.fn(),
      removeDesktopWorktree: vi.fn(),
      graveyardDesktopWorktree: vi.fn(),
      listWorktreeGraveyardEntries: vi.fn(),
      resurrectGraveyardWorktree: vi.fn(),
      deleteGraveyardWorktree: vi.fn(),
      createService: vi.fn(),
      stopService: vi.fn(),
      resumeOfflineServiceById: vi.fn(),
      removeOfflineService: vi.fn(),
      resumeOfflineSession: vi.fn((session: any) => {
        resumeOrder.push(session.id);
        host.offlineSessions = host.offlineSessions.filter((entry: any) => entry.id !== session.id);
        host.sessions.push({ ...session, lifecycle: "live", exited: false });
      }),
      waitForSessionStart: vi.fn((sessionId: string) => {
        if (sessionId === "claude-first") return firstSettled.promise;
        return Promise.resolve(true);
      }),
      listGraveyardEntries: vi.fn(),
      resurrectGraveyardSession: vi.fn(),
      sendOrchestrationMessage: vi.fn(),
      sendHandoffMessage: vi.fn(),
      spawnAgent: vi.fn(),
      createTeammateAgent: vi.fn(),
      forkAgent: vi.fn(),
      stopAgent: vi.fn(),
      interruptAgent: vi.fn(),
      renameAgent: vi.fn(),
      migrateAgent: vi.fn(),
      killAgent: vi.fn(),
      readAgentOutput: vi.fn(),
    };

    try {
      await initPaths(repoRoot);
      await startProjectServices(host);
      const desktop = (host.metadataServer as any).options.desktop;

      const first = desktop.resumeAgent({ sessionId: "claude-first" });
      await nextTick();
      const second = desktop.resumeAgent({ sessionId: "codex-second" });
      await nextTick();

      expect(resumeOrder).toEqual(["claude-first"]);

      firstSettled.resolve(true);
      await expect(Promise.all([first, second])).resolves.toEqual([
        { sessionId: "claude-first", status: "running" },
        { sessionId: "codex-second", status: "running" },
      ]);
      expect(resumeOrder).toEqual(["claude-first", "codex-second"]);
    } finally {
      host.metadataServer?.stop?.();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects project-service agent resume when topology lacks an exact backend id", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-resume-blocked-"));
    const host: any = {
      dashboardPendingActions: new DashboardPendingActions(() => {}),
      reapplyDashboardPendingActions: vi.fn(),
      eventBus: undefined,
      buildDesktopState: vi.fn(),
      listProjectedDesktopWorktrees: vi.fn(),
      dashboardSessionsCache: [],
      dashboardServicesCache: [],
      dashboardWorktreeGroupsCache: [],
      sessions: [],
      services: [],
      offlineSessions: [
        { id: "claude-blocked", command: "claude", toolConfigKey: "claude", args: [], lifecycle: "offline" },
      ],
      offlineServices: [],
      sessionWorktreePaths: new Map(),
      sessionTmuxTargets: new Map(),
      getSessionLabel: vi.fn(),
      serviceLabelForCommand: vi.fn(),
      refreshProjectStatusline: vi.fn(),
      createDesktopWorktree: vi.fn(),
      removeDesktopWorktree: vi.fn(),
      graveyardDesktopWorktree: vi.fn(),
      listWorktreeGraveyardEntries: vi.fn(),
      resurrectGraveyardWorktree: vi.fn(),
      deleteGraveyardWorktree: vi.fn(),
      createService: vi.fn(),
      stopService: vi.fn(),
      resumeOfflineServiceById: vi.fn(),
      removeOfflineService: vi.fn(),
      resumeOfflineSession: vi.fn((session: any) => {
        host.offlineSessions = host.offlineSessions.filter((entry: any) => entry.id !== session.id);
        host.sessions.push({ ...session, lifecycle: "live", exited: false });
      }),
      listGraveyardEntries: vi.fn(),
      resurrectGraveyardSession: vi.fn(),
      sendOrchestrationMessage: vi.fn(),
      sendHandoffMessage: vi.fn(),
      spawnAgent: vi.fn(),
      createTeammateAgent: vi.fn(),
      forkAgent: vi.fn(),
      stopAgent: vi.fn(),
      interruptAgent: vi.fn(),
      renameAgent: vi.fn(),
      migrateAgent: vi.fn(),
      killAgent: vi.fn(),
      readAgentOutput: vi.fn(),
    };

    try {
      await initPaths(repoRoot);
      await startProjectServices(host);
      const desktop = (host.metadataServer as any).options.desktop;

      await expect(desktop.resumeAgent({ sessionId: "claude-blocked" })).rejects.toThrow(
        'Cannot restore session "claude-blocked": missing exact resumable backend session id',
      );
      expect(host.resumeOfflineSession).not.toHaveBeenCalled();
    } finally {
      host.metadataServer?.stop?.();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("backfills a recoverable backend id before project-service agent resume checks", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-resume-backfill-"));
    const claudeHome = mkdtempSync(join(tmpdir(), "aimux-dashboard-resume-claude-"));
    const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    const backendSessionId = "0710a963-a473-430f-9f9a-e27dd4546328";
    const cwd = join(repoRoot, "wt", "recoverable");
    const host: any = {
      dashboardPendingActions: new DashboardPendingActions(() => {}),
      reapplyDashboardPendingActions: vi.fn(),
      eventBus: undefined,
      buildDesktopState: vi.fn(),
      listProjectedDesktopWorktrees: vi.fn(),
      dashboardSessionsCache: [],
      dashboardServicesCache: [],
      dashboardWorktreeGroupsCache: [],
      sessions: [],
      services: [],
      offlineSessions: [
        {
          id: "claude-recoverable",
          command: "claude",
          toolConfigKey: "claude",
          args: [],
          lifecycle: "offline",
          worktreePath: cwd,
        },
      ],
      offlineServices: [],
      sessionWorktreePaths: new Map(),
      sessionTmuxTargets: new Map(),
      getSessionLabel: vi.fn(),
      serviceLabelForCommand: vi.fn(),
      refreshProjectStatusline: vi.fn(),
      createDesktopWorktree: vi.fn(),
      removeDesktopWorktree: vi.fn(),
      graveyardDesktopWorktree: vi.fn(),
      listWorktreeGraveyardEntries: vi.fn(),
      resurrectGraveyardWorktree: vi.fn(),
      deleteGraveyardWorktree: vi.fn(),
      createService: vi.fn(),
      stopService: vi.fn(),
      resumeOfflineServiceById: vi.fn(),
      removeOfflineService: vi.fn(),
      resumeOfflineSession: vi.fn((session: any) => {
        host.offlineSessions = host.offlineSessions.filter((entry: any) => entry.id !== session.id);
        host.sessions.push({ ...session, lifecycle: "live", exited: false });
      }),
      listGraveyardEntries: vi.fn(),
      resurrectGraveyardSession: vi.fn(),
      sendOrchestrationMessage: vi.fn(),
      sendHandoffMessage: vi.fn(),
      spawnAgent: vi.fn(),
      createTeammateAgent: vi.fn(),
      forkAgent: vi.fn(),
      stopAgent: vi.fn(),
      interruptAgent: vi.fn(),
      renameAgent: vi.fn(),
      migrateAgent: vi.fn(),
      killAgent: vi.fn(),
      readAgentOutput: vi.fn(),
    };

    try {
      process.env.CLAUDE_CONFIG_DIR = claudeHome;
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
      await initPaths(repoRoot);
      saveRuntimeTopologySessions({
        projectRoot: repoRoot,
        sessions: [
          {
            id: "claude-recoverable",
            command: "claude",
            tool: "claude",
            toolConfigKey: "claude",
            args: [],
            lifecycle: "offline",
            worktreePath: cwd,
          },
        ],
      });
      const transcriptDir = join(claudeHome, "projects", cwd.replace(/[/.]/g, "-"));
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(join(transcriptDir, `${backendSessionId}.jsonl`), "{}\n");
      await startProjectServices(host);
      const desktop = (host.metadataServer as any).options.desktop;

      await expect(desktop.resumeAgent({ sessionId: "claude-recoverable" })).resolves.toEqual({
        sessionId: "claude-recoverable",
        status: "running",
      });

      expect(host.resumeOfflineSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: "claude-recoverable", backendSessionId }),
      );
    } finally {
      host.metadataServer?.stop?.();
      if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("does not propagate resume upward when resuming a teammate directly", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-resume-teammate-"));
    const pending = new DashboardPendingActions(() => {});
    const resumeOrder: string[] = [];
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
      eventBus: undefined,
      buildDesktopState: vi.fn(),
      listProjectedDesktopWorktrees: vi.fn(),
      dashboardSessionsCache: [],
      dashboardServicesCache: [],
      dashboardWorktreeGroupsCache: [],
      sessions: [],
      services: [],
      offlineSessions: [
        {
          id: "claude-parent",
          command: "claude",
          toolConfigKey: "claude",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-parent",
        },
        {
          id: "codex-reviewer",
          command: "codex",
          toolConfigKey: "codex",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-reviewer",
          team: { teamId: "team-claude-parent", parentSessionId: "claude-parent", role: "reviewer" },
        },
      ],
      offlineServices: [],
      sessionWorktreePaths: new Map(),
      sessionTmuxTargets: new Map(),
      getSessionLabel: vi.fn(),
      serviceLabelForCommand: vi.fn(),
      refreshProjectStatusline: vi.fn(),
      createDesktopWorktree: vi.fn(),
      removeDesktopWorktree: vi.fn(),
      graveyardDesktopWorktree: vi.fn(),
      listWorktreeGraveyardEntries: vi.fn(),
      resurrectGraveyardWorktree: vi.fn(),
      deleteGraveyardWorktree: vi.fn(),
      createService: vi.fn(),
      stopService: vi.fn(),
      resumeOfflineServiceById: vi.fn(),
      removeOfflineService: vi.fn(),
      resumeOfflineSession: vi.fn((session: any) => {
        resumeOrder.push(session.id);
        host.offlineSessions = host.offlineSessions.filter((entry: any) => entry.id !== session.id);
        host.sessions.push({ ...session, lifecycle: "live", exited: false });
      }),
      listGraveyardEntries: vi.fn(),
      resurrectGraveyardSession: vi.fn(),
      sendOrchestrationMessage: vi.fn(),
      sendHandoffMessage: vi.fn(),
      spawnAgent: vi.fn(),
      createTeammateAgent: vi.fn(),
      forkAgent: vi.fn(),
      stopAgent: vi.fn(),
      interruptAgent: vi.fn(),
      renameAgent: vi.fn(),
      migrateAgent: vi.fn(),
      killAgent: vi.fn(),
      readAgentOutput: vi.fn(),
    };

    try {
      await initPaths(repoRoot);
      await startProjectServices(host);
      const desktop = (host.metadataServer as any).options.desktop;

      await expect(desktop.resumeAgent({ sessionId: "codex-reviewer" })).resolves.toEqual({
        sessionId: "codex-reviewer",
        status: "running",
      });

      expect(resumeOrder).toEqual(["codex-reviewer"]);
      expect(host.offlineSessions.map((session: any) => session.id)).toEqual(["claude-parent"]);
    } finally {
      host.metadataServer?.stop?.();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps a teammate offline when teammate resume fails after primary resume succeeds", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-resume-team-fail-"));
    const pending = new DashboardPendingActions(() => {});
    const resumeOrder: string[] = [];
    const parent = {
      id: "claude-parent",
      command: "claude",
      toolConfigKey: "claude",
      args: [],
      lifecycle: "offline",
      backendSessionId: "backend-parent",
    };
    const teammate = {
      id: "codex-reviewer",
      command: "codex",
      toolConfigKey: "codex",
      args: [],
      lifecycle: "offline",
      backendSessionId: "backend-reviewer",
      team: { teamId: "team-claude-parent", parentSessionId: "claude-parent", role: "reviewer" },
    };
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
      eventBus: undefined,
      buildDesktopState: vi.fn(),
      listProjectedDesktopWorktrees: vi.fn(),
      dashboardSessionsCache: [],
      dashboardServicesCache: [],
      dashboardWorktreeGroupsCache: [],
      sessions: [],
      services: [],
      offlineSessions: [parent, teammate],
      offlineServices: [],
      sessionWorktreePaths: new Map(),
      sessionTmuxTargets: new Map(),
      getSessionLabel: vi.fn(),
      serviceLabelForCommand: vi.fn(),
      refreshProjectStatusline: vi.fn(),
      createDesktopWorktree: vi.fn(),
      removeDesktopWorktree: vi.fn(),
      graveyardDesktopWorktree: vi.fn(),
      listWorktreeGraveyardEntries: vi.fn(),
      resurrectGraveyardWorktree: vi.fn(),
      deleteGraveyardWorktree: vi.fn(),
      createService: vi.fn(),
      stopService: vi.fn(),
      resumeOfflineServiceById: vi.fn(),
      removeOfflineService: vi.fn(),
      resumeOfflineSession: vi.fn((session: any) => {
        resumeOrder.push(session.id);
        if (session.id === "codex-reviewer") {
          throw new Error("teammate backend missing");
        }
        host.offlineSessions = host.offlineSessions.filter((entry: any) => entry.id !== session.id);
        host.sessions.push({ ...session, lifecycle: "live", exited: false });
      }),
      listGraveyardEntries: vi.fn(),
      resurrectGraveyardSession: vi.fn(),
      sendOrchestrationMessage: vi.fn(),
      sendHandoffMessage: vi.fn(),
      spawnAgent: vi.fn(),
      createTeammateAgent: vi.fn(),
      forkAgent: vi.fn(),
      stopAgent: vi.fn(),
      interruptAgent: vi.fn(),
      renameAgent: vi.fn(),
      migrateAgent: vi.fn(),
      killAgent: vi.fn(),
      readAgentOutput: vi.fn(),
    };

    try {
      await initPaths(repoRoot);
      await startProjectServices(host);
      const desktop = (host.metadataServer as any).options.desktop;

      await expect(desktop.resumeAgent({ sessionId: "claude-parent" })).resolves.toMatchObject({
        sessionId: "claude-parent",
        status: "running",
        warning: "Failed to resume 1 teammate: codex-reviewer: teammate backend missing",
        teammateFailures: [{ sessionId: "codex-reviewer", error: "teammate backend missing" }],
      });

      expect(resumeOrder).toEqual(["claude-parent", "codex-reviewer"]);
      expect(host.sessions.map((session: any) => session.id)).toEqual(["claude-parent"]);
      expect(host.offlineSessions).toEqual([
        expect.objectContaining({
          id: "codex-reviewer",
          team: expect.objectContaining({ parentSessionId: "claude-parent", role: "reviewer" }),
        }),
      ]);
    } finally {
      host.metadataServer?.stop?.();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps session pending until the settle callback resolves", async () => {
    const pending = new DashboardPendingActions(() => {});
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
    };
    const settled = deferred<boolean>();

    const resultPromise = withMetadataSessionPending(
      host,
      "codex-1",
      "starting",
      () => ({ sessionId: "codex-1" }),
      undefined,
      () => settled.promise,
    );

    await Promise.resolve();
    await expect(resultPromise).resolves.toEqual({ sessionId: "codex-1" });
    expect(pending.getSessionAction("codex-1")).toBe("starting");

    settled.resolve(true);
    await nextTick();
    expect(pending.getSessionAction("codex-1")).toBeUndefined();
  });

  it("clears service pending and preserves the original work error", async () => {
    const pending = new DashboardPendingActions(() => {});
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
    };
    const settle = vi.fn();

    await expect(
      withMetadataServicePending(
        host,
        "service-1",
        "removing",
        () => {
          throw new Error("boom");
        },
        settle,
      ),
    ).rejects.toThrow("boom");

    expect(settle).not.toHaveBeenCalled();
    expect(pending.getServiceAction("service-1")).toBeUndefined();
  });

  it("clears pending even when a best-effort settle callback fails", async () => {
    const pending = new DashboardPendingActions(() => {});
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
      debug: vi.fn(),
    };

    await expect(
      withMetadataSessionPending(
        host,
        "claude-1",
        "creating",
        () => ({ sessionId: "claude-1" }),
        undefined,
        async () => {
          throw new Error("settle failed");
        },
      ),
    ).resolves.toEqual({ sessionId: "claude-1" });

    await nextTick();
    expect(pending.getSessionAction("claude-1")).toBeUndefined();
    expect(host.debug).toHaveBeenCalledWith(expect.stringContaining("settle failed"), "dashboard");
  });

  it("does not let an older session settle clear a newer pending action", async () => {
    const pending = new DashboardPendingActions(() => {});
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
    };
    const firstSettle = deferred<boolean>();
    const secondSettle = deferred<boolean>();

    await expect(
      withMetadataSessionPending(
        host,
        "codex-1",
        "starting",
        () => ({ sessionId: "codex-1", attempt: 1 }),
        undefined,
        () => firstSettle.promise,
      ),
    ).resolves.toEqual({ sessionId: "codex-1", attempt: 1 });

    await expect(
      withMetadataSessionPending(
        host,
        "codex-1",
        "starting",
        () => ({ sessionId: "codex-1", attempt: 2 }),
        undefined,
        () => secondSettle.promise,
      ),
    ).resolves.toEqual({ sessionId: "codex-1", attempt: 2 });

    firstSettle.resolve(true);
    await nextTick();
    expect(pending.getSessionAction("codex-1")).toBe("starting");

    secondSettle.resolve(true);
    await nextTick();
    expect(pending.getSessionAction("codex-1")).toBeUndefined();
  });

  it("does not let an older service settle clear a newer pending action", async () => {
    const pending = new DashboardPendingActions(() => {});
    const host: any = {
      dashboardPendingActions: pending,
      reapplyDashboardPendingActions: vi.fn(),
      dashboardServicesCache: [],
      services: [],
      offlineServices: [],
    };
    const firstSettle = deferred<boolean>();
    const secondSettle = deferred<boolean>();

    await expect(
      withMetadataServicePending(
        host,
        "service-1",
        "starting",
        () => ({ serviceId: "service-1", attempt: 1 }),
        () => firstSettle.promise,
      ),
    ).resolves.toEqual({ serviceId: "service-1", attempt: 1 });

    await expect(
      withMetadataServicePending(
        host,
        "service-1",
        "starting",
        () => ({ serviceId: "service-1", attempt: 2 }),
        () => secondSettle.promise,
      ),
    ).resolves.toEqual({ serviceId: "service-1", attempt: 2 });

    firstSettle.resolve(true);
    await nextTick();
    expect(pending.getServiceAction("service-1")).toBe("starting");

    secondSettle.resolve(true);
    await nextTick();
    expect(pending.getServiceAction("service-1")).toBeUndefined();
  });
});
