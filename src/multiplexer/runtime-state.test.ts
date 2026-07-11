import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths, withProjectPaths } from "../paths.js";
import { loadMetadataState, updateSessionMetadata } from "../metadata-store.js";
import { DashboardPendingActions } from "../dashboard/pending-actions.js";
import {
  listTopologySessionStates,
  saveRuntimeTopologySessions,
  upsertTopologySession,
} from "../runtime-core/topology-sessions.js";
import { listTopologyServiceStates, upsertTopologyService } from "../runtime-core/topology-services.js";
import { runtimeLifecycleMethods } from "./runtime-lifecycle-methods.js";
import {
  buildLiveServiceStates,
  graveyardSession,
  loadOfflineServices,
  loadOfflineTopologySessions,
  reconcileOrphanedTopologyServices,
  recordSessionBackendSessionId,
  reconcileOrphanedTopologySessions,
  restoreTmuxSessionsFromTopology,
  resumeOfflineSession,
  startStatusRefresh,
  stopStatusRefresh,
  stopSessionToOffline,
} from "./runtime-state.js";

describe("startStatusRefresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not notify immediately when an agent briefly becomes idle", () => {
    vi.useFakeTimers();
    const host: any = {
      statusInterval: null,
      sessions: [{ id: "codex-1", status: "idle" }],
      prevStatuses: new Map([["codex-1", "running"]]),
      dashboardFeedback: { tickFlashVisibilityChanged: vi.fn(() => false) },
      mode: "agent",
      publishAlert: vi.fn(),
    };

    startStatusRefresh(host);
    vi.advanceTimersByTime(1000);
    stopStatusRefresh(host);

    expect(host.publishAlert).not.toHaveBeenCalled();
    expect(host.prevStatuses.get("codex-1")).toBe("idle");
  });

  it("notifies when an agent stays idle after finishing a turn", () => {
    vi.useFakeTimers();
    const host: any = {
      statusInterval: null,
      sessions: [{ id: "codex-1", status: "idle" }],
      prevStatuses: new Map([["codex-1", "running"]]),
      dashboardFeedback: { tickFlashVisibilityChanged: vi.fn(() => false) },
      mode: "agent",
      publishAlert: vi.fn(),
    };

    startStatusRefresh(host);
    vi.advanceTimersByTime(11_000);
    stopStatusRefresh(host);

    expect(host.publishAlert).toHaveBeenCalledTimes(1);
    expect(host.publishAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "next_step",
        sessionId: "codex-1",
        dedupeKey: "idle-needs-input:codex-1",
      }),
    );
  });

  it("cancels idle notification when the agent resumes work before settling", () => {
    vi.useFakeTimers();
    const session = { id: "codex-1", status: "idle" };
    const host: any = {
      statusInterval: null,
      sessions: [session],
      prevStatuses: new Map([["codex-1", "running"]]),
      dashboardFeedback: { tickFlashVisibilityChanged: vi.fn(() => false) },
      mode: "agent",
      publishAlert: vi.fn(),
    };

    startStatusRefresh(host);
    vi.advanceTimersByTime(5_000);
    session.status = "running";
    vi.advanceTimersByTime(1_000);
    session.status = "idle";
    vi.advanceTimersByTime(5_000);
    stopStatusRefresh(host);

    expect(host.publishAlert).not.toHaveBeenCalled();
  });

  it("does not render an in-flight background dashboard refresh after leaving dashboard mode", async () => {
    vi.useFakeTimers();
    let resolveRefresh!: (value: boolean) => void;
    const host: any = {
      statusInterval: null,
      sessions: [],
      prevStatuses: new Map(),
      dashboardFeedback: { tickFlashVisibilityChanged: vi.fn(() => false) },
      mode: "dashboard",
      dashboardNextBackgroundRefreshAt: 0,
      isDashboardScreen: vi.fn((screen: string) => screen === "coordination"),
      refreshDashboardModelFromService: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      refreshCoordinationFromService: vi.fn(async () => true),
      renderCurrentDashboardView: vi.fn(),
      publishAlert: vi.fn(),
    };

    startStatusRefresh(host);
    await vi.advanceTimersByTimeAsync(1000);
    host.mode = "session";
    resolveRefresh(true);
    await Promise.resolve();
    await Promise.resolve();
    stopStatusRefresh(host);

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledOnce();
    expect(host.refreshCoordinationFromService).not.toHaveBeenCalled();
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
  });

  it("does not render an in-flight background dashboard refresh after input changes", async () => {
    vi.useFakeTimers();
    let resolveRefresh!: (value: boolean) => void;
    const host: any = {
      statusInterval: null,
      sessions: [],
      prevStatuses: new Map(),
      dashboardFeedback: { tickFlashVisibilityChanged: vi.fn(() => false) },
      mode: "dashboard",
      dashboardInputEpoch: 1,
      dashboardNextBackgroundRefreshAt: 0,
      isDashboardScreen: vi.fn((screen: string) => screen === "coordination"),
      refreshDashboardModelFromService: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
      refreshCoordinationFromService: vi.fn(async () => true),
      renderCurrentDashboardView: vi.fn(),
      publishAlert: vi.fn(),
    };

    startStatusRefresh(host);
    await vi.advanceTimersByTimeAsync(1000);
    host.dashboardInputEpoch = 2;
    resolveRefresh(true);
    await Promise.resolve();
    await Promise.resolve();
    stopStatusRefresh(host);

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledOnce();
    expect(host.refreshCoordinationFromService).not.toHaveBeenCalled();
    expect(host.renderCurrentDashboardView).not.toHaveBeenCalled();
  });

  it("renders heartbeat-only dashboard feedback without waiting for background refresh", async () => {
    vi.useFakeTimers();
    const host: any = {
      statusInterval: null,
      sessions: [],
      prevStatuses: new Map(),
      dashboardFeedback: { tickFlashVisibilityChanged: vi.fn(() => true) },
      mode: "dashboard",
      dashboardNextBackgroundRefreshAt: 0,
      refreshDashboardModelFromService: vi.fn(() => new Promise<boolean>(() => undefined)),
      renderCurrentDashboardView: vi.fn(),
      publishAlert: vi.fn(),
    };

    startStatusRefresh(host);
    await vi.advanceTimersByTimeAsync(1000);
    stopStatusRefresh(host);

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledOnce();
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
  });

  it("does not run dashboard background API refresh while startup is priming", async () => {
    vi.useFakeTimers();
    const host: any = {
      statusInterval: null,
      sessions: [],
      prevStatuses: new Map(),
      dashboardFeedback: { tickFlashVisibilityChanged: vi.fn(() => true) },
      mode: "dashboard",
      dashboardStartupPriming: true,
      dashboardNextBackgroundRefreshAt: 0,
      refreshDashboardModelFromService: vi.fn(async () => true),
      renderCurrentDashboardView: vi.fn(),
      publishAlert: vi.fn(),
    };

    startStatusRefresh(host);
    await vi.advanceTimersByTimeAsync(1000);
    stopStatusRefresh(host);

    expect(host.refreshDashboardModelFromService).not.toHaveBeenCalled();
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
  });
});

describe("resumeOfflineSession", () => {
  let repoRoot = "";

  function seedTopologySessions(sessions: any[]): void {
    saveRuntimeTopologySessions({
      sessions,
      projectRoot: repoRoot,
    });
  }

  function seedOfflineSession(session: any): any {
    const topologySession = {
      command: session.command,
      tool: session.tool ?? session.toolConfigKey ?? session.command,
      toolConfigKey: session.toolConfigKey ?? session.tool ?? session.command,
      args: session.args ?? [],
      lifecycle: "offline",
      ...session,
    };
    seedTopologySessions([topologySession]);
    return topologySession;
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
      backendSessionId: "backend-current",
      startTime: Date.parse("2026-05-01T00:00:00.000Z"),
      kill: vi.fn(),
    };
    const host: any = {
      projectRoot: repoRoot,
      sessions: [session],
      stoppingSessionIds: new Set(),
      offlineSessions: [{ id: "codex-1", command: "codex", backendSessionId: "backend-stale" }],
      offlineServices: [],
      sessionToolKeys: new Map([["codex-1", "codex"]]),
      sessionOriginalArgs: new Map([["codex-1", []]]),
      sessionWorktreePaths: new Map([["codex-1", repoRoot]]),
      sessionTmuxTargets: new Map(),
      getSessionLabel: vi.fn(() => "codex"),
      deriveHeadline: vi.fn(() => "summary"),
      noteLastUsedItem: vi.fn(),
      buildLiveServiceStates: vi.fn(() => []),
      isSessionRuntimeLive: vi.fn(() => false),
      invalidateDesktopStateSnapshot: vi.fn(),
      saveState: vi.fn(() => runtimeLifecycleMethods.saveState.call(host as never)),
      debug: vi.fn(),
    };

    stopSessionToOffline(host, session);

    expect(host.noteLastUsedItem).toHaveBeenCalledWith("codex-1");
    expect(host.offlineSessions).toEqual([]);
    expect(listTopologySessionStates({ statuses: ["offline"] })).toMatchObject([
      { id: "codex-1", lifecycle: "offline", backendSessionId: "backend-current" },
    ]);
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
    seedOfflineSession({
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      backendSessionId: "native-session",
      args: [],
      team,
      worktreePath: repoRoot,
    });

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

  it("prunes stale offline cache rows instead of resuming without topology authority", () => {
    const createSession = vi.fn();
    const host: any = {
      sessions: [],
      offlineSessions: [{ id: "codex-stale", command: "codex", toolConfigKey: "codex" }],
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      debug: vi.fn(),
      createSession,
    };

    resumeOfflineSession(host, {
      id: "codex-stale",
      command: "codex",
      toolConfigKey: "codex",
      args: [],
      worktreePath: repoRoot,
    });

    expect(createSession).not.toHaveBeenCalled();
    expect(host.offlineSessions).toEqual([]);
    expect(host.invalidateDesktopStateSnapshot).toHaveBeenCalledOnce();
    expect(host.writeStatuslineFile).toHaveBeenCalledOnce();
    expect(listTopologySessionStates()).toEqual([]);
  });

  it("does not resume an offline cache row from another project's topology", () => {
    const otherRepoRoot = mkdtempSync(join(tmpdir(), "aimux-runtime-state-other-"));
    try {
      mkdirSync(join(otherRepoRoot, ".git"), { recursive: true });
      withProjectPaths(otherRepoRoot, () => {
        saveRuntimeTopologySessions({
          projectRoot: otherRepoRoot,
          sessions: [
            {
              id: "codex-shared",
              command: "codex",
              tool: "codex",
              toolConfigKey: "codex",
              args: [],
              backendSessionId: "backend-other",
              lifecycle: "offline",
              worktreePath: otherRepoRoot,
            },
          ],
        });
      });
      const createSession = vi.fn();
      const host: any = {
        projectRoot: repoRoot,
        sessions: [],
        offlineSessions: [{ id: "codex-shared", command: "codex", toolConfigKey: "codex" }],
        invalidateDesktopStateSnapshot: vi.fn(),
        writeStatuslineFile: vi.fn(),
        debug: vi.fn(),
        createSession,
      };

      resumeOfflineSession(host, {
        id: "codex-shared",
        command: "codex",
        toolConfigKey: "codex",
        args: [],
        worktreePath: repoRoot,
      });

      expect(createSession).not.toHaveBeenCalled();
      expect(host.offlineSessions).toEqual([]);
      expect(
        withProjectPaths(otherRepoRoot, () =>
          listTopologySessionStates({ statuses: ["offline"], projectRoot: otherRepoRoot }),
        ),
      ).toMatchObject([{ id: "codex-shared", backendSessionId: "backend-other" }]);
    } finally {
      rmSync(otherRepoRoot, { recursive: true, force: true });
    }
  });

  it("settles a stale running activity to idle on backend resume", () => {
    updateSessionMetadata("codex-1", (current) => ({
      ...current,
      derived: { ...(current.derived ?? {}), activity: "running", attention: "normal" },
    }));
    const host: any = {
      sessions: [],
      offlineSessions: [{ id: "codex-1" }],
      sessionLabels: new Map(),
      sessionBootstrap: { canResumeWithBackendSessionId: vi.fn(() => true) },
      getSessionLabel: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      saveState: vi.fn(),
      writeStatuslineFile: vi.fn(),
      debug: vi.fn(),
      createSession: vi.fn(),
    };
    seedOfflineSession({
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      backendSessionId: "native-session",
      args: [],
      worktreePath: repoRoot,
    });

    resumeOfflineSession(host, {
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      backendSessionId: "native-session",
      args: [],
      worktreePath: repoRoot,
    });

    expect(loadMetadataState().sessions["codex-1"]?.derived?.activity).toBe("idle");
  });

  it("preserves a needs_input agent's waiting activity on resume", () => {
    updateSessionMetadata("codex-1", (current) => ({
      ...current,
      derived: { ...(current.derived ?? {}), activity: "waiting", attention: "needs_input" },
    }));
    const host: any = {
      sessions: [],
      offlineSessions: [{ id: "codex-1" }],
      sessionLabels: new Map(),
      sessionBootstrap: { canResumeWithBackendSessionId: vi.fn(() => true) },
      getSessionLabel: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      saveState: vi.fn(),
      writeStatuslineFile: vi.fn(),
      debug: vi.fn(),
      createSession: vi.fn(),
    };
    seedOfflineSession({
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      backendSessionId: "native-session",
      args: [],
      worktreePath: repoRoot,
    });

    resumeOfflineSession(host, {
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      backendSessionId: "native-session",
      args: [],
      worktreePath: repoRoot,
    });

    const derived = loadMetadataState().sessions["codex-1"]?.derived;
    expect(derived?.activity).toBe("waiting");
    expect(derived?.attention).toBe("needs_input");
  });

  it("does not use display metadata when resuming an incomplete offline row", () => {
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
    seedOfflineSession({
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      args: [],
      worktreePath: repoRoot,
    });

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

  it("refuses restore without a topology-owned backend id instead of repairing from session files", () => {
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
        canResumeWithBackendSessionId: vi.fn(() => false),
      },
      getSessionLabel: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      saveState: vi.fn(),
      writeStatuslineFile: vi.fn(),
      debug: vi.fn(),
      createSession,
    };
    seedOfflineSession({
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      args: [],
      worktreePath: repoRoot,
      createdAt: new Date().toISOString(),
    });

    expect(() =>
      resumeOfflineSession(host, {
        id: "codex-1",
        command: "codex",
        toolConfigKey: "codex",
        args: [],
        worktreePath: repoRoot,
        createdAt: new Date().toISOString(),
      }),
    ).toThrow('Cannot restore session "codex-1" without an exact resumable backend session id');

    expect(host.sessionBootstrap.canResumeWithBackendSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ command: "codex" }),
      undefined,
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it("keeps the offline row backend id over stale metadata when resuming", () => {
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
    seedOfflineSession({
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      backendSessionId: "backend-current",
      args: [],
      worktreePath: repoRoot,
    });

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
    seedOfflineSession({
      id: "codex-1",
      command: "codex",
      toolConfigKey: "codex",
      args: [],
      worktreePath: repoRoot,
    });

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

  it("reconciles a missing claude backend id from the on-disk transcript instead of refusing", () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "aimux-claude-home-"));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    try {
      const cwd = join(repoRoot, "wt", "feature");
      const encoded = cwd.replace(/[/.]/g, "-");
      const dir = join(claudeHome, "projects", encoded);
      mkdirSync(dir, { recursive: true });
      const uuid = "0710a963-a473-430f-9f9a-e27dd4546328";
      writeFileSync(join(dir, `${uuid}.jsonl`), "{}\n");
      seedTopologySessions([
        {
          id: "claude-1",
          command: "claude",
          tool: "claude",
          toolConfigKey: "claude",
          args: [],
          lifecycle: "offline",
          worktreePath: cwd,
        },
      ]);

      const createSession = vi.fn();
      const host: any = {
        sessions: [],
        offlineSessions: [{ id: "claude-1" }],
        sessionLabels: new Map(),
        sessionBootstrap: { canResumeWithBackendSessionId: vi.fn((_cfg: any, id: any) => Boolean(id)) },
        getSessionLabel: vi.fn(),
        invalidateDesktopStateSnapshot: vi.fn(),
        saveState: vi.fn(),
        writeStatuslineFile: vi.fn(),
        debug: vi.fn(),
        createSession,
      };

      resumeOfflineSession(host, {
        id: "claude-1",
        command: "claude",
        toolConfigKey: "claude",
        args: [],
        worktreePath: cwd,
      });

      expect(createSession).toHaveBeenCalledTimes(1);
      const call = createSession.mock.calls[0];
      expect(call[7]).toBe(uuid); // backendSessionId passed to createSession
      expect(call[10]).toBe(true); // useBackendResume
    } finally {
      rmSync(claudeHome, { recursive: true, force: true });
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it("marks fresh relaunches with the backend id they supersede", () => {
    const restoredSession: any = {};
    const createSession = vi.fn(() => restoredSession);
    updateSessionMetadata("claude-error", (current) => ({
      ...current,
      derived: { activity: "error", attention: "error" },
    }));
    const host: any = {
      sessions: [],
      offlineSessions: [{ id: "claude-error", backendSessionId: "backend-old" }],
      sessionLabels: new Map(),
      sessionBootstrap: {
        canResumeWithBackendSessionId: vi.fn(() => false),
      },
      getSessionLabel: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      debug: vi.fn(),
      createSession,
    };
    seedOfflineSession({
      id: "claude-error",
      command: "claude",
      toolConfigKey: "claude",
      backendSessionId: "backend-old",
      args: [],
      worktreePath: repoRoot,
    });

    resumeOfflineSession(host, {
      id: "claude-error",
      command: "claude",
      toolConfigKey: "claude",
      backendSessionId: "backend-old",
      args: [],
      worktreePath: repoRoot,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0][7]).toBeUndefined();
    expect(createSession.mock.calls[0][10]).toBe(false);
    expect(restoredSession.supersededBackendSessionId).toBe("backend-old");
  });

  it("fresh relaunches backend-less sessions with no user history", () => {
    const createSession = vi.fn(() => ({}));
    const host: any = {
      sessions: [],
      offlineSessions: [{ id: "codex-empty" }],
      sessionLabels: new Map(),
      sessionBootstrap: { canResumeWithBackendSessionId: vi.fn(() => false) },
      getSessionLabel: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      debug: vi.fn(),
      createSession,
    };
    seedOfflineSession({
      id: "codex-empty",
      command: "codex",
      toolConfigKey: "codex",
      args: [],
      freshRelaunchAllowed: true,
      worktreePath: repoRoot,
    });

    resumeOfflineSession(host, {
      id: "codex-empty",
      command: "codex",
      toolConfigKey: "codex",
      args: [],
      freshRelaunchAllowed: true,
      worktreePath: repoRoot,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0][7]).toBeUndefined();
    expect(createSession.mock.calls[0][10]).toBe(false);
  });

  it("records backend session ids on live and offline sessions", () => {
    seedTopologySessions([
      {
        id: "claude-1",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        lifecycle: "live",
      },
      {
        id: "claude-2",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        lifecycle: "offline",
      },
    ]);
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

  it("rejects stale backend ids from a superseded launch before a fresh relaunch records its new id", () => {
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "claude-racy",
          command: "claude",
          tool: "claude",
          toolConfigKey: "claude",
          args: [],
          backendSessionId: "backend-stale",
          lifecycle: "offline",
          worktreePath: repoRoot,
        },
      ],
    });
    const runtime = {
      id: "claude-racy",
      command: "claude",
      backendSessionId: undefined,
      supersededBackendSessionId: "backend-stale",
    };
    const host: any = {
      sessions: [runtime],
      offlineSessions: [],
      syncTmuxWindowMetadata: vi.fn(),
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
    };

    expect(() => recordSessionBackendSessionId(host, "claude-racy", "backend-stale")).toThrow(
      'Agent "claude-racy" ignored stale backend session "backend-stale" from a superseded launch',
    );

    expect(recordSessionBackendSessionId(host, "claude-racy", "backend-new")).toEqual({
      sessionId: "claude-racy",
      backendSessionId: "backend-new",
    });
    expect(runtime.backendSessionId).toBe("backend-new");
  });

  it("records hook-discovered backend ids when topology exists but the host row is not loaded", () => {
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

  it("recovers a missing backend id from the project root before restoring a main-checkout session", () => {
    const claudeHome = mkdtempSync(join(tmpdir(), "aimux-runtime-state-claude-"));
    const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = claudeHome;
      const backendSessionId = "0710a963-a473-430f-9f9a-e27dd4546328";
      const transcriptDir = join(claudeHome, "projects", repoRoot.replace(/[/.]/g, "-"));
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(join(transcriptDir, `${backendSessionId}.jsonl`), "{}\n");
      seedTopologySessions([
        {
          id: "claude-main",
          command: "claude",
          tool: "claude",
          toolConfigKey: "claude",
          args: [],
          lifecycle: "offline",
        },
      ]);
      const createSession = vi.fn();
      const host: any = {
        sessions: [],
        offlineSessions: [{ id: "claude-main" }],
        sessionLabels: new Map(),
        sessionBootstrap: {
          canResumeWithBackendSessionId: vi.fn((_toolCfg, id) => id === backendSessionId),
        },
        getSessionLabel: vi.fn(),
        invalidateDesktopStateSnapshot: vi.fn(),
        writeStatuslineFile: vi.fn(),
        debug: vi.fn(),
        createSession,
      };

      resumeOfflineSession(host, {
        id: "claude-main",
        command: "claude",
        toolConfigKey: "claude",
        args: [],
        createdAt: new Date().toISOString(),
      });

      expect(createSession).toHaveBeenCalledTimes(1);
      const call = createSession.mock.calls[0];
      expect(call[0]).toBe("claude");
      expect(call[1]).toEqual(expect.arrayContaining(["--resume", backendSessionId]));
      expect(call[3]).toBe("claude");
      expect(call[6]).toBeUndefined();
      expect(call[7]).toBe(backendSessionId);
      expect(call[8]).toBe("claude-main");
      expect(listTopologySessionStates().find((session) => session.id === "claude-main")?.backendSessionId).toBe(
        backendSessionId,
      );
    } finally {
      if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
      rmSync(claudeHome, { recursive: true, force: true });
    }
  });

  it("does not accept conflicting hook fallback backend ids without a loaded row", () => {
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

    expect(() => recordSessionBackendSessionId(host, "claude-racy", "backend-new")).toThrow(
      'Agent "claude-racy" already has backend session "backend-saved"',
    );

    expect(listTopologySessionStates().find((session) => session.id === "claude-racy")?.backendSessionId).toBe(
      "backend-saved",
    );
  });

  it("accepts matching hook fallback backend ids from topology without a loaded row", () => {
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

  it("lets a live runtime replace a stale topology backend id during fresh relaunch", () => {
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "claude-racy",
          command: "claude",
          tool: "claude",
          toolConfigKey: "claude",
          args: [],
          backendSessionId: "backend-stale",
          lifecycle: "offline",
          worktreePath: repoRoot,
        },
      ],
    });
    const runtime = {
      id: "claude-racy",
      command: "claude",
      backendSessionId: undefined,
    };
    const host: any = {
      sessions: [runtime],
      offlineSessions: [],
      syncTmuxWindowMetadata: vi.fn(),
      saveState: vi.fn(),
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
    };

    expect(recordSessionBackendSessionId(host, "claude-racy", "backend-new")).toEqual({
      sessionId: "claude-racy",
      backendSessionId: "backend-new",
    });

    expect(runtime.backendSessionId).toBe("backend-new");
    const topologySession = listTopologySessionStates().find((session) => session.id === "claude-racy");
    expect(topologySession?.backendSessionId).toBe("backend-new");
    expect(topologySession?.status).toBe("running");
    expect(host.syncTmuxWindowMetadata).toHaveBeenCalledWith("claude-racy");
  });

  it("does not replace an existing backend session id", () => {
    seedTopologySessions([
      {
        id: "claude-1",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        backendSessionId: "backend-original",
        lifecycle: "live",
      },
    ]);
    const host: any = {
      sessions: [{ id: "claude-1", command: "claude", backendSessionId: "backend-original" }],
      offlineSessions: [],
    };

    expect(() => recordSessionBackendSessionId(host, "claude-1", "backend-new")).toThrow(
      'Agent "claude-1" already has backend session "backend-original"',
    );
  });

  it("does not let stale metadata override a known runtime backend id", () => {
    seedTopologySessions([
      {
        id: "claude-1",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        lifecycle: "live",
      },
    ]);
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

  it("does not reload a starting session as offline from stale saved state", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setSessionAction("codex-1", "starting");
    const host: any = {
      sessions: [],
      offlineSessions: [],
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

    const changed = loadOfflineServices(host);

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

    upsertTopologyService({ id: "service-1", label: "shell", worktreePath: repoRoot }, "stopped", {
      projectRoot: repoRoot,
    });

    const changed = loadOfflineServices(host);

    expect(changed).toBe(true);
    expect(host.offlineServices).toMatchObject([{ id: "service-1" }]);
  });

  it("loads stopped services from topology", () => {
    upsertTopologyService(
      {
        id: "service-topology",
        label: "web",
        launchCommandLine: "yarn web",
        worktreePath: repoRoot,
      },
      "stopped",
      { projectRoot: repoRoot },
    );
    const host: any = {
      offlineServices: [],
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      dashboardPendingActions: new DashboardPendingActions(() => {}),
    };

    const changed = loadOfflineServices(host);

    expect(changed).toBe(true);
    expect(host.offlineServices).toMatchObject([{ id: "service-topology", launchCommandLine: "yarn web" }]);
  });

  it("demotes crash-orphaned running services to stopped before loading offline services", () => {
    upsertTopologyService(
      {
        id: "service-orphan",
        label: "web",
        launchCommandLine: "yarn web",
        worktreePath: repoRoot,
        tmuxTarget: { sessionName: "aimux-repo", windowId: "@3", windowIndex: 3, windowName: "web" },
      },
      "running",
      { projectRoot: repoRoot },
    );
    const host: any = {
      projectRoot: repoRoot,
      offlineServices: [],
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      dashboardPendingActions: new DashboardPendingActions(() => {}),
      debug: vi.fn(),
    };

    const changed = loadOfflineServices(host);

    expect(changed).toBe(true);
    expect(listTopologyServiceStates({ statuses: ["running"] })).toEqual([]);
    expect(listTopologyServiceStates({ statuses: ["stopped"] })).toMatchObject([
      { id: "service-orphan", launchCommandLine: "yarn web" },
    ]);
    expect(host.offlineServices).toMatchObject([{ id: "service-orphan", launchCommandLine: "yarn web" }]);
  });

  it("does not demote a service that is mid-launch", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setServiceAction("service-starting", "starting");
    upsertTopologyService({ id: "service-starting", label: "web", worktreePath: repoRoot }, "starting", {
      projectRoot: repoRoot,
    });
    const host: any = {
      projectRoot: repoRoot,
      offlineServices: [],
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => []),
      },
      dashboardPendingActions: pending,
      debug: vi.fn(),
    };

    const changed = reconcileOrphanedTopologyServices(host);

    expect(changed).toBe(false);
    expect(listTopologyServiceStates({ statuses: ["starting"] }).map((service) => service.id)).toEqual([
      "service-starting",
    ]);
  });

  it("cleans up legacy stopped service windows and keeps the service offline", () => {
    const target = { sessionName: "aimux-repo", windowId: "@7", windowIndex: 7, windowName: "web" };
    const killWindow = vi.fn();
    upsertTopologyService(
      {
        id: "service-retained",
        label: "web",
        launchCommandLine: "yarn web",
        worktreePath: repoRoot,
        tmuxTarget: target,
      },
      "stopped",
      { projectRoot: repoRoot },
    );
    const host: any = {
      offlineServices: [],
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => [
          {
            target,
            metadata: { kind: "service", sessionId: "service-retained" },
          },
        ]),
        isWindowAlive: vi.fn(() => true),
        killWindow,
      },
      dashboardPendingActions: new DashboardPendingActions(() => {}),
    };

    const changed = loadOfflineServices(host);

    expect(changed).toBe(true);
    expect(killWindow).toHaveBeenCalledWith(target);
    expect(host.offlineServices).toMatchObject([{ id: "service-retained" }]);
    expect(host.offlineServices[0]).not.toHaveProperty("tmuxTarget");
    expect(host.offlineServices[0]).not.toHaveProperty("retained", true);
  });

  it("does not resurrect legacy live snapshots as offline sessions", () => {
    const host: any = {
      sessions: [],
      offlineSessions: [],
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
    const host: any = {
      sessions: [],
      offlineSessions: [],
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

    expect(changed).toBe(false);
    expect(host.offlineSessions[0].backendSessionId).toBeUndefined();
  });

  it("reports offline session changes when only restore blocker state changes", () => {
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
          backendSessionId: "backend-1",
          worktreePath: repoRoot,
        },
      ],
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
        backendSessionId: "backend-1",
        worktreePath: repoRoot,
        restoreBlockedReason: "agent exited during startup",
      },
    ]);

    const changed = loadOfflineTopologySessions(host);

    expect(changed).toBe(true);
    expect(host.offlineSessions[0].restoreBlockedReason).toBe("agent exited during startup");
  });

  it("loads valid live sessions without backend ids as offline when their tmux window is gone", () => {
    const host: any = {
      sessions: [],
      offlineSessions: [],
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
      mode: "dashboard",
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
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
    expect(host.invalidateDesktopStateSnapshot).toHaveBeenCalledOnce();
    expect(host.writeStatuslineFile).toHaveBeenCalledOnce();
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
  });

  it("prunes stale offline cache rows instead of graveyarding without topology authority", () => {
    const host: any = {
      offlineSessions: [{ id: "codex-stale", command: "codex", toolConfigKey: "codex" }],
      mode: "dashboard",
      invalidateDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
      noteLastUsedItem: vi.fn(),
      debug: vi.fn(),
    };

    graveyardSession(host, "codex-stale");

    expect(host.offlineSessions).toEqual([]);
    expect(listTopologySessionStates({ statuses: ["graveyard"] })).toEqual([]);
    expect(host.noteLastUsedItem).not.toHaveBeenCalled();
    expect(host.invalidateDesktopStateSnapshot).toHaveBeenCalledOnce();
    expect(host.writeStatuslineFile).toHaveBeenCalledOnce();
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
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

  it("preserves backend ids when adopting live tmux agent windows after restart", () => {
    seedTopologySessions([
      {
        id: "codex-live",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "live",
        backendSessionId: "backend-live",
        worktreePath: repoRoot,
      },
    ]);
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
              sessionId: "codex-live",
              command: "codex",
              args: [],
              toolConfigKey: "codex",
              worktreePath: repoRoot,
              createdAt: "2026-04-21T00:00:00.000Z",
            },
          },
        ]),
      },
      registerManagedSession: vi.fn((session: any) => host.sessions.push(session)),
      sessionLabels: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
    };

    restoreTmuxSessionsFromTopology(host);

    expect(host.sessions[0].backendSessionId).toBe("backend-live");
    expect(host.syncTmuxWindowMetadata).toHaveBeenCalledWith("codex-live");
  });

  it("rehydrates live tmux windows from the host project root", () => {
    const host: any = {
      projectRoot: repoRoot,
      sessions: [],
      sessionTmuxTargets: new Map(),
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn((projectRoot: string) => {
          expect(projectRoot).toBe(repoRoot);
          return [
            {
              target: {
                sessionName: "aimux-test",
                windowId: "@1",
                windowIndex: 1,
                windowName: "claude",
              },
              metadata: {
                kind: "agent",
                sessionId: "claude-live",
                command: "claude",
                args: [],
                toolConfigKey: "claude",
                worktreePath: repoRoot,
              },
            },
          ];
        }),
      },
      registerManagedSession: vi.fn((session: any) => host.sessions.push(session)),
      sessionLabels: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      updateContextWatcherSessions: vi.fn(),
    };

    restoreTmuxSessionsFromTopology(host);

    expect(host.sessions.map((session: any) => session.id)).toEqual(["claude-live"]);
    expect(host.tmuxRuntimeManager.listProjectManagedWindows).toHaveBeenCalledWith(repoRoot);
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

    upsertTopologyService(saved, "stopped", { projectRoot: repoRoot });

    const changed = loadOfflineServices(host);

    expect(changed).toBe(true);
    expect(host.offlineServices).toMatchObject([saved]);
    expect(buildLiveServiceStates(host)).toEqual([]);
  });
});

describe("reconcileOrphanedTopologySessions", () => {
  let repoRoot = "";

  function seedTopologySessions(sessions: any[]): void {
    saveRuntimeTopologySessions({ sessions, projectRoot: repoRoot });
  }

  function noWindowsHost(overrides: any = {}): any {
    return {
      sessions: [],
      tmuxRuntimeManager: { listProjectManagedWindows: vi.fn(() => []) },
      debug: vi.fn(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-reconcile-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("demotes a crash-orphaned running session to offline so it stays recoverable", () => {
    seedTopologySessions([
      {
        id: "codex-1",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "live",
        backendSessionId: "native-1",
        worktreePath: repoRoot,
      },
    ]);

    const host = noWindowsHost();
    const changed = reconcileOrphanedTopologySessions(host);

    expect(changed).toBe(true);
    expect(listTopologySessionStates({ statuses: ["running", "idle"] })).toEqual([]);
    const offline = listTopologySessionStates({ statuses: ["offline"] });
    expect(offline.map((s) => s.id)).toEqual(["codex-1"]);
    expect(offline[0].backendSessionId).toBe("native-1");
  });

  it("graveyards an orphaned session whose worktree is gone, documenting why", () => {
    const missingWorktree = join(repoRoot, "deleted-worktree");
    seedTopologySessions([
      {
        id: "codex-gone",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "live",
        backendSessionId: "native-gone",
        worktreePath: missingWorktree,
      },
    ]);

    const host = noWindowsHost();
    const changed = reconcileOrphanedTopologySessions(host);

    expect(changed).toBe(true);
    expect(listTopologySessionStates({ statuses: ["running", "idle", "offline"] })).toEqual([]);
    const graveyard = listTopologySessionStates({ statuses: ["graveyard"] });
    expect(graveyard.map((s) => s.id)).toEqual(["codex-gone"]);
    expect(graveyard[0].graveyardReason).toContain(missingWorktree);
    expect(graveyard[0].backendSessionId).toBe("native-gone");
  });

  it("leaves a live agent untouched when its tmux window is still managed", () => {
    seedTopologySessions([
      {
        id: "codex-live",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "live",
        worktreePath: repoRoot,
      },
    ]);

    const host = noWindowsHost({
      tmuxRuntimeManager: {
        listProjectManagedWindows: vi.fn(() => [
          {
            target: { sessionName: "aimux", windowId: "@1", windowIndex: 1, windowName: "codex" },
            metadata: { kind: "agent", sessionId: "codex-live", command: "codex", worktreePath: repoRoot },
          },
        ]),
        isWindowAlive: vi.fn(() => true),
      },
    });

    const changed = reconcileOrphanedTopologySessions(host);

    expect(changed).toBe(false);
    expect(listTopologySessionStates({ statuses: ["running", "idle"] }).map((s) => s.id)).toEqual(["codex-live"]);
  });

  it("does not demote a session that is mid-launch", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setSessionAction("codex-starting", "starting");
    seedTopologySessions([
      {
        id: "codex-starting",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "live",
        worktreePath: repoRoot,
      },
    ]);

    const host = noWindowsHost({ dashboardPendingActions: pending });
    const changed = reconcileOrphanedTopologySessions(host);

    expect(changed).toBe(false);
    expect(listTopologySessionStates({ statuses: ["running", "idle"] }).map((s) => s.id)).toEqual(["codex-starting"]);
  });

  it("demotes a stale starting session without a live tmux window", () => {
    const pending = new DashboardPendingActions(() => {});
    pending.setSessionAction("claude-starting", "starting");
    upsertTopologySession(
      {
        id: "claude-starting",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        lifecycle: "live",
        backendSessionId: "backend-1",
        worktreePath: repoRoot,
      },
      "starting",
      { projectRoot: repoRoot, now: new Date(Date.now() - 10_000).toISOString() },
    );

    const host = noWindowsHost({ dashboardPendingActions: pending, projectRoot: repoRoot });
    const changed = reconcileOrphanedTopologySessions(host);

    expect(changed).toBe(true);
    expect(listTopologySessionStates({ statuses: ["starting"] })).toEqual([]);
    const offline = listTopologySessionStates({ statuses: ["offline"] });
    expect(offline).toMatchObject([
      {
        id: "claude-starting",
        backendSessionId: "backend-1",
        restoreBlockedReason: "agent did not stay alive during startup",
      },
    ]);
  });
});
