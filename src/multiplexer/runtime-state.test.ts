import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStatePath, initPaths } from "../paths.js";
import { recordSessionBackendSessionIdMetadata } from "../metadata-store.js";
import { DashboardPendingActions } from "../dashboard/pending-actions.js";
import { listTopologySessionStates, saveRuntimeTopologySessions } from "../runtime-core/topology-sessions.js";
import {
  buildLiveServiceStates,
  getInstanceSessionRefs,
  graveyardSession,
  loadOfflineServices,
  loadOfflineTopologySessions,
  recordSessionBackendSessionId,
  restoreTmuxSessionsFromTopology,
  resumeOfflineSession,
  stopSessionToOffline,
} from "./runtime-state.js";

describe("resumeOfflineSession", () => {
  let repoRoot = "";

  function seedTopologySessions(sessions: any[]): void {
    saveRuntimeTopologySessions({
      sessions,
      projectRoot: repoRoot,
    });
  }

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-runtime-state-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("marks an agent as last used when stopping it to offline", () => {
    const session = {
      id: "codex-1",
      command: "codex",
      startTime: Date.parse("2026-05-01T00:00:00.000Z"),
      kill: vi.fn(),
    };
    const host: any = {
      stoppingSessionIds: new Set(),
      offlineSessions: [],
      sessionToolKeys: new Map([["codex-1", "codex"]]),
      sessionOriginalArgs: new Map([["codex-1", []]]),
      sessionWorktreePaths: new Map([["codex-1", repoRoot]]),
      getSessionLabel: vi.fn(() => "codex"),
      deriveHeadline: vi.fn(() => "summary"),
      noteLastUsedItem: vi.fn(),
      saveState: vi.fn(),
      debug: vi.fn(),
    };

    stopSessionToOffline(host, session);

    expect(host.noteLastUsedItem).toHaveBeenCalledWith("codex-1");
    expect(host.offlineSessions).toMatchObject([{ id: "codex-1", lifecycle: "offline" }]);
    expect(session.kill).toHaveBeenCalledOnce();
  });

  it("suppresses startup preamble for native offline session resume", () => {
    const team = {
      teamId: "team-1",
      parentSessionId: "parent-1",
      role: "reviewer",
    };
    const createSession = vi.fn();
    const host: any = {
      sessions: [],
      offlineSessions: [{ id: "codex-1" }],
      sessionLabels: new Map(),
      sessionBootstrap: {
        canResumeWithBackendSessionId: vi.fn(() => true),
      },
      getSessionLabel: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      saveState: vi.fn(),
      writeStatuslineFile: vi.fn(),
      debug: vi.fn(),
      createSession,
    };

    resumeOfflineSession(host, {
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      backendSessionId: "native-session",
      args: [],
      team,
      worktreePath: repoRoot,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]).toMatchObject([
      "codex",
      expect.arrayContaining(["resume", "native-session"]),
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
      "native-session",
      "codex-1",
      true,
      true,
      team,
    ]);
  });

  it("does not use display metadata when resuming an incomplete offline row", () => {
    recordSessionBackendSessionIdMetadata("codex-1", "native-session", repoRoot);
    const createSession = vi.fn();
    const host: any = {
      sessions: [],
      offlineSessions: [{ id: "codex-1" }],
      sessionLabels: new Map(),
      sessionBootstrap: {
        canResumeWithBackendSessionId: vi.fn(() => true),
      },
      getSessionLabel: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      saveState: vi.fn(),
      writeStatuslineFile: vi.fn(),
      debug: vi.fn(),
      createSession,
    };

    resumeOfflineSession(host, {
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      args: [],
      worktreePath: repoRoot,
    });

    expect(host.sessionBootstrap.canResumeWithBackendSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ command: "codex" }),
      undefined,
    );
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]).toMatchObject([
      "codex",
      expect.arrayContaining(["--dangerously-bypass-approvals-and-sandbox"]),
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
      undefined,
      "codex-1",
      true,
      true,
      undefined,
    ]);
  });

  it("repairs a missing Codex backend id from the native session file before refusing restore", () => {
    const captureDir = join(repoRoot, "codex-sessions");
    mkdirSync(captureDir, { recursive: true });
    writeFileSync(
      join(captureDir, "019e4837-66d5-7ab2-9bf6-bff1f958ecae.jsonl"),
      '{"message":"This is an aimux-managed session with session ID codex-1"}\n',
    );
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux", "config.json"),
      JSON.stringify({
        tools: {
          codex: {
            sessionCapture: {
              dir: captureDir,
              pattern: "([0-9a-f-]+)\\.jsonl$",
              delayMs: 0,
            },
          },
        },
      }),
    );
    const createSession = vi.fn();
    const host: any = {
      sessions: [],
      offlineSessions: [{ id: "codex-1" }],
      sessionLabels: new Map(),
      sessionBootstrap: {
        canResumeWithBackendSessionId: vi.fn(() => true),
      },
      getSessionLabel: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      saveState: vi.fn(),
      writeStatuslineFile: vi.fn(),
      debug: vi.fn(),
      createSession,
    };

    resumeOfflineSession(host, {
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      args: [],
      worktreePath: repoRoot,
      createdAt: new Date().toISOString(),
    });

    expect(host.sessionBootstrap.canResumeWithBackendSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ command: "codex" }),
      "019e4837-66d5-7ab2-9bf6-bff1f958ecae",
    );
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]).toMatchObject([
      "codex",
      expect.arrayContaining(["resume", "019e4837-66d5-7ab2-9bf6-bff1f958ecae"]),
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
      "019e4837-66d5-7ab2-9bf6-bff1f958ecae",
      "codex-1",
      true,
      true,
      undefined,
    ]);
  });

  it("keeps the offline row backend id over stale metadata when resuming", () => {
    recordSessionBackendSessionIdMetadata("codex-1", "backend-stale", repoRoot);
    const createSession = vi.fn();
    const host: any = {
      sessions: [],
      offlineSessions: [{ id: "codex-1", backendSessionId: "backend-current" }],
      sessionLabels: new Map(),
      sessionBootstrap: {
        canResumeWithBackendSessionId: vi.fn(() => true),
      },
      getSessionLabel: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      saveState: vi.fn(),
      writeStatuslineFile: vi.fn(),
      debug: vi.fn(),
      createSession,
    };

    resumeOfflineSession(host, {
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      backendSessionId: "backend-current",
      args: [],
      worktreePath: repoRoot,
    });

    expect(host.sessionBootstrap.canResumeWithBackendSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ command: "codex" }),
      "backend-current",
    );
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]).toMatchObject([
      "codex",
      expect.arrayContaining(["resume", "backend-current"]),
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
      "backend-current",
      "codex-1",
      true,
      true,
      undefined,
    ]);
  });

  it("refuses targeted offline restore without exact backend resume", () => {
    const createSession = vi.fn();
    const host: any = {
      sessions: [],
      offlineSessions: [{ id: "codex-1" }],
      sessionLabels: new Map(),
      sessionBootstrap: {
        canResumeWithBackendSessionId: vi.fn(() => false),
      },
      getSessionLabel: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      saveState: vi.fn(),
      writeStatuslineFile: vi.fn(),
      debug: vi.fn(),
      createSession,
    };

    expect(() =>
      resumeOfflineSession(host, {
        id: "codex-1",
        command: "codex",
        toolConfigKey: "codex",
        args: [],
        worktreePath: repoRoot,
      }),
    ).toThrow('Cannot restore session "codex-1" without an exact resumable backend session id for "codex"');

    expect(createSession).not.toHaveBeenCalled();
    expect(host.offlineSessions).toEqual([{ id: "codex-1" }]);
  });

  it("records backend session ids on live and offline sessions", () => {
    const runtime = {
      id: "claude-1",
      command: "claude",
      backendSessionId: undefined,
    };
    const offline = {
      id: "claude-2",
      command: "claude",
      backendSessionId: undefined,
    };
    const host: any = {
      sessions: [runtime],
      offlineSessions: [offline],
      syncTmuxWindowMetadata: vi.fn(),
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
    };

    expect(recordSessionBackendSessionId(host, "claude-1", " backend-live ")).toEqual({
      sessionId: "claude-1",
      backendSessionId: "backend-live",
    });
    expect(recordSessionBackendSessionId(host, "claude-2", "backend-offline")).toEqual({
      sessionId: "claude-2",
      backendSessionId: "backend-offline",
    });

    expect(runtime.backendSessionId).toBe("backend-live");
    expect(offline.backendSessionId).toBe("backend-offline");
    expect(host.syncTmuxWindowMetadata).toHaveBeenCalledWith("claude-1");
    expect(host.saveState).toHaveBeenCalledTimes(2);
  });

  it("persists hook-discovered backend ids even when the runtime row is not loaded yet", () => {
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "claude-racy",
          command: "claude",
          tool: "claude",
          toolConfigKey: "claude",
          args: ["--resume"],
          lifecycle: "live",
          worktreePath: repoRoot,
        },
      ],
    });
    const host: any = {
      sessions: [],
      offlineSessions: [],
    };

    expect(recordSessionBackendSessionId(host, "claude-racy", "backend-racy")).toEqual({
      sessionId: "claude-racy",
      backendSessionId: "backend-racy",
    });

    expect(listTopologySessionStates().find((session) => session.id === "claude-racy")?.backendSessionId).toBe(
      "backend-racy",
    );
  });

  it("does not replace saved backend ids from a hook fallback without a loaded row", () => {
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "claude-racy",
          command: "claude",
          tool: "claude",
          toolConfigKey: "claude",
          args: [],
          backendSessionId: "backend-saved",
          lifecycle: "offline",
          worktreePath: repoRoot,
        },
      ],
    });
    const host: any = {
      sessions: [],
      offlineSessions: [],
    };

    expect(recordSessionBackendSessionId(host, "claude-racy", "backend-new")).toEqual({
      sessionId: "claude-racy",
      backendSessionId: "backend-saved",
    });

    expect(listTopologySessionStates().find((session) => session.id === "claude-racy")?.backendSessionId).toBe(
      "backend-saved",
    );
  });

  it("does not let stale metadata override saved state in hook fallback", () => {
    recordSessionBackendSessionIdMetadata("claude-racy", "backend-stale", repoRoot);
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "claude-racy",
          command: "claude",
          tool: "claude",
          toolConfigKey: "claude",
          args: [],
          backendSessionId: "backend-saved",
          lifecycle: "offline",
          worktreePath: repoRoot,
        },
      ],
    });
    const host: any = {
      sessions: [],
      offlineSessions: [],
    };

    expect(recordSessionBackendSessionId(host, "claude-racy", "backend-saved")).toEqual({
      sessionId: "claude-racy",
      backendSessionId: "backend-saved",
    });

    expect(listTopologySessionStates().find((session) => session.id === "claude-racy")?.backendSessionId).toBe(
      "backend-saved",
    );
  });

  it("does not replace an existing backend session id", () => {
    const host: any = {
      sessions: [{ id: "claude-1", command: "claude", backendSessionId: "backend-original" }],
      offlineSessions: [],
    };

    expect(() => recordSessionBackendSessionId(host, "claude-1", "backend-new")).toThrow(
      'Agent "claude-1" already has backend session "backend-original"',
    );
  });

  it("does not let stale metadata override a known runtime backend id", () => {
    recordSessionBackendSessionIdMetadata("claude-1", "backend-stale", repoRoot);
    const runtime = { id: "claude-1", command: "claude", backendSessionId: "backend-current" };
    const host: any = {
      sessions: [runtime],
      offlineSessions: [],
      syncTmuxWindowMetadata: vi.fn(),
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
    };

    expect(recordSessionBackendSessionId(host, "claude-1", "backend-current")).toEqual({
      sessionId: "claude-1",
      backendSessionId: "backend-current",
    });
    expect(runtime.backendSessionId).toBe("backend-current");
  });

  it("does not fill instance heartbeat refs from backend metadata", () => {
    recordSessionBackendSessionIdMetadata("claude-racy", "backend-racy", repoRoot);
    const host: any = {
      sessions: [{ id: "claude-racy", command: "claude" }],
      sessionWorktreePaths: new Map([["claude-racy", repoRoot]]),
    };

    expect(getInstanceSessionRefs(host)).toEqual([
      {
        id: "claude-racy",
        tool: "claude",
        backendSessionId: undefined,
        team: undefined,
        worktreePath: repoRoot,
      },
    ]);
  });

  it("does not reload a starting session as offline from stale saved state", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setSessionAction("codex-1", "starting");
    const host: any = {
      sessions: [],
      offlineSessions: [],
      getRemoteInstancesSafe: vi.fn(() => []),
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      dashboardPendingActions: pending,
      debug: vi.fn(),
    };

    seedTopologySessions([
      {
        id: "codex-1",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "offline",
        backendSessionId: "native-session",
        worktreePath: repoRoot,
      },
    ]);

    const changed = loadOfflineTopologySessions(host);

    expect(changed).toBe(false);
    expect(host.offlineSessions).toEqual([]);
  });

  it("does not hide an offline session when only a service with the same id is starting", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setServiceAction("codex-1", "starting");
    const host: any = {
      sessions: [],
      offlineSessions: [],
      getRemoteInstancesSafe: vi.fn(() => []),
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      dashboardPendingActions: pending,
      debug: vi.fn(),
    };

    seedTopologySessions([
      {
        id: "codex-1",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "offline",
        backendSessionId: "native-session",
        worktreePath: repoRoot,
      },
    ]);

    const changed = loadOfflineTopologySessions(host);

    expect(changed).toBe(true);
    expect(host.offlineSessions).toMatchObject([{ id: "codex-1" }]);
  });

  it("does not reload a starting service as offline from stale saved state", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setServiceAction("service-1", "starting");
    const host: any = {
      offlineServices: [],
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      dashboardPendingActions: pending,
    };

    const changed = loadOfflineServices(host, {
      sessions: [],
      services: [
        {
          id: "service-1",
          label: "shell",
          worktreePath: repoRoot,
        },
      ],
      updatedAt: new Date().toISOString(),
    });

    expect(changed).toBe(false);
    expect(host.offlineServices).toEqual([]);
  });

  it("does not hide an offline service when only a session with the same id is starting", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setSessionAction("service-1", "starting");
    const host: any = {
      offlineServices: [],
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      dashboardPendingActions: pending,
    };

    const changed = loadOfflineServices(host, {
      sessions: [],
      services: [
        {
          id: "service-1",
          label: "shell",
          worktreePath: repoRoot,
        },
      ],
      updatedAt: new Date().toISOString(),
    });

    expect(changed).toBe(true);
    expect(host.offlineServices).toMatchObject([{ id: "service-1" }]);
  });

  it("does not resurrect legacy live snapshots as offline sessions", () => {
    const host: any = {
      sessions: [],
      offlineSessions: [],
      getRemoteInstancesSafe: vi.fn(() => []),
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      debug: vi.fn(),
    };

    const changed = loadOfflineTopologySessions(host);

    expect(changed).toBe(false);
    expect(host.offlineSessions).toEqual([]);
  });

  it("loads recoverable live sessions as offline when their tmux window is gone", () => {
    const host: any = {
      sessions: [],
      offlineSessions: [],
      getRemoteInstancesSafe: vi.fn(() => []),
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      debug: vi.fn(),
    };

    seedTopologySessions([
      {
        id: "claude-recoverable",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: ["--resume", "native-session"],
        lifecycle: "offline",
        backendSessionId: "native-session",
        worktreePath: repoRoot,
        tmuxTarget: {
          sessionName: "aimux-test",
          windowId: "@2",
          windowIndex: 2,
          windowName: "claude",
        },
      },
    ]);

    const changed = loadOfflineTopologySessions(host);

    expect(changed).toBe(true);
    expect(host.offlineSessions).toMatchObject([
      {
        id: "claude-recoverable",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: ["--resume", "native-session"],
        lifecycle: "offline",
        backendSessionId: "native-session",
        worktreePath: repoRoot,
      },
    ]);
  });

  it("ignores metadata backend ids while loading offline topology rows", () => {
    recordSessionBackendSessionIdMetadata("claude-recoverable", "backend-from-metadata", repoRoot);
    recordSessionBackendSessionIdMetadata("metadata-only", "backend-metadata-only", repoRoot);
    const host: any = {
      sessions: [],
      offlineSessions: [],
      getRemoteInstancesSafe: vi.fn(() => []),
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      debug: vi.fn(),
    };

    seedTopologySessions([
      {
        id: "claude-recoverable",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: ["--resume"],
        lifecycle: "offline",
        worktreePath: repoRoot,
      },
    ]);

    const changed = loadOfflineTopologySessions(host);

    expect(changed).toBe(true);
    expect(host.offlineSessions).toEqual([
      expect.objectContaining({
        id: "claude-recoverable",
        backendSessionId: undefined,
      }),
    ]);
  });

  it("does not report offline session changes for metadata-only backend ids", () => {
    const host: any = {
      sessions: [],
      offlineSessions: [
        {
          id: "claude-recoverable",
          command: "claude",
          tool: "claude",
          toolConfigKey: "claude",
          args: [],
          lifecycle: "offline",
          worktreePath: repoRoot,
        },
      ],
      getRemoteInstancesSafe: vi.fn(() => []),
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      debug: vi.fn(),
    };
    recordSessionBackendSessionIdMetadata("claude-recoverable", "backend-from-metadata", repoRoot);

    seedTopologySessions([
      {
        id: "claude-recoverable",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        lifecycle: "offline",
        worktreePath: repoRoot,
      },
    ]);

    const changed = loadOfflineTopologySessions(host);

    expect(changed).toBe(false);
    expect(host.offlineSessions[0].backendSessionId).toBeUndefined();
  });

  it("loads valid live sessions without backend ids as offline when their tmux window is gone", () => {
    const host: any = {
      sessions: [],
      offlineSessions: [],
      getRemoteInstancesSafe: vi.fn(() => []),
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      debug: vi.fn(),
    };

    seedTopologySessions([
      {
        id: "claude-recoverable",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        lifecycle: "offline",
        worktreePath: repoRoot,
      },
    ]);

    const changed = loadOfflineTopologySessions(host);

    expect(changed).toBe(true);
    expect(host.offlineSessions).toMatchObject([
      {
        id: "claude-recoverable",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        lifecycle: "offline",
        worktreePath: repoRoot,
      },
    ]);
  });

  it("loads explicit offline sessions without trusting stale tmux targets", () => {
    const host: any = {
      sessions: [],
      offlineSessions: [],
      getRemoteInstancesSafe: vi.fn(() => []),
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      debug: vi.fn(),
    };

    seedTopologySessions([
      {
        id: "codex-offline",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "offline",
        tmuxTarget: {
          sessionName: "aimux-test",
          windowId: "@4",
          windowIndex: 4,
          windowName: "codex",
        },
      },
    ]);

    const changed = loadOfflineTopologySessions(host);

    expect(changed).toBe(true);
    expect(host.offlineSessions).toMatchObject([
      {
        id: "codex-offline",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "offline",
      },
    ]);
  });

  it("graveyards stale visible seed rows even when they are not loaded as offline", () => {
    const host: any = {
      offlineSessions: [],
      noteLastUsedItem: vi.fn(),
      debug: vi.fn(),
    };
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "codex-stale",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: [],
          lifecycle: "offline",
          worktreePath: repoRoot,
        },
      ],
    });

    graveyardSession(host, "codex-stale", {
      id: "codex-stale",
      command: "codex",
      tool: "codex",
      toolConfigKey: "codex",
      lifecycle: "offline",
      worktreePath: repoRoot,
    });

    const graveyard = listTopologySessionStates({ statuses: ["graveyard"] });
    expect(listTopologySessionStates({ statuses: ["offline"] }).map((entry) => entry.id)).toEqual([]);
    expect(graveyard.map((entry) => entry.id)).toContain("codex-stale");
  });

  it("restores team role from tmux metadata", () => {
    const team = {
      teamId: "team-1",
      parentSessionId: "parent-1",
      role: "reviewer",
    };
    const host: any = {
      sessions: [],
      sessionTmuxTargets: new Map(),
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => [
          {
            target: {
              sessionName: "aimux-test",
              windowId: "@1",
              windowIndex: 1,
              windowName: "codex",
            },
            metadata: {
              kind: "agent",
              sessionId: "codex-1",
              command: "codex",
              args: [],
              toolConfigKey: "codex",
              worktreePath: repoRoot,
              role: "reviewer",
              team,
              createdAt: "2026-04-21T00:00:00.000Z",
            },
          },
        ]),
      },
      registerManagedSession: vi.fn(),
      sessionLabels: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
    };

    restoreTmuxSessionsFromTopology(host);

    expect(host.registerManagedSession).toHaveBeenCalledWith(
      expect.anything(),
      [],
      "codex",
      repoRoot,
      "reviewer",
      Date.parse("2026-04-21T00:00:00.000Z"),
      team,
    );
  });

  it("evicts in-memory runtimes that no longer have matching live tmux metadata", () => {
    const host: any = {
      sessions: [{ id: "codex-stale", command: "codex", transport: {} }],
      sessionTmuxTargets: new Map([
        [
          "codex-stale",
          {
            sessionName: "aimux-test",
            windowId: "@8",
            windowIndex: 8,
            windowName: "codex",
          },
        ],
      ]),
      sessionToolKeys: new Map([["codex-stale", "codex"]]),
      sessionOriginalArgs: new Map([["codex-stale", []]]),
      sessionWorktreePaths: new Map([["codex-stale", repoRoot]]),
      sessionRoles: new Map(),
      stoppingSessionIds: new Set(),
      contextWatcher: { stop: vi.fn() },
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      updateContextWatcherSessions: vi.fn(),
      debug: vi.fn(),
    };

    restoreTmuxSessionsFromTopology(host);

    expect(host.sessions).toEqual([]);
    expect(host.sessionTmuxTargets.has("codex-stale")).toBe(false);
    expect(host.updateContextWatcherSessions).toHaveBeenCalled();
  });

  it("does not treat dead service windows as live", () => {
    const saved = {
      id: "service-1",
      command: "shell",
      args: [],
      label: "shell",
      worktreePath: repoRoot,
    };
    const deadTarget = {
      sessionName: "aimux-test",
      windowId: "@2",
      windowIndex: 2,
      windowName: "shell",
    };
    const host: any = {
      offlineServices: [],
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => [
          {
            target: deadTarget,
            metadata: {
              kind: "service",
              sessionId: "service-1",
              command: "shell",
              args: [],
              label: "shell",
              worktreePath: repoRoot,
            },
          },
        ]),
        isWindowAlive: vi.fn(() => false),
      },
    };

    const changed = loadOfflineServices(host, { sessions: [], services: [saved] });

    expect(changed).toBe(true);
    expect(host.offlineServices).toEqual([saved]);
    expect(buildLiveServiceStates(host)).toEqual([]);
  });
});
