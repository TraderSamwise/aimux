import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "../paths.js";
import { createSession, resumeSessions, runDashboard, runProjectService } from "./session-launch.js";
import { loadMetadataState, recordSessionBackendSessionIdMetadata, updateSessionMetadata } from "../metadata-store.js";

describe("createSession", () => {
  it("does not inject startup preamble when explicitly suppressed", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    const buildSessionPreamble = vi.fn(() => "aimux preamble");
    const deliverDetachedCodexKickoffPrompt = vi.fn();
    const sessions: any[] = [];
    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble,
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
        buildInitialKickoffPrompt: vi.fn(() => "kickoff"),
        deliverDetachedCodexKickoffPrompt,
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-test" })),
        createWindow: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        getTargetByWindowId: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        isWindowAlive: vi.fn(() => true),
      },
      sessionTmuxTargets: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      registerManagedSession: vi.fn((session: any) => sessions.push(session)),
      sessions,
      getSessionLabel: vi.fn(),
      startedInDashboard: false,
      mode: "session",
      saveState: vi.fn(),
      activeIndex: 0,
    };

    const session = createSession(
      host,
      "codex",
      [],
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
      "backend-session",
      "codex-1",
      false,
      true,
    );

    expect(buildSessionPreamble).not.toHaveBeenCalled();
    expect(host.sessionBootstrap.buildInitialKickoffPrompt).not.toHaveBeenCalled();
    expect(deliverDetachedCodexKickoffPrompt).not.toHaveBeenCalled();

    session.destroy();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("wraps claude launches through the managed env boundary", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-claude-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => ""),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
        buildInitialKickoffPrompt: vi.fn(),
        deliverDetachedCodexKickoffPrompt: vi.fn(),
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-test" })),
        createWindow: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "claude" })),
        getTargetByWindowId: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "claude" })),
        isWindowAlive: vi.fn(() => true),
      },
      sessionTmuxTargets: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      registerManagedSession: vi.fn(),
      sessions: [],
      getSessionLabel: vi.fn(),
      startedInDashboard: false,
      mode: "session",
      saveState: vi.fn(),
      activeIndex: 0,
    };

    createSession(host, "claude", [], undefined, "claude", undefined, undefined, repoRoot);

    const createWindowArgs = host.tmuxRuntimeManager.createWindow.mock.calls[0];
    expect(createWindowArgs[3]).toBe("env");
    expect(createWindowArgs[4][0]).toBe("-i");
    expect(createWindowArgs[4].join(" ")).toContain("AIMUX_SESSION_ID=claude-");
    expect(createWindowArgs[4].join(" ")).toContain("AIMUX_TOOL=claude");
    expect(createWindowArgs[4]).toContain("claude");

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("stores explicit Claude resume backend ids without adding a competing session id", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-claude-resume-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => ""),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
        buildInitialKickoffPrompt: vi.fn(),
        deliverDetachedCodexKickoffPrompt: vi.fn(),
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-test" })),
        createWindow: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "claude" })),
        getTargetByWindowId: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "claude" })),
        isWindowAlive: vi.fn(() => true),
      },
      sessionTmuxTargets: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      registerManagedSession: vi.fn(),
      sessions: [],
      getSessionLabel: vi.fn(),
      startedInDashboard: false,
      mode: "session",
      saveState: vi.fn(),
      activeIndex: 0,
    };

    const session = createSession(
      host,
      "claude",
      ["--dangerously-skip-permissions", "--resume", "backend-123"],
      undefined,
      "claude",
      undefined,
      undefined,
      repoRoot,
    );

    const createWindowArgs = host.tmuxRuntimeManager.createWindow.mock.calls[0];
    expect(session.backendSessionId).toBe("backend-123");
    expect(createWindowArgs[4]).toContain("--resume");
    expect(createWindowArgs[4]).toContain("backend-123");
    expect(createWindowArgs[4]).not.toContain("--session-id");

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("passes fresh Codex aimux instructions as the initial prompt", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-codex-prompt-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => "aimux preamble"),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
        buildInitialKickoffPrompt: vi.fn(() => "codex startup instructions"),
        deliverDetachedCodexKickoffPrompt: vi.fn(),
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-test" })),
        createWindow: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        getTargetByWindowId: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        isWindowAlive: vi.fn(() => true),
      },
      sessionTmuxTargets: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      registerManagedSession: vi.fn(),
      sessions: [],
      getSessionLabel: vi.fn(),
      startedInDashboard: false,
      mode: "session",
      saveState: vi.fn(),
      activeIndex: 0,
    };

    createSession(
      host,
      "codex",
      ["--dangerously-bypass-approvals-and-sandbox"],
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
    );

    const createWindowArgs = host.tmuxRuntimeManager.createWindow.mock.calls[0];
    const launched = (createWindowArgs[4] as string[]).join(" ");
    expect(launched).toContain("codex startup instructions");
    expect(host.sessionBootstrap.deliverDetachedCodexKickoffPrompt).not.toHaveBeenCalled();

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("does not append initial Codex instructions to explicit Codex subcommands", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-codex-subcommand-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => "aimux preamble"),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
        buildInitialKickoffPrompt: vi.fn(() => "codex startup instructions"),
        deliverDetachedCodexKickoffPrompt: vi.fn(),
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-test" })),
        createWindow: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        getTargetByWindowId: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        isWindowAlive: vi.fn(() => true),
      },
      sessionTmuxTargets: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      registerManagedSession: vi.fn(),
      sessions: [],
      getSessionLabel: vi.fn(),
      startedInDashboard: false,
      mode: "session",
      saveState: vi.fn(),
      activeIndex: 0,
    };

    createSession(
      host,
      "codex",
      ["--dangerously-bypass-approvals-and-sandbox", "resume", "abc"],
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
    );

    const createWindowArgs = host.tmuxRuntimeManager.createWindow.mock.calls[0];
    const launched = (createWindowArgs[4] as string[]).join(" ");
    expect(launched).toContain("resume");
    expect(launched).not.toContain("codex startup instructions");
    expect(host.sessionBootstrap.deliverDetachedCodexKickoffPrompt).not.toHaveBeenCalled();

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("does not append initial Codex instructions after an explicit -- prompt delimiter", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-codex-delimiter-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => "aimux preamble"),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
        buildInitialKickoffPrompt: vi.fn(() => "codex startup instructions"),
        deliverDetachedCodexKickoffPrompt: vi.fn(),
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-test" })),
        createWindow: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        getTargetByWindowId: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        isWindowAlive: vi.fn(() => true),
      },
      sessionTmuxTargets: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      registerManagedSession: vi.fn(),
      sessions: [],
      getSessionLabel: vi.fn(),
      startedInDashboard: false,
      mode: "session",
      saveState: vi.fn(),
      activeIndex: 0,
    };

    createSession(
      host,
      "codex",
      ["--dangerously-bypass-approvals-and-sandbox", "--", "Explain this codebase"],
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
    );

    const createWindowArgs = host.tmuxRuntimeManager.createWindow.mock.calls[0];
    const launched = (createWindowArgs[4] as string[]).join(" ");
    expect(launched).toContain("Explain this codebase");
    expect(launched).not.toContain("codex startup instructions");
    expect(host.sessionBootstrap.deliverDetachedCodexKickoffPrompt).not.toHaveBeenCalled();

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("adds aimux preamble but not session id args to claude resume launches", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-claude-resume-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => "aimux preamble"),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
        buildInitialKickoffPrompt: vi.fn(),
        deliverDetachedCodexKickoffPrompt: vi.fn(),
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-test" })),
        createWindow: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "claude" })),
        getTargetByWindowId: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "claude" })),
        isWindowAlive: vi.fn(() => true),
      },
      sessionTmuxTargets: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      registerManagedSession: vi.fn(),
      sessions: [],
      getSessionLabel: vi.fn(),
      startedInDashboard: false,
      mode: "session",
      saveState: vi.fn(),
      activeIndex: 0,
    };

    createSession(
      host,
      "claude",
      ["--dangerously-skip-permissions", "--resume"],
      ["--append-system-prompt"],
      "claude",
      undefined,
      ["--session-id", "{sessionId}"],
      repoRoot,
    );

    const createWindowArgs = host.tmuxRuntimeManager.createWindow.mock.calls[0];
    const launchedArgs = createWindowArgs[4] as string[];
    expect(host.sessionBootstrap.buildSessionPreamble).toHaveBeenCalled();
    expect(host.sessionBootstrap.finalizePreamble).toHaveBeenCalled();
    expect(launchedArgs).toContain("--resume");
    expect(launchedArgs).toContain("--append-system-prompt");
    expect(launchedArgs).not.toContain("--session-id");

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("clears stale native transcript paths when launching a new process for a session", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-transcript-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    updateSessionMetadata(
      "claude-restore",
      (current) => ({
        ...current,
        context: {
          cwd: repoRoot,
          transcriptPath: "/tmp/old-claude-transcript.jsonl",
        },
      }),
      repoRoot,
    );

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => ""),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
        buildInitialKickoffPrompt: vi.fn(),
        deliverDetachedCodexKickoffPrompt: vi.fn(),
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-test" })),
        createWindow: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "claude" })),
        getTargetByWindowId: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "claude" })),
        isWindowAlive: vi.fn(() => true),
      },
      sessionTmuxTargets: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      registerManagedSession: vi.fn(),
      sessions: [],
      getSessionLabel: vi.fn(),
      startedInDashboard: false,
      mode: "session",
      saveState: vi.fn(),
      activeIndex: 0,
    };

    createSession(
      host,
      "claude",
      ["--dangerously-skip-permissions", "--resume"],
      ["--append-system-prompt"],
      "claude",
      undefined,
      ["--session-id", "{sessionId}"],
      repoRoot,
      "backend-session",
      "claude-restore",
      false,
      true,
    );

    const context = loadMetadataState(repoRoot).sessions["claude-restore"]?.context;
    expect(context?.cwd).toBe(repoRoot);
    expect(context?.transcriptPath).toBeUndefined();

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("rejects duplicate session ids before launching a second runtime", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-dup-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => ""),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
        buildInitialKickoffPrompt: vi.fn(),
        deliverDetachedCodexKickoffPrompt: vi.fn(),
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(),
        createWindow: vi.fn(),
        getTargetByWindowId: vi.fn(),
        isWindowAlive: vi.fn(),
      },
      sessionTmuxTargets: new Map(),
      syncTmuxWindowMetadata: vi.fn(),
      registerManagedSession: vi.fn(),
      sessions: [{ id: "claude-dup123" }],
      getSessionLabel: vi.fn(),
      startedInDashboard: false,
      mode: "session",
      saveState: vi.fn(),
      activeIndex: 0,
    };

    expect(() =>
      createSession(
        host,
        "claude",
        [],
        undefined,
        "claude",
        undefined,
        undefined,
        repoRoot,
        undefined,
        "claude-dup123",
      ),
    ).toThrow('Session "claude-dup123" already exists');

    expect(host.tmuxRuntimeManager.createWindow).not.toHaveBeenCalled();
    rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe("resumeSessions", () => {
  it("uses durable backend metadata when saved resume state is incomplete", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-resume-metadata-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);
    recordSessionBackendSessionIdMetadata("codex-1", "native-session", repoRoot);

    class Host {
      static loadState() {
        return {
          sessions: [
            {
              id: "codex-1",
              command: "codex",
              toolConfigKey: "codex",
              args: ["--dangerously-bypass-approvals-and-sandbox"],
              worktreePath: repoRoot,
            },
          ],
        };
      }

      instanceId = "inst-1";
      instanceDirectory = { registerInstance: vi.fn(async () => undefined) };
      startHeartbeat = vi.fn();
      getRemoteOwnedSessionKeys = vi.fn(() => new Set());
      sessionBootstrap = {
        canResumeWithBackendSessionId: vi.fn(() => true),
        composeToolArgs: vi.fn((_toolCfg, resumeArgs: string[], originalArgs: string[]) => [
          ...originalArgs,
          ...resumeArgs,
        ]),
      };
      createSession = vi.fn();
      openTmuxDashboardTarget = vi.fn();
      runDashboard = vi.fn();
    }

    const host = new Host();

    await expect(resumeSessions(host as any)).resolves.toBe(0);

    expect(host.sessionBootstrap.canResumeWithBackendSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ command: "codex" }),
      "native-session",
    );
    expect(host.createSession).toHaveBeenCalledWith(
      "codex",
      expect.arrayContaining(["resume", "native-session"]),
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
      "native-session",
      undefined,
      false,
      true,
    );
    expect(host.openTmuxDashboardTarget).toHaveBeenCalledOnce();

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("skips saved sessions without exact backend resume args instead of using broad fallback args", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-resume-"));
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    await initPaths(repoRoot);

    class Host {
      static loadState() {
        return {
          sessions: [
            {
              id: "codex-1",
              command: "codex",
              toolConfigKey: "codex",
              args: ["--dangerously-bypass-approvals-and-sandbox"],
              worktreePath: repoRoot,
            },
          ],
        };
      }

      instanceId = "inst-1";
      instanceDirectory = { registerInstance: vi.fn(async () => undefined) };
      startHeartbeat = vi.fn();
      getRemoteOwnedSessionKeys = vi.fn(() => new Set());
      sessionBootstrap = {
        canResumeWithBackendSessionId: vi.fn(() => false),
        composeToolArgs: vi.fn(),
      };
      createSession = vi.fn();
      openTmuxDashboardTarget = vi.fn();
      runDashboard = vi.fn();
    }

    const host = new Host();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(resumeSessions(host as any)).resolves.toBe(0);

    expect(host.createSession).not.toHaveBeenCalled();
    expect(host.sessionBootstrap.composeToolArgs).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      'Skipping saved session "codex-1" because "codex" has no exact resumable backend session id.',
    );
    expect(host.openTmuxDashboardTarget).toHaveBeenCalledOnce();

    error.mockRestore();
    rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe("runProjectService", () => {
  it("starts the dispatcher refresh loop", async () => {
    const resolveRun = vi.fn();
    const host: any = {
      mode: "dashboard",
      syncSessionsFromState: vi.fn(),
      createTaskDispatcher: vi.fn(() => ({ tick: vi.fn(), drainEvents: vi.fn(() => []) })),
      createOrchestrationDispatcher: vi.fn(() => ({ tick: vi.fn(), drainEvents: vi.fn(() => []) })),
      writeInstructionFiles: vi.fn(),
      startProjectServices: vi.fn(),
      startStatusRefresh: vi.fn(() => resolveRun(0)),
      refreshDesktopStateSnapshot: vi.fn(),
      writeStatuslineFile: vi.fn(),
      teardown: vi.fn(),
      resolveRun: undefined,
    };

    const runPromise = runProjectService(host);
    await vi.waitFor(() => expect(host.resolveRun).toBeTypeOf("function"));
    host.resolveRun(0);
    await expect(runPromise).resolves.toBe(0);

    expect(host.mode).toBe("project-service");
    expect(host.startStatusRefresh).toHaveBeenCalledOnce();
  });
});

describe("runDashboard", () => {
  it("hydrates restored subscreens and syncs footer state on initial startup", async () => {
    const host: any = {
      instanceId: "inst-1",
      instanceDirectory: { registerInstance: vi.fn(async () => undefined) },
      startHeartbeat: vi.fn(),
      startedInDashboard: false,
      mode: "session",
      syncSessionsFromState: vi.fn(),
      writeInstructionFiles: vi.fn(),
      terminalHost: {
        enterRawMode: vi.fn(),
        enterAlternateScreen: vi.fn(),
      },
      isFocusInReport: vi.fn(() => false),
      handleActiveDashboardOverlayKey: vi.fn(() => false),
      isDashboardScreen: vi.fn(() => false),
      handleDashboardKey: vi.fn(),
      getViewportKey: vi.fn(() => "120x40"),
      invalidateDashboardFrame: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
      renderDashboard: vi.fn(),
      loadDashboardUiState: vi.fn(function (this: any) {
        this.dashboardState.screen = "graveyard";
      }),
      hydrateDashboardScreenState: vi.fn(),
      writeDashboardClientStatuslineFile: vi.fn(),
      dashboardState: { screen: "dashboard" },
      refreshDashboardModelFromService: vi.fn(async () => true),
      refreshLocalDashboardModel: vi.fn(),
      ensureDashboardControlPlane: vi.fn(async () => undefined),
      startStatusRefresh: vi.fn(),
      teardown: vi.fn(),
      resolveRun: undefined,
      defaultCommand: undefined,
      defaultArgs: undefined,
    };

    const runPromise = runDashboard(host);
    await vi.waitFor(() => expect(host.resolveRun).toBeTypeOf("function"));
    host.resolveRun(0);
    await expect(runPromise).resolves.toBe(0);

    expect(host.renderCurrentDashboardView).toHaveBeenCalled();
    expect(host.renderDashboard).not.toHaveBeenCalled();
    expect(host.hydrateDashboardScreenState).toHaveBeenCalledOnce();
    expect(host.writeDashboardClientStatuslineFile).toHaveBeenCalledOnce();
  });
});
