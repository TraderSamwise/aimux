import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() =>
  vi.fn(() => ({
    defaultTool: "claude",
    tools: {
      claude: {
        command: "claude",
        args: ["--dangerously-skip-permissions"],
        enabled: true,
        preambleFlag: ["--append-system-prompt"],
        sessionIdFlag: ["--session-id", "{sessionId}"],
      },
      codex: {
        command: "codex",
        args: ["--dangerously-bypass-approvals-and-sandbox"],
        enabled: true,
      },
    },
  })),
);

vi.mock("../config.js", () => ({
  loadConfig: loadConfigMock,
}));

const createSessionAsyncMock = vi.hoisted(() =>
  vi.fn(async (...args: any[]) => ({ id: typeof args[9] === "string" ? args[9] : "planned" })),
);

vi.mock("./session-launch.js", () => ({
  createSessionAsync: createSessionAsyncMock,
}));

import { agentIoMethods } from "./agent-io-methods.js";
import { dashboardTailMethods } from "./dashboard-tail-methods.js";
import { listDashboardOperationFailures } from "../dashboard/operation-failures.js";
import { DashboardPendingActions } from "../dashboard/pending-actions.js";
import { initPaths } from "../paths.js";
import { listTopologySessionStates, upsertTopologySession } from "../runtime-core/topology-sessions.js";
import { TmuxSessionTransport } from "../tmux/session-transport.js";

describe("dashboard lifecycle adapter", () => {
  let repoRoot = "";

  beforeEach(async () => {
    createSessionAsyncMock.mockReset();
    createSessionAsyncMock.mockImplementation(async (...args: any[]) => ({
      id: typeof args[9] === "string" ? args[9] : "planned",
    }));
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-tail-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("records spawning agents before creating the tmux window", async () => {
    vi.useFakeTimers();
    const host: any = {
      projectRoot: repoRoot,
      mode: "dashboard",
      generateDashboardSessionId: vi.fn(() => "codex-planned"),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      openLiveTmuxWindowForEntry: vi.fn(),
    };

    await expect(
      dashboardTailMethods.spawnAgent.call(host, {
        toolConfigKey: "codex",
        targetWorktreePath: "/repo/wt",
        open: true,
        launchOverride: {
          command: "codex",
          args: ["--dangerously-bypass-approvals-and-sandbox", "--profile", "test"],
          env: { CODEX_FLAG: "1" },
        },
      }),
    ).resolves.toEqual({ sessionId: "codex-planned" });

    expect(host.generateDashboardSessionId).toHaveBeenCalledWith("codex");
    expect(listTopologySessionStates({ statuses: ["starting"] })[0]).toMatchObject({
      id: "codex-planned",
      command: "codex",
      toolConfigKey: "codex",
      worktreePath: "/repo/wt",
      status: "starting",
    });
    expect(createSessionAsyncMock).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(createSessionAsyncMock).toHaveBeenCalledWith(
      host,
      "codex",
      ["--dangerously-bypass-approvals-and-sandbox", "--profile", "test"],
      undefined,
      "codex",
      undefined,
      undefined,
      "/repo/wt",
      undefined,
      "codex-planned",
      false,
      false,
      undefined,
      { CODEX_FLAG: "1" },
    );
    expect(host.openLiveTmuxWindowForEntry).toHaveBeenCalledWith({ id: "codex-planned" });
  });

  it("records failed deferred agent creation as an offline failure instead of leaving a starting zombie", async () => {
    vi.useFakeTimers();
    createSessionAsyncMock.mockRejectedValueOnce(new Error("tmux exploded"));
    const host: any = {
      projectRoot: repoRoot,
      mode: "project-service",
      generateDashboardSessionId: vi.fn(() => "codex-planned"),
      invalidateDesktopStateSnapshot: vi.fn(),
      metadataServer: { notifyChange: vi.fn() },
      publishAlert: vi.fn(),
      debug: vi.fn(),
    };

    await expect(
      dashboardTailMethods.spawnAgent.call(host, {
        toolConfigKey: "codex",
        targetWorktreePath: "/repo/wt",
        open: false,
      }),
    ).resolves.toEqual({ sessionId: "codex-planned" });

    expect(listTopologySessionStates({ statuses: ["starting"] }).map((session) => session.id)).toEqual([
      "codex-planned",
    ]);
    await vi.runOnlyPendingTimersAsync();

    expect(listTopologySessionStates({ statuses: ["starting"] })).toEqual([]);
    expect(listTopologySessionStates({ statuses: ["offline"] })[0]).toMatchObject({
      id: "codex-planned",
      status: "offline",
      restoreBlockedReason: "startup failed: tmux exploded",
    });
    expect(listDashboardOperationFailures()[0]).toMatchObject({
      targetKind: "agent",
      operation: "create",
      targetId: "codex-planned",
      title: "Failed to create codex agent",
      message: "tmux exploded",
      worktreePath: "/repo/wt",
    });
    expect(host.publishAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "task_failed",
        title: "Failed to create codex agent",
        message: "tmux exploded",
      }),
    );
    expect(host.metadataServer.notifyChange).toHaveBeenCalled();
  });

  it("records an immediately dead tmux window as a startup failure", async () => {
    vi.useFakeTimers();
    const target = { sessionName: "aimux-test", windowId: "@9", windowIndex: 9, windowName: "codex" };
    createSessionAsyncMock.mockImplementationOnce(async (...args: any[]) => {
      const sessionId = typeof args[9] === "string" ? args[9] : "planned";
      const runtime = { id: sessionId, transport: { tmuxTarget: target, destroy: vi.fn() } };
      host.sessions.push(runtime);
      host.sessionTmuxTargets.set(sessionId, target);
      return { id: sessionId, tmuxTarget: target };
    });
    const host: any = {
      projectRoot: repoRoot,
      mode: "project-service",
      sessions: [],
      sessionTmuxTargets: new Map(),
      sessionToolKeys: new Map(),
      sessionOriginalArgs: new Map(),
      sessionWorktreePaths: new Map(),
      sessionStartTimes: new Map(),
      sessionRoles: new Map(),
      sessionTeams: new Map(),
      tmuxRuntimeManager: {
        getTargetByWindowId: vi.fn(() => target),
        isWindowAlive: vi.fn(() => false),
        killWindowAsync: vi.fn(async () => undefined),
      },
      generateDashboardSessionId: vi.fn(() => "codex-dead"),
      invalidateDesktopStateSnapshot: vi.fn(),
      metadataServer: { notifyChange: vi.fn() },
      publishAlert: vi.fn(),
      debug: vi.fn(),
    };

    await expect(
      dashboardTailMethods.spawnAgent.call(host, {
        toolConfigKey: "codex",
        targetWorktreePath: repoRoot,
        open: false,
      }),
    ).resolves.toEqual({ sessionId: "codex-dead" });
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(150);
    await vi.runOnlyPendingTimersAsync();

    expect(host.sessions).toEqual([]);
    expect(host.sessionTmuxTargets.has("codex-dead")).toBe(false);
    expect(host.tmuxRuntimeManager.killWindowAsync).toHaveBeenCalledWith(target);
    expect(listTopologySessionStates({ statuses: ["starting"] })).toEqual([]);
    expect(listTopologySessionStates({ statuses: ["offline"] })[0]).toMatchObject({
      id: "codex-dead",
      status: "offline",
      restoreBlockedReason: "startup failed: agent exited during startup",
    });
    expect(listDashboardOperationFailures()[0]).toMatchObject({
      targetKind: "agent",
      operation: "create",
      targetId: "codex-dead",
      message: "agent exited during startup",
    });
  });

  it("cancels queued agent creation when the user stops before tmux creation runs", async () => {
    vi.useFakeTimers();
    const host: any = {
      projectRoot: repoRoot,
      mode: "project-service",
      sessions: [],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      sessionTmuxTargets: new Map(),
      generateDashboardSessionId: vi.fn(() => "codex-planned"),
      invalidateDesktopStateSnapshot: vi.fn(),
      metadataServer: { notifyChange: vi.fn() },
      debug: vi.fn(),
    };

    await expect(
      dashboardTailMethods.spawnAgent.call(host, {
        toolConfigKey: "codex",
        targetWorktreePath: repoRoot,
        open: false,
      }),
    ).resolves.toEqual({ sessionId: "codex-planned" });
    await expect(dashboardTailMethods.stopAgent.call(host, "codex-planned")).resolves.toEqual({
      sessionId: "codex-planned",
      status: "offline",
    });

    await vi.runOnlyPendingTimersAsync();

    expect(createSessionAsyncMock).not.toHaveBeenCalled();
    expect(listTopologySessionStates({ statuses: ["starting"] })).toEqual([]);
    expect(listTopologySessionStates({ statuses: ["offline"] })[0]).toMatchObject({
      id: "codex-planned",
      status: "offline",
    });
    expect(host.metadataServer.notifyChange).toHaveBeenCalled();
  });

  it("does not run dashboard render hooks when project-service lifecycle records starting agents", async () => {
    vi.useFakeTimers();
    const host: any = {
      projectRoot: repoRoot,
      mode: "project-service",
      generateDashboardSessionId: vi.fn(() => "codex-planned"),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      openLiveTmuxWindowForEntry: vi.fn(),
    };

    await expect(
      dashboardTailMethods.spawnAgent.call(host, {
        toolConfigKey: "codex",
        targetWorktreePath: "/repo/wt",
        open: false,
      }),
    ).resolves.toEqual({ sessionId: "codex-planned" });

    expect(host.invalidateDesktopStateSnapshot).toHaveBeenCalledOnce();
    expect(host.writeStatuslineFile).not.toHaveBeenCalled();
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
    expect(host.updateContextWatcherSessions).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
  });

  it("records teammate agents before creating the tmux window", async () => {
    vi.useFakeTimers();
    const host: any = {
      projectRoot: repoRoot,
      generateDashboardSessionId: vi.fn(() => "claude-planned"),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      applySessionLabel: vi.fn(),
      openLiveTmuxWindowForEntry: vi.fn(),
    };

    await expect(
      dashboardTailMethods.createTeammateAgent.call(host, {
        parentSessionId: "claude-parent",
        role: "reviewer",
        label: "Review",
        order: 2,
        targetWorktreePath: "/repo/wt",
        extraArgs: ["--verbose"],
      }),
    ).resolves.toEqual({
      sessionId: "claude-planned",
      parentSessionId: "claude-parent",
      teamId: "team-claude-parent",
      role: "reviewer",
      label: "Review",
    });

    expect(listTopologySessionStates({ statuses: ["starting"] })[0]).toMatchObject({
      id: "claude-planned",
      command: "claude",
      toolConfigKey: "claude",
      worktreePath: "/repo/wt",
      label: "Review",
      status: "starting",
    });
    expect(createSessionAsyncMock).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(createSessionAsyncMock).toHaveBeenCalledWith(
      host,
      "claude",
      ["--dangerously-skip-permissions", "--verbose"],
      ["--append-system-prompt"],
      "claude",
      undefined,
      ["--session-id", "{sessionId}"],
      "/repo/wt",
      undefined,
      "claude-planned",
      true,
      false,
      {
        teamId: "team-claude-parent",
        parentSessionId: "claude-parent",
        role: "reviewer",
        label: "Review",
        order: 2,
      },
      undefined,
    );
    expect(host.applySessionLabel).toHaveBeenCalledWith("claude-planned", "Review");
  });

  it("forks through the existing session fork implementation", async () => {
    const host: any = {
      forkSessionFromSource: vi.fn(async () => ({ sessionId: "codex-fork", threadId: "thread-1" })),
      openLiveTmuxWindowForEntry: vi.fn(),
    };

    await expect(
      dashboardTailMethods.forkAgent.call(host, {
        sourceSessionId: "codex-parent",
        targetToolConfigKey: "codex",
        targetSessionId: "codex-child",
        instruction: "continue",
        targetWorktreePath: "/repo/wt",
        open: true,
        launchOverride: { command: "codex", args: ["--fast"] },
      }),
    ).resolves.toEqual({ sessionId: "codex-fork", threadId: "thread-1" });

    expect(host.forkSessionFromSource).toHaveBeenCalledWith(
      "codex-parent",
      "codex",
      "codex-child",
      "continue",
      "/repo/wt",
      { command: "codex", args: ["--fast"] },
    );
    expect(host.openLiveTmuxWindowForEntry).toHaveBeenCalledWith({ id: "codex-fork" });
  });

  it("returns pending action tokens from the dashboard host wrappers", () => {
    const host: any = {
      dashboardPendingActions: new DashboardPendingActions(() => undefined),
      reapplyDashboardPendingActions: vi.fn(),
    };

    const sessionToken = dashboardTailMethods.setPendingDashboardSessionAction.call(host, "codex-1", "starting");
    const serviceToken = dashboardTailMethods.setPendingDashboardServiceAction.call(host, "svc-1", "stopping");

    expect(sessionToken).toEqual(expect.any(Number));
    expect(serviceToken).toEqual(expect.any(Number));
    expect(host.dashboardPendingActions.listSessionActions()).toMatchObject([
      { id: "codex-1", kind: "starting", token: sessionToken },
    ]);
    expect(host.dashboardPendingActions.listServiceActions()).toMatchObject([
      { id: "svc-1", kind: "stopping", token: serviceToken },
    ]);
  });

  it("delegates rename and migrate operations to multiplexer methods", async () => {
    const host: any = {
      updateSessionLabel: vi.fn(),
      migrateAgent: vi.fn(),
    };

    await expect(dashboardTailMethods.renameAgent.call(host, "claude-1", "  New label  ")).resolves.toEqual({
      sessionId: "claude-1",
      label: "New label",
    });
    await expect(dashboardTailMethods.migrateAgentSession.call(host, "claude-1", "/repo/next")).resolves.toEqual({
      sessionId: "claude-1",
      worktreePath: "/repo/next",
    });

    expect(host.updateSessionLabel).toHaveBeenCalledWith("claude-1", "  New label  ");
    expect(host.migrateAgent).toHaveBeenCalledWith("claude-1", "/repo/next");
  });

  it("moves live agents to offline through topology before killing the live runtime", async () => {
    vi.useFakeTimers();
    const runtime = {
      id: "claude-1",
      command: "claude",
      startTime: Date.parse("2026-05-25T00:00:00.000Z"),
      backendSessionId: "backend-1",
      kill: vi.fn(),
    };
    const host: any = {
      sessions: [runtime],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      sessionTmuxTargets: new Map(),
      sessionToolKeys: new Map([["claude-1", "claude"]]),
      sessionOriginalArgs: new Map([["claude-1", ["--resume", "backend-1"]]]),
      sessionWorktreePaths: new Map([["claude-1", repoRoot]]),
      getSessionLabel: vi.fn(() => "Main"),
      deriveHeadline: vi.fn(() => "Ready"),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      debug: vi.fn(),
    };

    await expect(dashboardTailMethods.stopAgent.call(host, "claude-1")).resolves.toEqual({
      sessionId: "claude-1",
      status: "offline",
    });

    const offline = listTopologySessionStates({ statuses: ["offline"] });
    expect(offline).toMatchObject([
      {
        id: "claude-1",
        command: "claude",
        toolConfigKey: "claude",
        backendSessionId: "backend-1",
        worktreePath: repoRoot,
        label: "Main",
        headline: "Ready",
        status: "offline",
      },
    ]);
    expect(host.offlineSessions.map((session: any) => session.id)).toEqual(["claude-1"]);
    expect(host.stoppingSessionIds.has("claude-1")).toBe(true);
    expect(host.sessions).toEqual([]);
    expect(host.sessionTmuxTargets.has("claude-1")).toBe(false);
    expect(runtime.kill).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(runtime.kill).toHaveBeenCalledOnce();
  });

  it("kills tmux-backed live agents through the async tmux manager path", async () => {
    vi.useFakeTimers();
    const target = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" };
    const tmuxRuntimeManager = {
      killWindowAsync: vi.fn(async () => undefined),
      getTargetByWindowId: vi.fn(() => target),
    };
    const transport = new TmuxSessionTransport("codex-1", "codex", target, tmuxRuntimeManager as any, 80, 24);
    const runtime = {
      id: "codex-1",
      command: "codex",
      startTime: Date.parse("2026-05-25T00:00:00.000Z"),
      transport,
      kill: vi.fn(),
    };
    const host: any = {
      tmuxRuntimeManager,
      projectRoot: repoRoot,
      sessions: [runtime],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      sessionTmuxTargets: new Map([["codex-1", target]]),
      sessionToolKeys: new Map([["codex-1", "codex"]]),
      sessionOriginalArgs: new Map([["codex-1", []]]),
      sessionWorktreePaths: new Map([["codex-1", repoRoot]]),
      getSessionLabel: vi.fn(() => undefined),
      deriveHeadline: vi.fn(() => undefined),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      debug: vi.fn(),
    };

    await expect(dashboardTailMethods.stopAgent.call(host, "codex-1")).resolves.toEqual({
      sessionId: "codex-1",
      status: "offline",
    });

    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(host.sessions).toEqual([]);
    expect(host.sessionTmuxTargets.has("codex-1")).toBe(false);
    expect(tmuxRuntimeManager.killWindowAsync).toHaveBeenCalledWith(target);
    expect(runtime.kill).not.toHaveBeenCalled();
    transport.destroy();
  });

  it("marks no-history codex sessions as fresh relaunchable when stopped through the API", async () => {
    vi.useFakeTimers();
    const runtime = {
      id: "codex-fresh",
      command: "codex",
      startTime: Date.parse("2026-05-25T00:00:00.000Z"),
      kill: vi.fn(),
    };
    const host: any = {
      projectRoot: repoRoot,
      sessions: [runtime],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      sessionTmuxTargets: new Map(),
      sessionToolKeys: new Map([["codex-fresh", "codex"]]),
      sessionOriginalArgs: new Map([["codex-fresh", ["--dangerously-bypass-approvals-and-sandbox"]]]),
      sessionWorktreePaths: new Map([["codex-fresh", repoRoot]]),
      getSessionLabel: vi.fn(() => undefined),
      deriveHeadline: vi.fn(() => undefined),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      debug: vi.fn(),
    };

    await expect(dashboardTailMethods.stopAgent.call(host, "codex-fresh")).resolves.toEqual({
      sessionId: "codex-fresh",
      status: "offline",
    });

    expect(host.sessions).toEqual([]);
    expect(host.sessionTmuxTargets.has("codex-fresh")).toBe(false);
    expect(listTopologySessionStates({ statuses: ["offline"] })[0]).toMatchObject({
      id: "codex-fresh",
      freshRelaunchAllowed: true,
      status: "offline",
    });
    await vi.runOnlyPendingTimersAsync();
    expect(runtime.kill).toHaveBeenCalledOnce();
    expect(host.stoppingSessionIds.has("codex-fresh")).toBe(false);
  });

  it("moves offline agents to graveyard through topology without requiring offline cache authority", async () => {
    upsertTopologySession(
      {
        id: "codex-1",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "offline",
        worktreePath: repoRoot,
      },
      "offline",
    );
    const host: any = {
      sessions: [],
      offlineSessions: [],
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      debug: vi.fn(),
    };

    await expect(dashboardTailMethods.sendAgentToGraveyard.call(host, "codex-1")).resolves.toEqual({
      sessionId: "codex-1",
      status: "graveyard",
      previousStatus: "offline",
    });

    expect(listTopologySessionStates({ statuses: ["offline"] })).toEqual([]);
    expect(listTopologySessionStates({ statuses: ["graveyard"] }).map((session) => session.id)).toEqual(["codex-1"]);
  });

  it("moves live agents to graveyard through topology before killing the live runtime", async () => {
    vi.useFakeTimers();
    const runtime = {
      id: "codex-live",
      command: "codex",
      startTime: Date.parse("2026-05-25T00:00:00.000Z"),
      kill: vi.fn(),
    };
    const host: any = {
      projectRoot: repoRoot,
      sessions: [runtime],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      graveyardAfterStopSessionIds: new Set(),
      sessionTmuxTargets: new Map(),
      sessionToolKeys: new Map([["codex-live", "codex"]]),
      sessionOriginalArgs: new Map([["codex-live", []]]),
      sessionWorktreePaths: new Map([["codex-live", repoRoot]]),
      getSessionLabel: vi.fn(() => undefined),
      deriveHeadline: vi.fn(() => undefined),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      debug: vi.fn(),
    };

    await expect(dashboardTailMethods.sendAgentToGraveyard.call(host, "codex-live")).resolves.toEqual({
      sessionId: "codex-live",
      status: "graveyard",
      previousStatus: "running",
    });

    expect(listTopologySessionStates({ statuses: ["graveyard"] }).map((session) => session.id)).toEqual(["codex-live"]);
    expect(host.stoppingSessionIds.has("codex-live")).toBe(true);
    expect(host.graveyardAfterStopSessionIds.has("codex-live")).toBe(true);
    expect(host.sessions).toEqual([]);
    expect(host.sessionTmuxTargets.has("codex-live")).toBe(false);
    expect(runtime.kill).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(runtime.kill).toHaveBeenCalledOnce();
    expect(host.stoppingSessionIds.has("codex-live")).toBe(false);
    expect(host.graveyardAfterStopSessionIds.has("codex-live")).toBe(false);
  });

  it("marks stale live topology agents offline when no runtime owns them", async () => {
    upsertTopologySession(
      {
        id: "codex-live",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "live",
        worktreePath: repoRoot,
      },
      "running",
    );
    const host: any = {
      projectRoot: repoRoot,
      sessions: [],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      sessionTmuxTargets: new Map(),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      debug: vi.fn(),
    };

    await expect(dashboardTailMethods.stopAgent.call(host, "codex-live")).resolves.toEqual({
      sessionId: "codex-live",
      status: "offline",
    });

    expect(listTopologySessionStates({ statuses: ["running"] })).toEqual([]);
    expect(listTopologySessionStates({ statuses: ["offline"] }).map((session) => session.id)).toEqual(["codex-live"]);
  });

  it("graveyards stale live topology agents when no runtime owns them", async () => {
    upsertTopologySession(
      {
        id: "claude-live",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        lifecycle: "live",
        worktreePath: repoRoot,
      },
      "idle",
    );
    const host: any = {
      projectRoot: repoRoot,
      sessions: [],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      graveyardAfterStopSessionIds: new Set(),
      sessionTmuxTargets: new Map(),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      debug: vi.fn(),
    };

    await expect(dashboardTailMethods.sendAgentToGraveyard.call(host, "claude-live")).resolves.toEqual({
      sessionId: "claude-live",
      status: "graveyard",
      previousStatus: "running",
    });

    expect(listTopologySessionStates({ statuses: ["idle"] })).toEqual([]);
    expect(listTopologySessionStates({ statuses: ["graveyard"] }).map((session) => session.id)).toEqual([
      "claude-live",
    ]);
  });

  it("kills tmux-backed live topology agents even when the host has not rehydrated runtime ownership", async () => {
    vi.useFakeTimers();
    const target = { sessionName: "aimux-test", windowId: "@7", windowIndex: 7, windowName: "codex" };
    upsertTopologySession(
      {
        id: "codex-live",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "live",
        tmuxTarget: target,
        worktreePath: repoRoot,
      },
      "running",
    );
    const host: any = {
      projectRoot: repoRoot,
      sessions: [],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      sessionTmuxTargets: new Map(),
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => [{ target, metadata: { kind: "agent", sessionId: "codex-live" } }]),
        isWindowAlive: vi.fn(() => true),
        killWindowAsync: vi.fn(async () => undefined),
      },
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
      debug: vi.fn(),
    };

    await expect(dashboardTailMethods.stopAgent.call(host, "codex-live")).resolves.toEqual({
      sessionId: "codex-live",
      status: "offline",
    });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(host.tmuxRuntimeManager.killWindowAsync).toHaveBeenCalledWith(target);
    expect(host.stoppingSessionIds.has("codex-live")).toBe(false);
    expect(listTopologySessionStates({ statuses: ["offline"] }).map((session) => session.id)).toEqual(["codex-live"]);
  });

  it("does not report offline while a live runtime is already being sent to graveyard", async () => {
    const runtime = {
      id: "claude-kill",
      command: "claude",
      kill: vi.fn(),
    };
    const host: any = {
      sessions: [runtime],
      stoppingSessionIds: new Set(["claude-kill"]),
      graveyardAfterStopSessionIds: new Set(["claude-kill"]),
    };

    await expect(dashboardTailMethods.stopAgent.call(host, "claude-kill")).rejects.toThrow(
      'Session "claude-kill" is being sent to graveyard',
    );
    expect(runtime.kill).not.toHaveBeenCalled();
  });

  it("interrupts live non-tmux sessions through the session runtime helper", async () => {
    const write = vi.fn();
    const host: any = {
      sessions: [{ id: "shell-1", transport: { write }, write }],
    };

    await expect(agentIoMethods.interruptAgent.call(host, "shell-1")).resolves.toEqual({ sessionId: "shell-1" });

    expect(write).toHaveBeenCalledWith("\x1b");
  });
});
