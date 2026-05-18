import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initPaths } from "../paths.js";
import { forkAgent, sendAgentToGraveyard, spawnAgent, stopAgent } from "./session-actions.js";

vi.mock("../config.js", () => ({
  loadConfig: () => ({
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
});
