import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  injectCodexDeveloperInstructions,
  migrateAgent,
  resumeSessions,
  restoreSessions,
  runDashboard,
  runProjectService,
  summarizeLaunchArgs,
} from "./session-launch.js";
import { loadMetadataState, updateSessionMetadata } from "../metadata-store.js";

describe("createSession", () => {
  it("inserts Codex developer instructions before subcommands", () => {
    expect(
      injectCodexDeveloperInstructions(["--model", "gpt-5", "resume", "abc"], "developer_instructions", "stand"),
    ).toEqual(["--model", "gpt-5", "-c", 'developer_instructions="stand"', "resume", "abc"]);
    expect(
      injectCodexDeveloperInstructions(
        ["--dangerously-bypass-approvals-and-sandbox", "--", "Explain"],
        "developer_instructions",
        "stand",
      ),
    ).toEqual(["--dangerously-bypass-approvals-and-sandbox", "-c", 'developer_instructions="stand"', "--", "Explain"]);
  });

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
    const sessions: any[] = [];
    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble,
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
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

  it("wraps custom claude tool configs through the managed env boundary", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-custom-claude-"));
    gitInit(repoRoot);
    const claudeBin = join(repoRoot, "bin", "claude");
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux/config.json"),
      JSON.stringify(
        {
          tools: {
            "claude-custom": {
              command: claudeBin,
              args: [],
              enabled: true,
              wrapperEnabled: true,
              preambleFlag: ["--append-system-prompt"],
              sessionIdFlag: ["--session-id", "{sessionId}"],
              resumeArgs: ["--resume", "{sessionId}"],
              resumeByBackendSessionId: true,
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => ""),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
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

    createSession(host, claudeBin, [], undefined, "claude-custom", undefined, undefined, repoRoot);

    const createWindowArgs = host.tmuxRuntimeManager.createWindow.mock.calls[0];
    expect(createWindowArgs[3]).toBe("env");
    expect(createWindowArgs[4].join(" ")).toContain("AIMUX_SESSION_ID=claude-");
    expect(createWindowArgs[4].join(" ")).toContain("AIMUX_TOOL=claude-custom");
    expect(createWindowArgs[4]).toContain(claudeBin);

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("wraps custom codex tool configs through the managed env boundary", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-custom-codex-"));
    gitInit(repoRoot);
    const codexBin = join(repoRoot, "bin", "codex");
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux/config.json"),
      JSON.stringify(
        {
          tools: {
            "codex-gpt5": {
              command: codexBin,
              args: [],
              enabled: true,
              resumeArgs: ["resume", "{sessionId}"],
              resumeByBackendSessionId: true,
              developerInstructionsConfigKey: "developer_instructions",
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => ""),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
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

    createSession(host, codexBin, [], undefined, "codex-gpt5", undefined, undefined, repoRoot);

    const createWindowArgs = host.tmuxRuntimeManager.createWindow.mock.calls[0];
    expect(createWindowArgs[3]).toBe("env");
    expect(createWindowArgs[4].join(" ")).toContain("AIMUX_SESSION_ID=codex-");
    expect(createWindowArgs[4].join(" ")).toContain("AIMUX_PROJECT_ROOT=");
    expect(createWindowArgs[4].join(" ")).toContain("AIMUX_TOOL=codex-gpt5");
    expect(createWindowArgs[4]).toContain(codexBin);

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("assigns, passes, and persists a backend session id for a fresh claude launch", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-claude-fresh-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => ""),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
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

    // The spawn path passes toolConfig.sessionIdFlag (session-launch.ts ~144);
    // mirror that here so the test exercises the real proactive-capture chain.
    const session: any = createSession(
      host,
      "claude",
      [],
      undefined,
      "claude",
      undefined,
      ["--session-id", "{sessionId}"],
      repoRoot,
    );

    // A backend id is generated and bound at spawn, never left to be discovered.
    expect(session.backendSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // It is passed to claude as --session-id so claude adopts that exact id.
    const cmd: string[] = host.tmuxRuntimeManager.createWindow.mock.calls[0][4];
    const flagIdx = cmd.indexOf("--session-id");
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[flagIdx + 1]).toBe(session.backendSessionId);
    // And persisted durably as part of the spawn (saveState -> topology).
    expect(host.saveState).toHaveBeenCalled();

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("applies launchEnv but skips session-id/preamble flags when the binary is overridden", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-override-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => "PREAMBLE"),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
      },
      tmuxRuntimeManager: {
        ensureProjectSession: vi.fn(() => ({ sessionName: "aimux-test" })),
        createWindow: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "bash" })),
        getTargetByWindowId: vi.fn(() => ({ sessionName: "aimux-test", windowId: "@1", windowName: "bash" })),
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

    // toolConfigKey "claude" but command "bash" — a user-overridden binary.
    const session: any = createSession(
      host,
      "bash",
      ["--login"],
      ["--append-system-prompt"],
      "claude",
      undefined,
      ["--session-id", "{sessionId}"],
      repoRoot,
      undefined,
      undefined,
      false,
      false,
      undefined,
      { CLAUDE_YOLO: "1" },
    );

    const createWindowArgs = host.tmuxRuntimeManager.createWindow.mock.calls[0];
    const cmd: string[] = createWindowArgs[4];
    expect(createWindowArgs[3]).toBe("env");
    expect(cmd[0]).toBe("-i");
    // Env override is applied even for an arbitrary binary.
    expect(cmd.join(" ")).toContain("CLAUDE_YOLO=1");
    expect(cmd).toContain("bash");
    // But no aimux hooks: no session-id flag, no injected preamble, no tracking env, no backend id.
    expect(cmd).not.toContain("--session-id");
    expect(cmd).not.toContain("--append-system-prompt");
    expect(cmd.join(" ")).not.toContain("AIMUX_SESSION_ID=");
    expect(session.backendSessionId).toBeUndefined();

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

  it("passes fresh Codex aimux instructions through developer_instructions config", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-codex-prompt-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => "aimux preamble"),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
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
    expect(launched).toContain("-c");
    expect(launched).toContain("developer_instructions=");
    expect(launched).toContain("aimux preamble");
    expect(launched).not.toContain("codex startup instructions");

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("does not resurrect prompt injection when Codex developer instructions are disabled", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-codex-file-fallback-"));
    gitInit(repoRoot);
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux/config.json"),
      JSON.stringify({ tools: { codex: { developerInstructionsConfigKey: null } } }, null, 2) + "\n",
    );
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => "aimux preamble"),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
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

    const launched = (host.tmuxRuntimeManager.createWindow.mock.calls[0][4] as string[]).join(" ");
    expect(launched).not.toContain("developer_instructions=");
    expect(launched).not.toContain("aimux preamble");
    expect(host.sessionBootstrap.buildSessionPreamble).toHaveBeenCalled();

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("keeps Codex developer instructions before explicit Codex subcommands", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-codex-subcommand-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);

    const host: any = {
      sessionBootstrap: {
        buildSessionPreamble: vi.fn(() => "aimux preamble"),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
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
    expect(launched).toContain("developer_instructions=");
    expect(launched).toContain("aimux preamble");
    expect(launched).not.toContain("codex startup instructions");

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

  it("sends Codex teammate preambles through developer_instructions config", async () => {
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
    const launched = (host.tmuxRuntimeManager.createWindow.mock.calls[0][4] as string[]).join(" ");
    expect(launched).toContain("developer_instructions=");
    expect(launched).toContain("aimux teammate preamble");
    expect(launched).not.toContain("codex startup instructions");

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
        buildCodexMigrationContinuityPreamble: vi.fn(() => "continuity preamble"),
        buildSessionPreamble: vi.fn(() => ""),
        ensurePlanFile: vi.fn(),
        finalizePreamble: vi.fn(),
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
    expect(host.sessionBootstrap.buildCodexMigrationContinuityPreamble).toHaveBeenCalledWith(
      "codex-1",
      repoRoot,
      targetRoot,
      expect.objectContaining({ historyText: "", liveText: "" }),
    );
    expect(host.sessionBootstrap.buildSessionPreamble).toHaveBeenCalledWith(
      expect.objectContaining({ extraPreamble: "continuity preamble" }),
    );
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
    vi.useFakeTimers();
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-focus-"));
    try {
      gitInit(repoRoot);
      await initPaths(repoRoot);

      const host: any = {
        sessions: [{ id: "claude-1" }],
        activeIndex: 0,
        sessionMRU: [],
        agentTracker: { markSeen: vi.fn() },
        noteLastUsedItem: vi.fn(),
        sessionTmuxTargets: new Map(),
        tmuxRuntimeManager: { getTargetByWindowId: vi.fn() },
        openLiveTmuxWindowForEntry: vi.fn(() => "opened"),
        postToProjectService: vi.fn(async () => ({ ok: true })),
        saveState: vi.fn(),
      };

      focusSession(host, 0);
      await vi.runOnlyPendingTimersAsync();

      expect(host.openLiveTmuxWindowForEntry).toHaveBeenCalledWith({
        id: "claude-1",
        backendSessionId: undefined,
      });
      expect(host.saveState).toHaveBeenCalledOnce();
      expect(host.postToProjectService).toHaveBeenNthCalledWith(1, "/notification-context", {
        source: "tui",
        focused: true,
        screen: "agent",
        sessionId: "claude-1",
        panelOpen: false,
      });
      expect(host.postToProjectService).toHaveBeenNthCalledWith(2, "/mark-seen", { session: "claude-1" });
    } finally {
      vi.useRealTimers();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps existing tmux targets focused as agent context", async () => {
    vi.useFakeTimers();
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-focus-existing-"));
    try {
      gitInit(repoRoot);
      await initPaths(repoRoot);

      const target = { sessionName: "aimux-test", windowId: "@1", windowName: "claude" };
      const host: any = {
        sessions: [{ id: "claude-1" }],
        activeIndex: 0,
        sessionMRU: [],
        agentTracker: { markSeen: vi.fn() },
        noteLastUsedItem: vi.fn(),
        sessionTmuxTargets: new Map([["claude-1", target]]),
        tmuxRuntimeManager: { getTargetByWindowId: vi.fn(() => target) },
        selectLinkedOrOpenTarget: vi.fn(),
        openLiveTmuxWindowForEntry: vi.fn(),
        postToProjectService: vi.fn(async () => ({ ok: true })),
        saveState: vi.fn(),
      };

      focusSession(host, 0);
      await vi.runOnlyPendingTimersAsync();

      expect(host.tmuxRuntimeManager.getTargetByWindowId).toHaveBeenCalledWith("aimux-test", "@1");
      expect(host.selectLinkedOrOpenTarget).toHaveBeenCalledWith(target);
      expect(host.openLiveTmuxWindowForEntry).not.toHaveBeenCalled();
      expect(host.saveState).toHaveBeenCalledOnce();
      expect(host.postToProjectService).toHaveBeenNthCalledWith(1, "/notification-context", {
        source: "tui",
        focused: true,
        screen: "agent",
        sessionId: "claude-1",
        panelOpen: false,
      });
      expect(host.postToProjectService).toHaveBeenNthCalledWith(2, "/mark-seen", { session: "claude-1" });
    } finally {
      vi.useRealTimers();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not mark stale failed targets as focused or seen", async () => {
    vi.useFakeTimers();
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-focus-stale-"));
    try {
      gitInit(repoRoot);
      await initPaths(repoRoot);

      const staleTarget = { sessionName: "aimux-test", windowId: "@2", windowName: "claude" };
      const host: any = {
        sessions: [{ id: "claude-1" }],
        activeIndex: 0,
        sessionMRU: [],
        agentTracker: { markSeen: vi.fn() },
        noteLastUsedItem: vi.fn(),
        sessionTmuxTargets: new Map([["claude-1", staleTarget]]),
        tmuxRuntimeManager: { getTargetByWindowId: vi.fn(() => undefined) },
        selectLinkedOrOpenTarget: vi.fn(),
        openLiveTmuxWindowForEntry: vi.fn(() => "missing"),
        postToProjectService: vi.fn(async () => ({ ok: true })),
        saveState: vi.fn(),
      };

      focusSession(host, 0);
      await vi.runOnlyPendingTimersAsync();

      expect(host.tmuxRuntimeManager.getTargetByWindowId).toHaveBeenCalledWith("aimux-test", "@2");
      expect(host.openLiveTmuxWindowForEntry).toHaveBeenCalledWith({
        id: "claude-1",
        backendSessionId: undefined,
      });
      expect(host.selectLinkedOrOpenTarget).not.toHaveBeenCalled();
      expect(host.noteLastUsedItem).not.toHaveBeenCalled();
      expect(host.postToProjectService).not.toHaveBeenCalled();
      expect(host.saveState).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      rmSync(repoRoot, { recursive: true, force: true });
    }
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
      startHeartbeat = vi.fn();
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
      startHeartbeat = vi.fn();
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

  it("only resumes offline topology sessions", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-resume-offline-only-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "codex-running",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: [],
          lifecycle: "running",
          backendSessionId: "backend-running",
          worktreePath: repoRoot,
        },
        {
          id: "codex-offline",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-offline",
          worktreePath: repoRoot,
        },
      ],
      projectRoot: repoRoot,
    });

    class Host {
      startHeartbeat = vi.fn();
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

    expect(host.createSession).toHaveBeenCalledOnce();
    expect(host.createSession).toHaveBeenCalledWith(
      "codex",
      expect.arrayContaining(["resume", "backend-offline"]),
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
      "backend-offline",
      "codex-offline",
      false,
      true,
      undefined,
    );

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("only restores offline topology sessions", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-restore-offline-only-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "codex-running",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: ["running"],
          lifecycle: "running",
          worktreePath: repoRoot,
        },
        {
          id: "codex-offline",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: ["offline"],
          lifecycle: "offline",
          worktreePath: repoRoot,
        },
      ],
      projectRoot: repoRoot,
    });

    const host = {
      createSession: vi.fn(),
      openTmuxDashboardTarget: vi.fn(),
      runDashboard: vi.fn(),
    };

    await expect(restoreSessions(host as any)).resolves.toBe(0);

    expect(host.createSession).toHaveBeenCalledOnce();
    expect(host.createSession).toHaveBeenCalledWith(
      "codex",
      ["offline"],
      undefined,
      "codex",
      undefined,
      undefined,
      repoRoot,
      undefined,
      "codex-offline",
      false,
      false,
      undefined,
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
      startHeartbeat = vi.fn();
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

  it("reconciles live tmux state before selecting topology sessions to resume", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-resume-reconcile-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "codex-live",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-live",
          worktreePath: repoRoot,
        },
      ],
      projectRoot: repoRoot,
    });

    class Host {
      startHeartbeat = vi.fn();
      syncSessionsFromTopology = vi.fn();
      saveState = vi.fn(() => {
        saveRuntimeTopologySessions({
          sessions: [
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
          ],
          projectRoot: repoRoot,
        });
      });
      sessionBootstrap = {
        canResumeWithBackendSessionId: vi.fn(() => true),
        composeToolArgs: vi.fn(),
      };
      createSession = vi.fn();
      openTmuxDashboardTarget = vi.fn();
      runDashboard = vi.fn();
    }

    const host = new Host();

    await resumeSessions(host as any);

    expect(host.syncSessionsFromTopology.mock.invocationCallOrder[0]).toBeLessThan(
      host.saveState.mock.invocationCallOrder[0],
    );
    expect(host.createSession).not.toHaveBeenCalled();
    expect(host.openTmuxDashboardTarget).not.toHaveBeenCalled();
    expect(host.runDashboard).toHaveBeenCalledOnce();

    rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe("runProjectService", () => {
  it("adopts live topology before exposing the project service", async () => {
    const resolveRun = vi.fn();
    const host: any = {
      mode: "dashboard",
      tmuxRuntimeManager: {
        repairLegacyProjectSessionNames: vi.fn(),
      },
      syncSessionsFromTopology: vi.fn(),
      writeInstructionFiles: vi.fn(),
      startProjectServices: vi.fn(),
      startStatusRefresh: vi.fn(() => resolveRun(0)),
      startGraveyardCleanup: vi.fn(),
      cleanupGraveyard: vi.fn(() => Promise.resolve({ dryRun: false, plan: {}, results: [] })),
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
    expect(host.tmuxRuntimeManager.repairLegacyProjectSessionNames).toHaveBeenCalledWith(process.cwd());
    expect(host.tmuxRuntimeManager.repairLegacyProjectSessionNames.mock.invocationCallOrder[0]).toBeLessThan(
      host.refreshDesktopStateSnapshot.mock.invocationCallOrder[0],
    );
    expect(host.syncSessionsFromTopology.mock.invocationCallOrder[0]).toBeLessThan(
      host.refreshDesktopStateSnapshot.mock.invocationCallOrder[0],
    );
    expect(host.refreshDesktopStateSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      host.startProjectServices.mock.invocationCallOrder[0],
    );
    expect(host.syncSessionsFromTopology.mock.invocationCallOrder[0]).toBeLessThan(
      host.writeInstructionFiles.mock.invocationCallOrder[0],
    );
    expect(host.startStatusRefresh).toHaveBeenCalledOnce();
    expect(host.startGraveyardCleanup).toHaveBeenCalledOnce();
    expect(host.cleanupGraveyard).toHaveBeenCalledOnce();
  });

  it("reconciles missing offline backend ids during startup", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-project-service-reconcile-"));
    const claudeHome = mkdtempSync(join(tmpdir(), "aimux-project-service-claude-"));
    const previousCwd = process.cwd();
    const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    try {
      gitInit(repoRoot);
      process.chdir(repoRoot);
      process.env.CLAUDE_CONFIG_DIR = claudeHome;
      await initPaths(repoRoot);
      saveRuntimeTopologySessions({
        projectRoot: repoRoot,
        sessions: [
          {
            id: "claude-1",
            tool: "claude",
            toolConfigKey: "claude",
            command: "claude",
            args: [],
            lifecycle: "offline",
            worktreePath: repoRoot,
          },
        ],
      });
      const backendSessionId = "0710a963-a473-430f-9f9a-e27dd4546328";
      const transcriptDir = join(claudeHome, "projects", repoRoot.replace(/[/.]/g, "-"));
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(join(transcriptDir, `${backendSessionId}.jsonl`), "{}\n");

      const host: any = {
        mode: "dashboard",
        syncSessionsFromTopology: vi.fn(),
        saveState: vi.fn(),
        writeInstructionFiles: vi.fn(),
        startProjectServices: vi.fn(),
        startStatusRefresh: vi.fn(),
        startGraveyardCleanup: vi.fn(),
        refreshDesktopStateSnapshot: vi.fn(),
        writeStatuslineFile: vi.fn(),
        teardown: vi.fn(),
        resolveRun: undefined,
      };

      const runPromise = runProjectService(host);
      await vi.waitFor(() => expect(host.resolveRun).toBeTypeOf("function"));
      host.resolveRun(0);
      await expect(runPromise).resolves.toBe(0);

      expect(host.syncSessionsFromTopology).toHaveBeenCalledTimes(2);
      const { listTopologySessionStates } = await import("../runtime-core/topology-sessions.js");
      expect(listTopologySessionStates().find((session) => session.id === "claude-1")?.backendSessionId).toBe(
        backendSessionId,
      );
    } finally {
      process.chdir(previousCwd);
      if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(claudeHome, { recursive: true, force: true });
    }
  });
});

describe("runDashboard", () => {
  it("hydrates restored subscreens and syncs footer state on initial startup", async () => {
    const host: any = {
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
      handleRuntimeGuardKey: vi.fn(() => false),
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

  it("lets active overlays own keys before the runtime guard", async () => {
    const host: any = {
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
      handleRuntimeGuardKey: vi.fn(() => true),
      handleActiveDashboardOverlayKey: vi.fn(() => true),
      isDashboardScreen: vi.fn(() => false),
      handleDashboardKey: vi.fn(),
      getViewportKey: vi.fn(() => "120x40"),
      invalidateDashboardFrame: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
      renderDashboard: vi.fn(),
      loadDashboardUiState: vi.fn(),
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
    host.onStdinData(Buffer.from("n"));
    host.resolveRun(0);
    await expect(runPromise).resolves.toBe(0);

    expect(host.handleActiveDashboardOverlayKey).toHaveBeenCalledWith(Buffer.from("n"));
    expect(host.handleRuntimeGuardKey).not.toHaveBeenCalled();
  });

  it("clears the startup busy state when repair completes without a fresh model change", async () => {
    const host: any = {
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
      handleRuntimeGuardKey: vi.fn(() => false),
      isDashboardScreen: vi.fn(() => false),
      handleDashboardKey: vi.fn(),
      getViewportKey: vi.fn(() => "120x40"),
      invalidateDashboardFrame: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
      renderDashboard: vi.fn(),
      loadDashboardUiState: vi.fn(),
      hydrateDashboardScreenState: vi.fn(),
      writeDashboardClientStatuslineFile: vi.fn(),
      dashboardState: { screen: "dashboard" },
      dashboardModelServiceRefreshedAt: 1,
      dashboardModelServiceRefreshError: undefined,
      refreshDashboardModelFromService: vi.fn(async () => false),
      refreshLocalDashboardModel: vi.fn(),
      ensureDashboardControlPlane: vi.fn(async () => undefined),
      startStatusRefresh: vi.fn(),
      showDashboardError: vi.fn(),
      teardown: vi.fn(),
      resolveRun: undefined,
      defaultCommand: undefined,
      defaultArgs: undefined,
    };

    const runPromise = runDashboard(host);
    await vi.waitFor(() => expect(host.ensureDashboardControlPlane).toHaveBeenCalled());
    await vi.waitFor(() => expect(host.dashboardBusyState).toBeNull());
    host.resolveRun(0);
    await expect(runPromise).resolves.toBe(0);

    expect(host.renderCurrentDashboardView).toHaveBeenCalled();
    expect(host.showDashboardError).not.toHaveBeenCalled();
  });

  it("clears the startup busy state and reports a repair failure when the service remains unavailable", async () => {
    const serviceError = new Error("service still unavailable");
    const host: any = {
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
      handleRuntimeGuardKey: vi.fn(() => false),
      isDashboardScreen: vi.fn(() => false),
      handleDashboardKey: vi.fn(),
      getViewportKey: vi.fn(() => "120x40"),
      invalidateDashboardFrame: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
      renderDashboard: vi.fn(),
      loadDashboardUiState: vi.fn(),
      hydrateDashboardScreenState: vi.fn(),
      writeDashboardClientStatuslineFile: vi.fn(),
      dashboardState: { screen: "dashboard" },
      dashboardModelServiceRefreshedAt: 1,
      dashboardModelServiceRefreshError: undefined,
      refreshDashboardModelFromService: vi.fn(async () => {
        host.dashboardModelServiceRefreshError = serviceError;
        return false;
      }),
      refreshLocalDashboardModel: vi.fn(),
      ensureDashboardControlPlane: vi.fn(async () => undefined),
      startStatusRefresh: vi.fn(),
      showDashboardError: vi.fn(),
      teardown: vi.fn(),
      resolveRun: undefined,
      defaultCommand: undefined,
      defaultArgs: undefined,
    };

    const runPromise = runDashboard(host);
    await vi.waitFor(() => expect(host.ensureDashboardControlPlane).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(host.showDashboardError).toHaveBeenCalledWith("Aimux repair failed", ["service still unavailable"]),
    );
    host.resolveRun(0);
    await expect(runPromise).resolves.toBe(0);

    expect(host.dashboardBusyState).toBeNull();
    expect(host.renderCurrentDashboardView).toHaveBeenCalled();
  });

  it("does not render or report stale startup repair after later dashboard input", async () => {
    const host: any = {
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
      handleRuntimeGuardKey: vi.fn(() => false),
      isDashboardScreen: vi.fn(() => false),
      handleDashboardKey: vi.fn(),
      getViewportKey: vi.fn(() => "120x40"),
      invalidateDashboardFrame: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
      renderDashboard: vi.fn(),
      loadDashboardUiState: vi.fn(),
      hydrateDashboardScreenState: vi.fn(),
      writeDashboardClientStatuslineFile: vi.fn(),
      dashboardState: { screen: "dashboard" },
      dashboardModelServiceRefreshedAt: 1,
      dashboardModelServiceRefreshError: undefined,
      refreshDashboardModelFromService: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockImplementationOnce(async () => {
          host.dashboardModelServiceRefreshError = undefined;
          host.dashboardModelServiceRefreshedAt = 2;
          return true;
        }),
      refreshLocalDashboardModel: vi.fn(),
      ensureDashboardControlPlane: vi.fn(async () => {
        host.mode = "dashboard";
        host.dashboardInputEpoch = 1;
      }),
      startStatusRefresh: vi.fn(),
      showDashboardError: vi.fn(),
      teardown: vi.fn(),
      resolveRun: undefined,
      defaultCommand: undefined,
      defaultArgs: undefined,
    };

    const runPromise = runDashboard(host);
    await vi.waitFor(() => expect(host.ensureDashboardControlPlane).toHaveBeenCalled());
    await vi.waitFor(() => expect(host.dashboardBusyState).toBeNull());
    host.resolveRun(0);
    await expect(runPromise).resolves.toBe(0);

    expect(host.showDashboardError).not.toHaveBeenCalled();
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
  });

  it("initializes dashboard input epoch before hydrate and priming refresh", async () => {
    const host: any = {
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
      handleRuntimeGuardKey: vi.fn(() => false),
      isDashboardScreen: vi.fn(() => false),
      handleDashboardKey: vi.fn(),
      getViewportKey: vi.fn(() => "120x40"),
      invalidateDashboardFrame: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
      renderDashboard: vi.fn(),
      loadDashboardUiState: vi.fn(),
      hydrateDashboardScreenState: vi.fn(() => {
        expect(host.dashboardInputEpoch).toBe(0);
      }),
      writeDashboardClientStatuslineFile: vi.fn(),
      dashboardState: { screen: "dashboard" },
      dashboardModelServiceRefreshedAt: 0,
      dashboardModelServiceRefreshError: undefined,
      refreshDashboardModelFromService: vi.fn(async () => true),
      refreshLocalDashboardModel: vi.fn(),
      ensureDashboardControlPlane: vi.fn(async () => undefined),
      startStatusRefresh: vi.fn(),
      showDashboardError: vi.fn(),
      teardown: vi.fn(),
      resolveRun: undefined,
      defaultCommand: undefined,
      defaultArgs: undefined,
    };

    const runPromise = runDashboard(host);
    await vi.waitFor(() => expect(host.refreshDashboardModelFromService).toHaveBeenCalledOnce());
    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        lifecycle: expect.objectContaining({ mode: "dashboard", inputEpoch: undefined }),
      }),
    );
    await vi.waitFor(() => expect(typeof host.resolveRun).toBe("function"));
    host.resolveRun(0);
    await expect(runPromise).resolves.toBe(0);
  });

  it("does not discard startup priming data after later dashboard input", async () => {
    let resolvePriming!: () => void;
    const primingSettled = new Promise<void>((resolve) => {
      resolvePriming = resolve;
    });
    const host: any = {
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
      handleRuntimeGuardKey: vi.fn(() => false),
      isDashboardScreen: vi.fn(() => false),
      handleDashboardKey: vi.fn(),
      getViewportKey: vi.fn(() => "120x40"),
      invalidateDashboardFrame: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
      renderDashboard: vi.fn(),
      loadDashboardUiState: vi.fn(),
      hydrateDashboardScreenState: vi.fn(),
      writeDashboardClientStatuslineFile: vi.fn(),
      dashboardState: { screen: "dashboard" },
      dashboardModelServiceRefreshedAt: 0,
      dashboardModelServiceRefreshError: undefined,
      refreshDashboardModelFromService: vi.fn(async (_force: boolean, opts?: any) => {
        await primingSettled;
        return opts?.lifecycle?.requiresInputEpoch ? false : true;
      }),
      refreshLocalDashboardModel: vi.fn(),
      ensureDashboardControlPlane: vi.fn(async () => undefined),
      startStatusRefresh: vi.fn(),
      showDashboardError: vi.fn(),
      teardown: vi.fn(),
      resolveRun: undefined,
      defaultCommand: undefined,
      defaultArgs: undefined,
    };

    const runPromise = runDashboard(host);
    await vi.waitFor(() => expect(host.refreshDashboardModelFromService).toHaveBeenCalledOnce());
    host.dashboardInputEpoch = 1;
    resolvePriming();
    await vi.waitFor(() => expect(typeof host.resolveRun).toBe("function"));
    host.resolveRun(0);
    await expect(runPromise).resolves.toBe(0);

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        lifecycle: expect.objectContaining({ mode: "dashboard", inputEpoch: undefined }),
      }),
    );
    expect(host.dashboardBusyState).toBeUndefined();
    expect(host.showDashboardError).not.toHaveBeenCalled();
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
  });

  it("does not render or report stale startup repair after a newer dashboard run starts", async () => {
    const host: any = {
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
      handleRuntimeGuardKey: vi.fn(() => false),
      isDashboardScreen: vi.fn(() => false),
      handleDashboardKey: vi.fn(),
      getViewportKey: vi.fn(() => "120x40"),
      invalidateDashboardFrame: vi.fn(),
      renderCurrentDashboardView: vi.fn(),
      renderDashboard: vi.fn(),
      loadDashboardUiState: vi.fn(),
      hydrateDashboardScreenState: vi.fn(),
      writeDashboardClientStatuslineFile: vi.fn(),
      dashboardState: { screen: "dashboard" },
      dashboardModelServiceRefreshedAt: 1,
      dashboardModelServiceRefreshError: undefined,
      refreshDashboardModelFromService: vi.fn(async () => false),
      refreshLocalDashboardModel: vi.fn(),
      ensureDashboardControlPlane: vi.fn(async () => {
        host.dashboardRunGeneration += 1;
      }),
      startStatusRefresh: vi.fn(),
      showDashboardError: vi.fn(),
      teardown: vi.fn(),
      resolveRun: undefined,
      defaultCommand: undefined,
      defaultArgs: undefined,
    };

    const runPromise = runDashboard(host);
    await vi.waitFor(() => expect(host.ensureDashboardControlPlane).toHaveBeenCalled());
    await vi.waitFor(() => expect(host.dashboardBusyState).toBeNull());
    host.resolveRun(0);
    await expect(runPromise).resolves.toBe(0);

    expect(host.refreshDashboardModelFromService).toHaveBeenCalledOnce();
    expect(host.showDashboardError).not.toHaveBeenCalled();
    expect(host.renderCurrentDashboardView).toHaveBeenCalledOnce();
  });
});
