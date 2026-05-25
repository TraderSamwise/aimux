import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "../paths.js";
import { saveRuntimeTopologySessions } from "../runtime-core/topology-sessions.js";

function gitInit(cwd: string): void {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  execFileSync("git", ["init"], { cwd, stdio: "ignore", env });
}
import {
  createSession,
  focusSession,
  migrateAgent,
  resumeSessions,
  runDashboard,
  runProjectService,
  summarizeLaunchArgs,
} from "./session-launch.js";
import { loadMetadataState, updateSessionMetadata } from "../metadata-store.js";

describe("createSession", () => {
  it("redacts sensitive launch arg values in debug summaries", () => {
    expect(
      summarizeLaunchArgs([
        "--api-key",
        "sk-real-secret",
        "--model",
        "gpt-5",
        "--auth-token=real-token",
        "OPENAI_API_KEY=real-key",
        "PATH=/usr/bin",
      ]),
    ).toEqual([
      "--api-key",
      "<redacted>",
      "--model",
      "gpt-5",
      "--auth-token=<redacted>",
      "OPENAI_API_KEY=<redacted>",
      "PATH=/usr/bin",
    ]);
  });

  it("does not inject startup preamble when explicitly suppressed", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-"));
    gitInit(repoRoot);
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
    gitInit(repoRoot);
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
    gitInit(repoRoot);
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
    gitInit(repoRoot);
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
    gitInit(repoRoot);
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

  it("stores explicit Codex resume backend ids instead of waiting for file capture", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-codex-resume-"));
    gitInit(repoRoot);
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

    const session = createSession(
      host,
      "codex",
      ["--dangerously-bypass-approvals-and-sandbox", "resume", "019e4837-66d5-7ab2-9bf6-bff1f958ecae"],
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
    );

    expect(session.backendSessionId).toBe("019e4837-66d5-7ab2-9bf6-bff1f958ecae");
    expect(host.sessionBootstrap.deliverDetachedCodexKickoffPrompt).not.toHaveBeenCalled();

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("does not append initial Codex instructions after an explicit -- prompt delimiter", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-codex-delimiter-"));
    gitInit(repoRoot);
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
    gitInit(repoRoot);
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
    gitInit(repoRoot);
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

  it("passes teammate metadata into managed session registration", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-team-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);
    const team = {
      teamId: "team-1",
      parentSessionId: "parent-1",
      role: "reviewer",
    };

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
      [],
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
      undefined,
      "codex-team",
      false,
      true,
      team,
    );

    expect(host.registerManagedSession).toHaveBeenCalledWith(
      expect.anything(),
      [],
      "codex",
      repoRoot,
      undefined,
      expect.any(Number),
      team,
    );

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("sends Codex teammate preambles through the initial kickoff prompt", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-codex-team-preamble-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);
    const team = {
      teamId: "team-1",
      parentSessionId: "parent-1",
      role: "reviewer",
    };

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => "aimux teammate preamble"),
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
      "You are the reviewer teammate.",
      undefined,
      repoRoot,
      undefined,
      "codex-team",
      false,
      false,
      team,
    );

    expect(host.sessionBootstrap.buildSessionPreamble).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "codex-team",
        extraPreamble: "You are the reviewer teammate.",
        team,
      }),
    );
    expect(host.sessionBootstrap.buildInitialKickoffPrompt).toHaveBeenCalledWith(
      "codex-team",
      "aimux teammate preamble",
    );
    const launched = (host.tmuxRuntimeManager.createWindow.mock.calls[0][4] as string[]).join(" ");
    expect(launched).toContain("codex startup instructions");

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("rejects duplicate session ids before launching a second runtime", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-dup-"));
    gitInit(repoRoot);
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

describe("migrateAgent", () => {
  it("does not use durable backend metadata when migrating a runtime that missed its backend id", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-migrate-"));
    const targetRoot = mkdtempSync(join(tmpdir(), "aimux-session-migrate-target-"));
    gitInit(repoRoot);
    gitInit(targetRoot);
    await initPaths(repoRoot);

    const sessions: any[] = [];
    const sourceSession: any = {
      id: "codex-1",
      command: "codex",
      exited: false,
      team: { teamId: "team-1", parentSessionId: "parent-1", role: "reviewer" },
      kill: vi.fn(() => {
        sourceSession.exited = true;
        const index = sessions.indexOf(sourceSession);
        if (index >= 0) sessions.splice(index, 1);
      }),
      onExit: vi.fn(),
    };
    sessions.push(sourceSession);

    const host: any = {
      sessions,
      sessionToolKeys: new Map([["codex-1", "codex"]]),
      sessionOriginalArgs: new Map([["codex-1", ["--dangerously-bypass-approvals-and-sandbox"]]]),
      sessionWorktreePaths: new Map([["codex-1", repoRoot]]),
      sessionTmuxTargets: new Map(),
      contextWatcher: { syncNow: vi.fn(async () => undefined) },
      sessionBootstrap: {
        canResumeWithBackendSessionId: vi.fn(() => false),
        composeToolArgs: vi.fn((_toolCfg, resumeArgs: string[], originalArgs: string[]) => [
          ...originalArgs,
          ...resumeArgs,
        ]),
        readForkSourceSnapshot: vi.fn(() => ({ historyText: "", liveText: "" })),
        buildCodexMigrationKickoffPrompt: vi.fn(() => "kickoff"),
        deliverDetachedCodexKickoffPrompt: vi.fn(async () => undefined),
        buildSessionPreamble: vi.fn(() => ""),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
        buildInitialKickoffPrompt: vi.fn(),
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-test" })),
        createWindow: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        getTargetByWindowId: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "codex" })),
        isWindowAlive: vi.fn(() => true),
      },
      syncTmuxWindowMetadata: vi.fn(),
      registerManagedSession: vi.fn((session: any) => sessions.push(session)),
      getSessionLabel: vi.fn(() => "codex"),
      startedInDashboard: false,
      mode: "session",
      saveState: vi.fn(),
      activeIndex: 0,
    };

    await migrateAgent(host, "codex-1", targetRoot);

    expect(host.sessionBootstrap.canResumeWithBackendSessionId).toHaveBeenCalledWith(
      expect.objectContaining({ command: "codex" }),
      undefined,
    );
    expect(host.sessionBootstrap.composeToolArgs).not.toHaveBeenCalled();
    expect(sessions.find((session) => session.id === "codex-1")?.backendSessionId).toBeUndefined();
    expect(host.tmuxRuntimeManager.createWindow.mock.calls[0][2]).toBe(targetRoot);
    expect(host.registerManagedSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      "codex",
      targetRoot,
      undefined,
      expect.any(Number),
      sourceSession.team,
    );

    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  });
});

describe("focusSession", () => {
  it("does not use durable backend metadata when opening a session that missed its backend id", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-focus-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);

    const host: any = {
      sessions: [{ id: "claude-1" }],
      activeIndex: 0,
      sessionMRU: [],
      agentTracker: { markSeen: vi.fn() },
      noteLastUsedItem: vi.fn(),
      syncTuiNotificationContext: vi.fn(),
      sessionTmuxTargets: new Map(),
      tmuxRuntimeManager: { getTargetByWindowId: vi.fn() },
      openLiveTmuxWindowForEntry: vi.fn(() => "opened"),
      saveState: vi.fn(),
    };

    focusSession(host, 0);

    expect(host.openLiveTmuxWindowForEntry).toHaveBeenCalledWith({
      id: "claude-1",
      backendSessionId: undefined,
    });
    expect(host.saveState).toHaveBeenCalledOnce();

    rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe("resumeSessions", () => {
  it("does not use display metadata when saved resume state is incomplete", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-resume-metadata-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "codex-1",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: ["--dangerously-bypass-approvals-and-sandbox"],
          lifecycle: "offline",
          worktreePath: repoRoot,
        },
      ],
      projectRoot: repoRoot,
    });

    class Host {
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

    expect(host.sessionBootstrap.canResumeWithBackendSessionId).not.toHaveBeenCalled();
    expect(host.createSession).not.toHaveBeenCalled();
    expect(host.openTmuxDashboardTarget).toHaveBeenCalledOnce();

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("preserves teammate metadata and session id when resuming saved teammate sessions", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-resume-team-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);
    const team = { teamId: "team-1", parentSessionId: "claude-parent", role: "reviewer" };
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "codex-team",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-team",
          team,
          worktreePath: repoRoot,
        },
      ],
      projectRoot: repoRoot,
    });

    class Host {
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

    expect(host.createSession).toHaveBeenCalledWith(
      "codex",
      expect.arrayContaining(["resume", "backend-team"]),
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
      "backend-team",
      "codex-team",
      false,
      true,
      team,
    );

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("skips saved sessions without exact backend resume args instead of using broad fallback args", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-resume-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "codex-1",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: ["--dangerously-bypass-approvals-and-sandbox"],
          lifecycle: "offline",
          worktreePath: repoRoot,
        },
      ],
      projectRoot: repoRoot,
    });

    class Host {
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
  it("starts without legacy dispatchers", async () => {
    const resolveRun = vi.fn();
    const host: any = {
      mode: "dashboard",
      syncSessionsFromTopology: vi.fn(),
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
      syncSessionsFromTopology: vi.fn(),
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
