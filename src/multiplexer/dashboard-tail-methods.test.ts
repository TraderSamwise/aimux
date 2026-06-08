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

import { agentIoMethods } from "./agent-io-methods.js";
import { dashboardTailMethods } from "./dashboard-tail-methods.js";
import { initPaths } from "../paths.js";
import { listTopologySessionStates, upsertTopologySession } from "../runtime-core/topology-sessions.js";

describe("dashboard lifecycle adapter", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-dashboard-tail-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("spawns an agent through the multiplexer session factory", async () => {
    const host: any = {
      createSession: vi.fn(() => ({ id: "codex-new" })),
      generateDashboardSessionId: vi.fn(() => "codex-planned"),
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
    ).resolves.toEqual({ sessionId: "codex-new" });

    expect(host.generateDashboardSessionId).toHaveBeenCalledWith("codex");
    expect(host.createSession).toHaveBeenCalledWith(
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
    expect(host.openLiveTmuxWindowForEntry).toHaveBeenCalledWith({ id: "codex-new" });
  });

  it("creates teammate agents with team metadata and labels", async () => {
    const host: any = {
      createSession: vi.fn(() => ({ id: "claude-child" })),
      generateDashboardSessionId: vi.fn(() => "claude-planned"),
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
      sessionId: "claude-child",
      parentSessionId: "claude-parent",
      teamId: "team-claude-parent",
      role: "reviewer",
      label: "Review",
    });

    expect(host.createSession).toHaveBeenCalledWith(
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
    );
    expect(host.applySessionLabel).toHaveBeenCalledWith("claude-child", "Review");
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

  it("moves live agents to offline through topology and kills the live runtime", async () => {
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
    expect(runtime.kill).toHaveBeenCalledOnce();
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

  it("refuses to stop live topology agents that are not owned by this runtime", async () => {
    upsertTopologySession(
      {
        id: "codex-live",
        command: "codex",
        tool: "codex",
        toolConfigKey: "codex",
        args: [],
        lifecycle: "running",
        worktreePath: repoRoot,
      },
      "running",
    );
    const host: any = {
      sessions: [],
      offlineSessions: [],
    };

    await expect(dashboardTailMethods.stopAgent.call(host, "codex-live")).rejects.toThrow(
      'Session "codex-live" is live but not owned by this runtime',
    );

    expect(listTopologySessionStates({ statuses: ["running"] }).map((session) => session.id)).toEqual(["codex-live"]);
    expect(listTopologySessionStates({ statuses: ["offline"] })).toEqual([]);
  });

  it("refuses to graveyard live topology agents that are not owned by this runtime", async () => {
    upsertTopologySession(
      {
        id: "claude-live",
        command: "claude",
        tool: "claude",
        toolConfigKey: "claude",
        args: [],
        lifecycle: "idle",
        worktreePath: repoRoot,
      },
      "idle",
    );
    const host: any = {
      sessions: [],
      offlineSessions: [],
    };

    await expect(dashboardTailMethods.sendAgentToGraveyard.call(host, "claude-live")).rejects.toThrow(
      'Session "claude-live" is live but not owned by this runtime',
    );

    expect(listTopologySessionStates({ statuses: ["idle"] }).map((session) => session.id)).toEqual(["claude-live"]);
    expect(listTopologySessionStates({ statuses: ["graveyard"] })).toEqual([]);
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
