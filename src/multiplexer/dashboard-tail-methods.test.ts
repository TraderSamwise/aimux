import { describe, expect, it, vi } from "vitest";

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

describe("dashboard lifecycle adapter", () => {
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
        extraArgs: ["--profile", "test"],
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
        extraArgs: ["--fast"],
      }),
    ).resolves.toEqual({ sessionId: "codex-fork", threadId: "thread-1" });

    expect(host.forkSessionFromSource).toHaveBeenCalledWith(
      "codex-parent",
      "codex",
      "codex-child",
      "continue",
      "/repo/wt",
      ["--fast"],
    );
    expect(host.openLiveTmuxWindowForEntry).toHaveBeenCalledWith({ id: "codex-fork" });
  });

  it("delegates rename, stop, graveyard, and migrate operations to multiplexer methods", async () => {
    const runtime = { id: "claude-1" };
    const host: any = {
      sessions: [runtime],
      updateSessionLabel: vi.fn(),
      stopSessionToOffline: vi.fn(),
      graveyardSession: vi.fn(),
      migrateAgent: vi.fn(),
    };

    await expect(dashboardTailMethods.renameAgent.call(host, "claude-1", "  New label  ")).resolves.toEqual({
      sessionId: "claude-1",
      label: "New label",
    });
    await expect(dashboardTailMethods.stopAgent.call(host, "claude-1")).resolves.toEqual({
      sessionId: "claude-1",
      status: "offline",
    });
    await expect(dashboardTailMethods.sendAgentToGraveyard.call(host, "claude-1")).resolves.toEqual({
      sessionId: "claude-1",
      status: "graveyard",
      previousStatus: "running",
    });
    await expect(dashboardTailMethods.migrateAgentSession.call(host, "claude-1", "/repo/next")).resolves.toEqual({
      sessionId: "claude-1",
      worktreePath: "/repo/next",
    });

    expect(host.updateSessionLabel).toHaveBeenCalledWith("claude-1", "  New label  ");
    expect(host.stopSessionToOffline).toHaveBeenCalledWith(runtime);
    expect(host.graveyardSession).toHaveBeenCalledWith("claude-1");
    expect(host.migrateAgent).toHaveBeenCalledWith("claude-1", "/repo/next");
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
