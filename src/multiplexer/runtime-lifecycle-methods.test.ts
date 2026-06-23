import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStatePath, initPaths } from "../paths.js";
import { loadStateStatic, runtimeLifecycleMethods } from "./runtime-lifecycle-methods.js";
import { listTopologySessionStates, saveRuntimeTopologySessions } from "../runtime-core/topology-sessions.js";

describe("runtime lifecycle state persistence", () => {
  let repoRoot = "";
  let originalCwd = "";

  beforeEach(async () => {
    originalCwd = process.cwd();
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-runtime-lifecycle-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function host(overrides: Record<string, unknown> = {}) {
    return {
      sessions: [],
      offlineSessions: [],
      offlineServices: [],
      sessionToolKeys: new Map(),
      sessionOriginalArgs: new Map(),
      sessionWorktreePaths: new Map(),
      sessionTmuxTargets: new Map(),
      buildLiveServiceStates: vi.fn(() => []),
      invalidateDesktopStateSnapshot: vi.fn(),
      isSessionRuntimeLive: vi.fn(() => true),
      getSessionLabel: vi.fn(() => undefined),
      deriveHeadline: vi.fn(() => undefined),
      ...overrides,
    };
  }

  function topologySessions() {
    return listTopologySessionStates({ statuses: ["running", "idle", "offline"] });
  }

  it("does not create AGENTS.md by default", () => {
    process.chdir(repoRoot);
    const agentsPath = join(repoRoot, "AGENTS.md");
    const writtenInstructionFiles = new Set<string>();

    runtimeLifecycleMethods.writeInstructionFiles.call({
      writtenInstructionFiles,
    } as never);

    expect(existsSync(agentsPath)).toBe(false);
    expect(writtenInstructionFiles.size).toBe(0);
  });

  it("ignores legacy configured instruction files without overwriting user content", () => {
    process.chdir(repoRoot);
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux", "config.json"),
      JSON.stringify({ tools: { codex: { instructionsFile: "AGENTS.md" } } }, null, 2) + "\n",
    );
    const agentsPath = join(repoRoot, "AGENTS.md");
    writeFileSync(agentsPath, "# Project Rules\n\nKeep this user rule.\n");
    const writtenInstructionFiles = new Set<string>();

    runtimeLifecycleMethods.writeInstructionFiles.call({
      writtenInstructionFiles,
    } as never);

    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toContain("# Project Rules");
    expect(content).toContain("Keep this user rule.");
    expect(content).not.toContain("<!-- BEGIN Aimux MANAGED BLOCK: aimux-agent-instructions -->");
    expect(writtenInstructionFiles.size).toBe(0);
  });

  it("does not track legacy configured instruction files during cleanup", () => {
    process.chdir(repoRoot);
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux", "config.json"),
      JSON.stringify({ tools: { codex: { instructionsFile: "AGENTS.md" } } }, null, 2) + "\n",
    );
    const agentsPath = join(repoRoot, "AGENTS.md");
    writeFileSync(agentsPath, "# Project Rules\n\nKeep this user rule.\n");
    const writtenInstructionFiles = new Set<string>();
    const lifecycleHost = { writtenInstructionFiles } as never;

    runtimeLifecycleMethods.writeInstructionFiles.call(lifecycleHost);
    runtimeLifecycleMethods.removeInstructionFiles.call(lifecycleHost);

    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toBe("# Project Rules\n\nKeep this user rule.\n");
    expect(writtenInstructionFiles.size).toBe(0);
  });

  it("does not create configured generated-only instruction files", () => {
    process.chdir(repoRoot);
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux", "config.json"),
      JSON.stringify({ tools: { codex: { instructionsFile: "AGENTS.md" } } }, null, 2) + "\n",
    );
    const agentsPath = join(repoRoot, "AGENTS.md");
    const writtenInstructionFiles = new Set<string>();
    const lifecycleHost = { writtenInstructionFiles } as never;

    runtimeLifecycleMethods.writeInstructionFiles.call(lifecycleHost);
    expect(existsSync(agentsPath)).toBe(false);
    expect(writtenInstructionFiles.size).toBe(0);
  });

  it("removes stale default AGENTS.md managed blocks when file projection is no longer configured", () => {
    process.chdir(repoRoot);
    const agentsPath = join(repoRoot, "AGENTS.md");
    writeFileSync(
      agentsPath,
      [
        "# Project Rules",
        "",
        "Keep this user rule.",
        "",
        "<!-- BEGIN Aimux MANAGED BLOCK: aimux-agent-instructions -->",
        "# aimux Agent Instructions",
        "old generated content",
        "<!-- END Aimux MANAGED BLOCK: aimux-agent-instructions -->",
        "",
      ].join("\n"),
    );
    const writtenInstructionFiles = new Set<string>();

    runtimeLifecycleMethods.writeInstructionFiles.call({
      writtenInstructionFiles,
    } as never);

    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toBe("# Project Rules\n\nKeep this user rule.\n");
    expect(writtenInstructionFiles.size).toBe(0);
  });

  it("leaves user-authored AGENTS.md untouched when no aimux managed block exists", () => {
    process.chdir(repoRoot);
    const agentsPath = join(repoRoot, "AGENTS.md");
    const userContent = "# Project Rules\n\nKeep this user rule.\n\n";
    writeFileSync(agentsPath, userContent);
    const writtenInstructionFiles = new Set<string>();

    runtimeLifecycleMethods.writeInstructionFiles.call({
      writtenInstructionFiles,
    } as never);

    expect(readFileSync(agentsPath, "utf-8")).toBe(userContent);
    expect(writtenInstructionFiles.size).toBe(0);
  });

  it("deletes stale generated-only AGENTS.md when file projection is no longer configured", () => {
    process.chdir(repoRoot);
    const agentsPath = join(repoRoot, "AGENTS.md");
    writeFileSync(
      agentsPath,
      [
        "<!-- BEGIN Aimux MANAGED BLOCK: aimux-agent-instructions -->",
        "# aimux Agent Instructions",
        "old generated content",
        "<!-- END Aimux MANAGED BLOCK: aimux-agent-instructions -->",
        "",
      ].join("\n"),
    );
    const writtenInstructionFiles = new Set<string>();

    runtimeLifecycleMethods.writeInstructionFiles.call({
      writtenInstructionFiles,
    } as never);

    expect(existsSync(agentsPath)).toBe(false);
    expect(writtenInstructionFiles.size).toBe(0);
  });

  it("removes stale managed blocks from legacy adapter docs", () => {
    process.chdir(repoRoot);
    for (const file of ["CLAUDE.md", "CODEX.md"]) {
      writeFileSync(
        join(repoRoot, file),
        [
          "# Adapter",
          "",
          "<!-- BEGIN Aimux MANAGED BLOCK: aimux-agent-instructions -->",
          "# aimux Agent Instructions",
          "old generated content",
          "<!-- END Aimux MANAGED BLOCK: aimux-agent-instructions -->",
          "",
        ].join("\n"),
      );
    }
    const writtenInstructionFiles = new Set<string>();

    runtimeLifecycleMethods.writeInstructionFiles.call({
      writtenInstructionFiles,
    } as never);

    expect(readFileSync(join(repoRoot, "CLAUDE.md"), "utf-8")).toBe("# Adapter\n");
    expect(readFileSync(join(repoRoot, "CODEX.md"), "utf-8")).toBe("# Adapter\n");
    expect(writtenInstructionFiles.size).toBe(0);
  });

  it("does not expose topology sessions through the service state loader", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify({ savedAt: new Date().toISOString(), cwd: repoRoot, sessions: [], services: [] }, null, 2) + "\n",
    );
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "codex-offline",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-1",
          worktreePath: repoRoot,
        },
      ],
    });

    expect(loadStateStatic()).not.toHaveProperty("sessions");
    expect(topologySessions()).toEqual([expect.objectContaining({ id: "codex-offline" })]);
  });

  it("awaits project service shutdown during cleanup", async () => {
    const order: string[] = [];
    const stopProjectServices = vi.fn(async () => {
      order.push("stop-start");
      await new Promise((resolve) => setTimeout(resolve, 0));
      order.push("stop-done");
    });
    const session = { destroy: vi.fn(() => order.push("destroy")) };
    const lifecycleHost = {
      teardown: vi.fn(() => order.push("teardown")),
      stopProjectServices,
      sessions: [session],
    };

    await runtimeLifecycleMethods.cleanup.call(lifecycleHost as never);

    expect(order).toEqual(["teardown", "destroy", "stop-start", "stop-done"]);
    expect(stopProjectServices).toHaveBeenCalledOnce();
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it("clears pending TUI API recovery during teardown", () => {
    vi.useFakeTimers();
    try {
      const refreshRuntimeGuard = vi.fn();
      const teardownHost = {
        clearDashboardBusy: vi.fn(),
        stopHeartbeat: vi.fn(),
        stopProjectServiceRefresh: vi.fn(),
        tuiProjectEventAdapter: { stop: vi.fn() },
        tuiApiRecoveryTimer: setTimeout(refreshRuntimeGuard, 25),
        tuiApiRecoveryDueAt: Date.now() + 25,
        tuiApiRecoveryPending: true,
        tuiApiRecoveryInFlight: true,
        tuiApiRuntime: { dispose: vi.fn() },
        stopGraveyardCleanup: vi.fn(),
        stopInboxCleanup: vi.fn(),
        saveState: vi.fn(),
        stopStatusRefresh: vi.fn(),
        contextWatcher: { stop: vi.fn() },
        removeInstructionFiles: vi.fn(),
        hotkeys: { destroy: vi.fn() },
        terminalHost: { restoreTerminalState: vi.fn() },
      };

      runtimeLifecycleMethods.teardown.call(teardownHost as never);
      vi.advanceTimersByTime(25);

      expect(teardownHost.tuiApiRecoveryTimer).toBeNull();
      expect(teardownHost.tuiApiRecoveryDueAt).toBeUndefined();
      expect(teardownHost.tuiApiRecoveryPending).toBe(false);
      expect(teardownHost.tuiApiRecoveryInFlight).toBe(false);
      expect(refreshRuntimeGuard).not.toHaveBeenCalled();
      expect(teardownHost.tuiProjectEventAdapter).toBeNull();
      expect(teardownHost.tuiApiRuntime).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves topology sessions even when service state does not exist yet", () => {
    if (existsSync(getStatePath())) unlinkSync(getStatePath());
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "codex-offline",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-1",
          worktreePath: repoRoot,
        },
      ],
    });

    runtimeLifecycleMethods.saveState.call(host() as never);

    expect(topologySessions()).toEqual([
      expect.objectContaining({
        id: "codex-offline",
        lifecycle: "offline",
        backendSessionId: "backend-1",
      }),
    ]);
    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as Record<string, unknown>;
    expect(saved).not.toHaveProperty("sessions");
  });

  it("persists an empty session list after the last local agent row is removed", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [{ id: "stale-agent", command: "codex", tool: "codex", args: [] }],
          services: [{ id: "stale-service", command: "shell", args: [] }],
        },
        null,
        2,
      ) + "\n",
    );

    runtimeLifecycleMethods.saveState.call(host() as never);

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as { services: unknown[] };
    expect(saved).not.toHaveProperty("sessions");
    expect(saved.services).toEqual([{ id: "stale-service", command: "shell", args: [] }]);
  });

  it("preserves service rows that were not loaded into the current process yet", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [],
          services: [{ id: "existing-service", command: "shell", args: [], worktreePath: repoRoot }],
        },
        null,
        2,
      ) + "\n",
    );

    runtimeLifecycleMethods.saveState.call(host() as never);

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as {
      services: Array<{ id: string }>;
    };
    expect(saved.services.map((service) => service.id)).toEqual(["existing-service"]);
  });

  it("drops explicitly removed service rows when merging state", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [],
          services: [{ id: "removed-service", command: "shell", args: [], worktreePath: repoRoot }],
        },
        null,
        2,
      ) + "\n",
    );

    runtimeLifecycleMethods.saveState.call(
      host({
        removedServiceIds: new Set(["removed-service"]),
      }) as never,
    );

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as {
      services: Array<{ id: string }>;
    };
    expect(saved.services).toEqual([]);
  });

  it("preserves existing topology sessions when this instance has no local rows", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [],
          services: [{ id: "stale-service", command: "shell", args: [] }],
        },
        null,
        2,
      ) + "\n",
    );
    saveRuntimeTopologySessions({
      sessions: [{ id: "remote-agent", command: "claude", tool: "claude", toolConfigKey: "claude", args: [] }],
    });

    runtimeLifecycleMethods.saveState.call(host() as never);

    const saved = JSON.parse(readFileSync(getStatePath(), "utf-8")) as { services: Array<{ id: string }> };
    expect(topologySessions().map((session) => session.id)).toEqual(["remote-agent"]);
    expect(saved.services.map((service) => service.id)).toEqual(["stale-service"]);
  });

  it("preserves recoverable existing live sessions when saving partial state", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [],
          services: [],
        },
        null,
        2,
      ) + "\n",
    );
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "local-agent",
          command: "claude",
          tool: "claude",
          toolConfigKey: "claude",
          args: ["--resume", "backend-1"],
          lifecycle: "live",
          backendSessionId: "backend-1",
          worktreePath: repoRoot,
          tmuxTarget: {
            sessionName: "aimux-repo",
            windowId: "@7",
            windowIndex: 7,
            windowName: "claude",
          },
        },
      ],
    });

    runtimeLifecycleMethods.saveState.call(host() as never);

    expect(topologySessions()).toEqual([
      expect.objectContaining({
        id: "local-agent",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: ["--resume", "backend-1"],
        lifecycle: "live",
        backendSessionId: "backend-1",
        worktreePath: repoRoot,
        tmuxTarget: expect.objectContaining({
          windowId: "@7",
        }),
      }),
    ]);
  });

  it("preserves valid live session rows without backend ids during partial saves", () => {
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [],
          services: [],
        },
        null,
        2,
      ) + "\n",
    );
    saveRuntimeTopologySessions({
      sessions: [
        {
          id: "local-agent",
          command: "claude",
          tool: "claude",
          toolConfigKey: "claude",
          args: [],
          lifecycle: "live",
          worktreePath: repoRoot,
        },
      ],
    });

    runtimeLifecycleMethods.saveState.call(host() as never);

    expect(topologySessions()).toEqual([
      expect.objectContaining({
        id: "local-agent",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        lifecycle: "live",
        worktreePath: repoRoot,
      }),
    ]);
  });

  it("deduplicates recovered existing sessions while preserving the latest row", () => {
    const duplicate = {
      id: "local-agent",
      command: "claude",
      tool: "claude",
      toolConfigKey: "claude",
      args: ["--resume", "backend-1"],
      lifecycle: "live",
      backendSessionId: "backend-1",
      worktreePath: repoRoot,
      tmuxTarget: {
        sessionName: "aimux-repo",
        windowId: "@7",
        windowIndex: 7,
        windowName: "claude",
      },
    };
    writeFileSync(
      getStatePath(),
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          cwd: repoRoot,
          sessions: [],
          services: [],
        },
        null,
        2,
      ) + "\n",
    );
    saveRuntimeTopologySessions({
      sessions: [
        { ...duplicate, label: "old" },
        { ...duplicate, label: "new" },
      ],
    });

    runtimeLifecycleMethods.saveState.call(host() as never);

    expect(topologySessions()).toHaveLength(1);
    expect(topologySessions()[0]).toMatchObject({
      id: "local-agent",
      lifecycle: "live",
      label: "new",
    });
  });

  it("persists intentional offline sessions without stale tmux targets", () => {
    runtimeLifecycleMethods.saveState.call(
      host({
        offlineSessions: [
          {
            id: "codex-offline",
            tool: "codex",
            toolConfigKey: "codex",
            command: "codex",
            args: [],
            tmuxTarget: {
              sessionName: "aimux-repo",
              windowId: "@2",
              windowIndex: 2,
              windowName: "codex",
            },
          },
        ],
      }) as never,
    );

    expect(topologySessions()).toEqual([
      expect.objectContaining({
        id: "codex-offline",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
        lifecycle: "offline",
      }),
    ]);
  });

  it("persists only live runtimes that still have matching tmux authority", () => {
    const runtime = {
      id: "codex-live",
      command: "codex",
      backendSessionId: "backend-1",
      startTime: Date.parse("2026-04-21T00:00:00.000Z"),
    };
    const tmuxTarget = {
      sessionName: "aimux-repo",
      windowId: "@3",
      windowIndex: 3,
      windowName: "codex",
    };

    runtimeLifecycleMethods.saveState.call(
      host({
        sessions: [runtime],
        sessionToolKeys: new Map([["codex-live", "codex"]]),
        sessionOriginalArgs: new Map([["codex-live", ["--resume"]]]),
        sessionWorktreePaths: new Map([["codex-live", repoRoot]]),
        sessionTmuxTargets: new Map([["codex-live", tmuxTarget]]),
        getSessionLabel: vi.fn(() => "coder"),
        deriveHeadline: vi.fn(() => "working"),
      }) as never,
    );

    expect(topologySessions()).toEqual([
      expect.objectContaining({
        id: "codex-live",
        lifecycle: "live",
        backendSessionId: "backend-1",
        tmuxTarget,
      }),
    ]);
  });

  it("does not fill missing live backend ids from metadata while saving state", () => {
    const runtime = {
      id: "claude-live",
      command: "claude",
      startTime: Date.parse("2026-04-21T00:00:00.000Z"),
    };
    const tmuxTarget = {
      sessionName: "aimux-repo",
      windowId: "@4",
      windowIndex: 4,
      windowName: "claude",
    };

    runtimeLifecycleMethods.saveState.call(
      host({
        sessions: [runtime],
        sessionToolKeys: new Map([["claude-live", "claude"]]),
        sessionOriginalArgs: new Map([["claude-live", ["--resume"]]]),
        sessionWorktreePaths: new Map([["claude-live", repoRoot]]),
        sessionTmuxTargets: new Map([["claude-live", tmuxTarget]]),
      }) as never,
    );

    expect(topologySessions()).toEqual([
      expect.objectContaining({
        id: "claude-live",
        backendSessionId: undefined,
      }),
    ]);
  });

  it("does not replace a known runtime backend id with conflicting metadata", () => {
    const runtime = {
      id: "claude-live",
      command: "claude",
      backendSessionId: "backend-current",
      startTime: Date.parse("2026-04-21T00:00:00.000Z"),
    };
    const tmuxTarget = {
      sessionName: "aimux-repo",
      windowId: "@5",
      windowIndex: 5,
      windowName: "claude",
    };

    runtimeLifecycleMethods.saveState.call(
      host({
        sessions: [runtime],
        sessionToolKeys: new Map([["claude-live", "claude"]]),
        sessionOriginalArgs: new Map([["claude-live", ["--resume", "backend-current"]]]),
        sessionWorktreePaths: new Map([["claude-live", repoRoot]]),
        sessionTmuxTargets: new Map([["claude-live", tmuxTarget]]),
      }) as never,
    );

    expect(topologySessions()).toEqual([
      expect.objectContaining({
        id: "claude-live",
        backendSessionId: "backend-current",
      }),
    ]);
  });
});
