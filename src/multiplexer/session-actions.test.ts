import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initPaths } from "../paths.js";
import { recordSessionBackendSessionIdMetadata } from "../metadata-store.js";
import { createTeammateAgent, forkAgent, sendAgentToGraveyard, spawnAgent, stopAgent } from "./session-actions.js";

vi.mock("../config.js", () => ({
  loadConfig: () => ({
    defaultTool: "codex",
    tools: {
      codex: { command: "codex", enabled: true, args: [], preambleFlag: undefined, sessionIdFlag: undefined },
      claude: { command: "claude", enabled: true, args: [], preambleFlag: undefined, sessionIdFlag: undefined },
    },
  }),
}));

describe("session actions", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-actions-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function liveRuntime(id: string, command = "claude", extra: Record<string, unknown> = {}) {
    return {
      id,
      command,
      exited: false,
      startTime: Date.parse("2026-05-01T00:00:00.000Z"),
      onExit(callback: () => void) {
        this.exitCallback = callback;
      },
      kill() {
        this.exited = true;
        this.exitCallback?.();
      },
      ...extra,
    } as any;
  }

  it("waits for live entry readiness before falling back on spawn", async () => {
    const target = { sessionName: "aimux-test", windowId: "@2", windowName: "codex" };
    const host: any = {
      syncSessionsFromState: vi.fn(),
      createSession: vi.fn(() => ({ id: "codex-1" })),
      sessionTmuxTargets: new Map([["codex-1", target]]),
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(async () => "opened"),
      openLiveTmuxWindowForEntry: vi.fn(),
      tmuxRuntimeManager: {
        openTarget: vi.fn(),
        isInsideTmux: vi.fn(() => true),
      },
    };

    await spawnAgent(host, { toolConfigKey: "codex" });

    expect(host.waitAndOpenLiveTmuxWindowForEntry).toHaveBeenCalledWith({ id: "codex-1" });
    expect(host.tmuxRuntimeManager.openTarget).not.toHaveBeenCalled();
  });

  it("appends launch-specific extra args on spawn", async () => {
    const host: any = {
      syncSessionsFromState: vi.fn(),
      createSession: vi.fn(() => ({ id: "codex-1" })),
      sessionTmuxTargets: new Map(),
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(),
      openLiveTmuxWindowForEntry: vi.fn(),
      tmuxRuntimeManager: {
        openTarget: vi.fn(),
        isInsideTmux: vi.fn(() => true),
      },
    };

    await spawnAgent(host, { toolConfigKey: "codex", extraArgs: ["--model", "gpt-5.5"], open: false });

    expect(host.createSession).toHaveBeenCalledWith(
      "codex",
      ["--model", "gpt-5.5"],
      undefined,
      "codex",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it("creates teammate agents with inherited tool, worktree, and team metadata", async () => {
    const parent = { id: "claude-parent", command: "claude", exited: false };
    const host: any = {
      syncSessionsFromState: vi.fn(),
      sessions: [parent],
      offlineSessions: [],
      sessionToolKeys: new Map([["claude-parent", "claude"]]),
      sessionWorktreePaths: new Map([["claude-parent", join(repoRoot, ".aimux/worktrees/feature")]]),
      createSession: vi.fn(() => ({ id: "claude-reviewer" })),
      sessionTmuxTargets: new Map(),
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(),
      openLiveTmuxWindowForEntry: vi.fn(),
      tmuxRuntimeManager: {
        openTarget: vi.fn(),
        isInsideTmux: vi.fn(() => true),
      },
      updateSessionLabel: vi.fn(async () => {}),
    };

    const result = await createTeammateAgent(host, {
      parentSessionId: "claude-parent",
      role: "reviewer",
      label: "reviewer",
      targetSessionId: "claude-reviewer",
      open: false,
    });

    expect(result).toEqual({
      sessionId: "claude-reviewer",
      parentSessionId: "claude-parent",
      teamId: "team-claude-parent",
      role: "reviewer",
      label: "reviewer",
    });
    expect(host.createSession).toHaveBeenCalledWith(
      "claude",
      [],
      undefined,
      "claude",
      expect.stringContaining('You are assigned the "reviewer" role'),
      undefined,
      join(repoRoot, ".aimux/worktrees/feature"),
      undefined,
      "claude-reviewer",
      false,
      false,
      {
        teamId: "team-claude-parent",
        parentSessionId: "claude-parent",
        role: "reviewer",
        label: "reviewer",
        order: 0,
      },
    );
    expect(host.updateSessionLabel).toHaveBeenCalledWith("claude-reviewer", "reviewer");
  });

  it("sends teammate initial prompts through normal agent input", async () => {
    const parent = { id: "codex-parent", command: "codex", exited: false };
    const host: any = {
      syncSessionsFromState: vi.fn(),
      sessions: [parent],
      offlineSessions: [],
      sessionToolKeys: new Map([["codex-parent", "codex"]]),
      sessionWorktreePaths: new Map(),
      createSession: vi.fn(() => ({ id: "codex-worker" })),
      sessionTmuxTargets: new Map(),
      writeAgentInput: vi.fn(async () => ({ sessionId: "codex-worker" })),
    };

    await createTeammateAgent(host, {
      parentSessionId: "codex-parent",
      role: "coder",
      initialPrompt: "Investigate the failing test.",
      open: false,
    });

    expect(host.writeAgentInput).toHaveBeenCalledWith(
      "codex-worker",
      "Investigate the failing test.",
      undefined,
      undefined,
      true,
    );
  });

  it("rejects teammate creation for missing or nested parents", async () => {
    const host: any = {
      syncSessionsFromState: vi.fn(),
      sessions: [
        {
          id: "nested",
          command: "codex",
          exited: false,
          team: { teamId: "team-parent", parentSessionId: "parent", role: "coder" },
        },
      ],
      offlineSessions: [],
      sessionToolKeys: new Map(),
      createSession: vi.fn(),
    };

    await expect(createTeammateAgent(host, { parentSessionId: "missing" })).rejects.toThrow(
      'Parent agent "missing" is not running locally',
    );
    await expect(createTeammateAgent(host, { parentSessionId: "nested" })).rejects.toThrow(
      'Parent agent "nested" is already a teammate',
    );
    expect(host.createSession).not.toHaveBeenCalled();
  });

  it("stops direct teammates before stopping a primary agent", async () => {
    const parent = liveRuntime("claude-parent");
    const teammate = liveRuntime("claude-reviewer", "claude", {
      team: { teamId: "team-claude-parent", parentSessionId: "claude-parent", role: "reviewer", order: 0 },
    });
    const independent = liveRuntime("claude-independent");
    const stopOrder: string[] = [];
    const host: any = {
      syncSessionsFromState: vi.fn(),
      sessions: [parent, teammate, independent],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      sessionToolKeys: new Map([
        ["claude-parent", "claude"],
        ["claude-reviewer", "claude"],
        ["claude-independent", "claude"],
      ]),
      sessionOriginalArgs: new Map(),
      sessionWorktreePaths: new Map(),
      getSessionLabel: vi.fn(() => undefined),
      deriveHeadline: vi.fn(() => undefined),
      isSessionRuntimeLive: vi.fn(() => true),
      stopSessionToOffline: vi.fn((session: any) => {
        stopOrder.push(session.id);
        session.kill();
      }),
      saveState: vi.fn(),
    };

    await stopAgent(host, "claude-parent");

    expect(stopOrder).toEqual(["claude-reviewer", "claude-parent"]);
    expect(stopOrder).not.toContain("claude-independent");
  });

  it("does not propagate lifecycle actions upward when stopping a teammate directly", async () => {
    const parent = liveRuntime("claude-parent");
    const teammate = liveRuntime("claude-reviewer", "claude", {
      team: { teamId: "team-claude-parent", parentSessionId: "claude-parent", role: "reviewer" },
    });
    const host: any = {
      syncSessionsFromState: vi.fn(),
      sessions: [parent, teammate],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      sessionToolKeys: new Map([
        ["claude-parent", "claude"],
        ["claude-reviewer", "claude"],
      ]),
      sessionOriginalArgs: new Map(),
      sessionWorktreePaths: new Map(),
      getSessionLabel: vi.fn(() => undefined),
      deriveHeadline: vi.fn(() => undefined),
      isSessionRuntimeLive: vi.fn(() => true),
      stopSessionToOffline: vi.fn((session: any) => session.kill()),
      saveState: vi.fn(),
    };

    await stopAgent(host, "claude-reviewer");

    expect(host.stopSessionToOffline).toHaveBeenCalledTimes(1);
    expect(host.stopSessionToOffline).toHaveBeenCalledWith(teammate);
  });

  it("graveyards direct teammates before graveyarding a primary agent", async () => {
    const graveyardOrder: string[] = [];
    const host: any = {
      syncSessionsFromState: vi.fn(),
      sessions: [],
      offlineSessions: [
        {
          id: "claude-parent",
          command: "claude",
          toolConfigKey: "claude",
          lifecycle: "offline",
          worktreePath: repoRoot,
        },
        {
          id: "claude-reviewer",
          command: "claude",
          toolConfigKey: "claude",
          lifecycle: "offline",
          worktreePath: repoRoot,
          team: { teamId: "team-claude-parent", parentSessionId: "claude-parent", role: "reviewer", order: 0 },
        },
      ],
      graveyardAfterStopSessionIds: new Set(),
      stoppingSessionIds: new Set(),
      graveyardSession: vi.fn((sessionId: string) => {
        graveyardOrder.push(sessionId);
        host.offlineSessions = host.offlineSessions.filter((session: any) => session.id !== sessionId);
      }),
      saveState: vi.fn(),
    };

    await sendAgentToGraveyard(host, "claude-parent");

    expect(graveyardOrder).toEqual(["claude-reviewer", "claude-parent"]);
    expect(host.offlineSessions).toEqual([]);
  });

  it("attempts the parent stop even when a teammate stop fails", async () => {
    const parent = liveRuntime("claude-parent");
    const teammate = liveRuntime("claude-reviewer", "claude", {
      team: { teamId: "team-claude-parent", parentSessionId: "claude-parent", role: "reviewer" },
    });
    const stopOrder: string[] = [];
    const host: any = {
      syncSessionsFromState: vi.fn(),
      sessions: [parent, teammate],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      sessionToolKeys: new Map([
        ["claude-parent", "claude"],
        ["claude-reviewer", "claude"],
      ]),
      sessionOriginalArgs: new Map(),
      sessionWorktreePaths: new Map(),
      getSessionLabel: vi.fn(() => undefined),
      deriveHeadline: vi.fn(() => undefined),
      isSessionRuntimeLive: vi.fn(() => true),
      stopSessionToOffline: vi.fn((session: any) => {
        stopOrder.push(session.id);
        if (session.id === "claude-reviewer") {
          throw new Error("tmux refused");
        }
        session.kill();
      }),
      saveState: vi.fn(),
    };

    await expect(stopAgent(host, "claude-parent")).rejects.toThrow(
      "Failed to stop 1 teammate: claude-reviewer: tmux refused",
    );
    expect(stopOrder).toEqual(["claude-reviewer", "claude-parent"]);
  });

  it("offlines a stale teammate runtime while stopping a primary agent", async () => {
    const parent = liveRuntime("claude-parent");
    const teammate = liveRuntime("claude-reviewer", "claude", {
      backendSessionId: "backend-reviewer",
      team: { teamId: "team-claude-parent", parentSessionId: "claude-parent", role: "reviewer" },
    });
    const host: any = {
      syncSessionsFromState: vi.fn(),
      sessions: [parent, teammate],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      sessionToolKeys: new Map([
        ["claude-parent", "claude"],
        ["claude-reviewer", "claude"],
      ]),
      sessionOriginalArgs: new Map(),
      sessionWorktreePaths: new Map([["claude-reviewer", repoRoot]]),
      getSessionLabel: vi.fn(() => undefined),
      deriveHeadline: vi.fn(() => undefined),
      isSessionRuntimeLive: vi.fn((session: any) => session.id !== "claude-reviewer"),
      evictZombieSession: vi.fn((session: any) => {
        host.sessions = host.sessions.filter((entry: any) => entry.id !== session.id);
      }),
      stopSessionToOffline: vi.fn((session: any) => session.kill()),
      saveState: vi.fn(),
    };

    await stopAgent(host, "claude-parent");

    expect(host.evictZombieSession).toHaveBeenCalledWith(teammate);
    expect(host.offlineSessions).toMatchObject([
      {
        id: "claude-reviewer",
        lifecycle: "offline",
        backendSessionId: "backend-reviewer",
        team: { parentSessionId: "claude-parent" },
      },
    ]);
    expect(host.stopSessionToOffline).toHaveBeenCalledWith(parent);
  });

  it("falls back to direct target open after readiness wait misses on fork", async () => {
    const target = { sessionName: "aimux-test", windowId: "@3", windowName: "claude" };
    const host: any = {
      syncSessionsFromState: vi.fn(),
      forkSessionFromSource: vi.fn(async () => ({
        sessionId: "claude-2",
        threadId: "thread-1",
        target,
      })),
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(async () => "missing"),
      openLiveTmuxWindowForEntry: vi.fn(),
      tmuxRuntimeManager: {
        openTarget: vi.fn(),
        isInsideTmux: vi.fn(() => false),
      },
    };

    const result = await forkAgent(host, {
      sourceSessionId: "claude-1",
      targetToolConfigKey: "claude",
    });

    expect(result).toEqual({ sessionId: "claude-2", threadId: "thread-1" });
    expect(host.forkSessionFromSource).toHaveBeenCalledWith("claude-1", "claude", undefined, undefined, undefined, []);
    expect(host.waitAndOpenLiveTmuxWindowForEntry).toHaveBeenCalledWith({ id: "claude-2" });
    expect(host.tmuxRuntimeManager.openTarget).toHaveBeenCalledWith(target, { insideTmux: false });
  });

  it("passes launch-specific extra args through fork", async () => {
    const host: any = {
      syncSessionsFromState: vi.fn(),
      forkSessionFromSource: vi.fn(async () => ({
        sessionId: "codex-2",
        threadId: "thread-1",
      })),
      waitAndOpenLiveTmuxWindowForEntry: vi.fn(),
      openLiveTmuxWindowForEntry: vi.fn(),
      tmuxRuntimeManager: {
        openTarget: vi.fn(),
        isInsideTmux: vi.fn(() => false),
      },
    };

    await forkAgent(host, {
      sourceSessionId: "claude-1",
      targetToolConfigKey: "codex",
      extraArgs: ["--dangerously-bypass-approvals-and-sandbox"],
      open: false,
    });

    expect(host.forkSessionFromSource).toHaveBeenCalledWith("claude-1", "codex", undefined, undefined, undefined, [
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("graveyards a visible dashboard seed when offline state is missing", async () => {
    const host: any = {
      syncSessionsFromState: vi.fn(),
      sessions: [],
      offlineSessions: [],
      graveyardAfterStopSessionIds: new Set(),
      stoppingSessionIds: new Set(),
      graveyardSession: vi.fn((sessionId: string) => {
        host.offlineSessions = host.offlineSessions.filter((session: any) => session.id !== sessionId);
      }),
      saveState: vi.fn(),
    };

    const result = await sendAgentToGraveyard(host, "claude-stale", {
      id: "claude-stale",
      command: "claude",
      label: "claude",
      worktreePath: repoRoot,
    });

    expect(result).toEqual({ sessionId: "claude-stale", status: "graveyard", previousStatus: "offline" });
    expect(host.graveyardSession).toHaveBeenCalledWith(
      "claude-stale",
      expect.objectContaining({ id: "claude-stale", lifecycle: "offline" }),
    );
    expect(host.offlineSessions).toEqual([]);
  });

  it("stops a stale runtime by preserving offline state without waiting for exit", async () => {
    const runtime = {
      id: "claude-zombie",
      command: "claude",
      startTime: Date.parse("2026-05-01T00:00:00.000Z"),
      backendSessionId: "backend-1",
    };
    const host: any = {
      syncSessionsFromState: vi.fn(),
      sessions: [runtime],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      sessionToolKeys: new Map([["claude-zombie", "claude"]]),
      sessionOriginalArgs: new Map([["claude-zombie", ["--dangerously-skip-permissions"]]]),
      sessionWorktreePaths: new Map([["claude-zombie", repoRoot]]),
      getSessionLabel: vi.fn(() => "worker"),
      deriveHeadline: vi.fn(() => "previous work"),
      isSessionRuntimeLive: vi.fn(() => false),
      evictZombieSession: vi.fn((session: any) => {
        host.sessions = host.sessions.filter((entry: any) => entry.id !== session.id);
      }),
      stopSessionToOffline: vi.fn(),
      saveState: vi.fn(),
    };

    const result = await stopAgent(host, "claude-zombie");

    expect(result).toEqual({ sessionId: "claude-zombie", status: "offline" });
    expect(host.stopSessionToOffline).not.toHaveBeenCalled();
    expect(host.evictZombieSession).toHaveBeenCalledWith(runtime);
    expect(host.offlineSessions).toMatchObject([
      {
        id: "claude-zombie",
        command: "claude",
        toolConfigKey: "claude",
        lifecycle: "offline",
        backendSessionId: "backend-1",
        label: "worker",
        headline: "previous work",
        worktreePath: repoRoot,
      },
    ]);
  });

  it("stops a stale runtime with a durable metadata backend id when runtime missed it", async () => {
    recordSessionBackendSessionIdMetadata("claude-racy-zombie", "backend-racy", repoRoot);
    const runtime = {
      id: "claude-racy-zombie",
      command: "claude",
      startTime: Date.parse("2026-05-01T00:00:00.000Z"),
    };
    const host: any = {
      syncSessionsFromState: vi.fn(),
      sessions: [runtime],
      offlineSessions: [],
      stoppingSessionIds: new Set(),
      sessionToolKeys: new Map([["claude-racy-zombie", "claude"]]),
      sessionOriginalArgs: new Map([["claude-racy-zombie", []]]),
      sessionWorktreePaths: new Map([["claude-racy-zombie", repoRoot]]),
      getSessionLabel: vi.fn(() => undefined),
      deriveHeadline: vi.fn(() => undefined),
      isSessionRuntimeLive: vi.fn(() => false),
      evictZombieSession: vi.fn((session: any) => {
        host.sessions = host.sessions.filter((entry: any) => entry.id !== session.id);
      }),
      stopSessionToOffline: vi.fn(),
      saveState: vi.fn(),
    };

    await stopAgent(host, "claude-racy-zombie");

    expect(host.offlineSessions).toMatchObject([
      {
        id: "claude-racy-zombie",
        lifecycle: "offline",
        backendSessionId: "backend-racy",
      },
    ]);
  });

  it("graveyards a stale runtime without waiting on a dead tmux window", async () => {
    const runtime = {
      id: "codex-zombie",
      command: "codex",
      startTime: Date.parse("2026-05-01T00:00:00.000Z"),
      backendSessionId: "backend-2",
    };
    const host: any = {
      syncSessionsFromState: vi.fn(),
      sessions: [runtime],
      offlineSessions: [],
      graveyardAfterStopSessionIds: new Set(),
      stoppingSessionIds: new Set(),
      sessionToolKeys: new Map([["codex-zombie", "codex"]]),
      sessionOriginalArgs: new Map([["codex-zombie", []]]),
      sessionWorktreePaths: new Map([["codex-zombie", repoRoot]]),
      getSessionLabel: vi.fn(() => "codex"),
      deriveHeadline: vi.fn(() => "summary"),
      isSessionRuntimeLive: vi.fn(() => false),
      evictZombieSession: vi.fn((session: any) => {
        host.sessions = host.sessions.filter((entry: any) => entry.id !== session.id);
      }),
      stopSessionToOffline: vi.fn(),
      graveyardSession: vi.fn((sessionId: string) => {
        host.offlineSessions = host.offlineSessions.filter((session: any) => session.id !== sessionId);
      }),
      saveState: vi.fn(),
    };

    const result = await sendAgentToGraveyard(host, "codex-zombie");

    expect(result).toEqual({ sessionId: "codex-zombie", status: "graveyard", previousStatus: "offline" });
    expect(host.stopSessionToOffline).not.toHaveBeenCalled();
    expect(host.evictZombieSession).toHaveBeenCalledWith(runtime);
    expect(host.graveyardSession).toHaveBeenCalledWith(
      "codex-zombie",
      expect.objectContaining({ id: "codex-zombie", backendSessionId: "backend-2", lifecycle: "offline" }),
    );
    expect(host.graveyardAfterStopSessionIds.has("codex-zombie")).toBe(false);
    expect(host.offlineSessions).toEqual([]);
  });

  it("graveyards a stale runtime with a durable metadata backend id when runtime missed it", async () => {
    recordSessionBackendSessionIdMetadata("codex-racy-zombie", "backend-racy", repoRoot);
    const runtime = {
      id: "codex-racy-zombie",
      command: "codex",
      startTime: Date.parse("2026-05-01T00:00:00.000Z"),
    };
    const host: any = {
      syncSessionsFromState: vi.fn(),
      sessions: [runtime],
      offlineSessions: [],
      graveyardAfterStopSessionIds: new Set(),
      stoppingSessionIds: new Set(),
      sessionToolKeys: new Map([["codex-racy-zombie", "codex"]]),
      sessionOriginalArgs: new Map([["codex-racy-zombie", []]]),
      sessionWorktreePaths: new Map([["codex-racy-zombie", repoRoot]]),
      getSessionLabel: vi.fn(() => undefined),
      deriveHeadline: vi.fn(() => undefined),
      isSessionRuntimeLive: vi.fn(() => false),
      evictZombieSession: vi.fn((session: any) => {
        host.sessions = host.sessions.filter((entry: any) => entry.id !== session.id);
      }),
      stopSessionToOffline: vi.fn(),
      graveyardSession: vi.fn((sessionId: string) => {
        host.offlineSessions = host.offlineSessions.filter((session: any) => session.id !== sessionId);
      }),
      saveState: vi.fn(),
    };

    await sendAgentToGraveyard(host, "codex-racy-zombie");

    expect(host.graveyardSession).toHaveBeenCalledWith(
      "codex-racy-zombie",
      expect.objectContaining({ id: "codex-racy-zombie", backendSessionId: "backend-racy", lifecycle: "offline" }),
    );
    expect(host.offlineSessions).toEqual([]);
  });
});
