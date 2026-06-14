import { describe, expect, it, vi } from "vitest";
import type { AimuxConfig } from "../config.js";
import type { FastControlContext } from "../fast-control.js";
import { listExposeAgentItems, resolveExposeScope } from "./expose-model.js";
import { TmuxRuntimeManager } from "./runtime-manager.js";

vi.mock("../worktree.js", () => ({
  listWorktrees: vi.fn(() => [{ path: "/repo" }, { path: "/repo/.aimux/worktrees/feat-x" }]),
}));

function config(forceGlobalScope: boolean): AimuxConfig {
  return { expose: { forceGlobalScope } } as AimuxConfig;
}

function tmuxWithAgentsInTwoWorktrees(): TmuxRuntimeManager {
  return {
    getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo-abc" })),
    listManagedWindows: vi.fn(() => [
      {
        target: { sessionName: "aimux-repo-abc", windowId: "@1", windowIndex: 1, windowName: "claude" },
        metadata: { sessionId: "main-agent", label: "Main", command: "claude", worktreePath: "/repo" },
      },
      {
        target: { sessionName: "aimux-repo-abc", windowId: "@2", windowIndex: 2, windowName: "codex" },
        metadata: {
          sessionId: "wt-agent",
          label: "Worktree",
          command: "codex",
          worktreePath: "/repo/.aimux/worktrees/feat-x",
        },
      },
    ]),
    listWindows: vi.fn(() => [
      { id: "@1", index: 1, name: "claude", active: false },
      { id: "@2", index: 2, name: "codex", active: true },
    ]),
  } as unknown as TmuxRuntimeManager;
}

describe("resolveExposeScope", () => {
  const insideAgent: FastControlContext = {
    projectRoot: "/repo",
    currentWindow: "codex",
    currentWindowId: "@2",
  };

  it("returns 'all' when forceGlobalScope is enabled, even inside an agent", () => {
    expect(resolveExposeScope(insideAgent, config(true))).toBe("all");
  });

  it("returns 'all' on the dashboard window", () => {
    expect(
      resolveExposeScope({ projectRoot: "/repo", currentWindow: "dashboard", currentWindowId: "@9" }, config(false)),
    ).toBe("all");
  });

  it("returns 'all' when there is no current window id", () => {
    expect(resolveExposeScope({ projectRoot: "/repo", currentWindow: "codex" }, config(false))).toBe("all");
  });

  it("returns 'worktree' inside an agent window", () => {
    expect(resolveExposeScope(insideAgent, config(false))).toBe("worktree");
  });
});

describe("listExposeAgentItems", () => {
  it("scopes to the current agent's worktree by default", () => {
    const result = listExposeAgentItems(
      { projectRoot: "/repo", currentWindow: "codex", currentWindowId: "@2" },
      config(false),
      tmuxWithAgentsInTwoWorktrees(),
    );
    expect(result.scope).toBe("worktree");
    expect(result.items.map((item) => item.id)).toEqual(["wt-agent"]);
  });

  it("includes agents from every worktree when scope is global", () => {
    const result = listExposeAgentItems(
      { projectRoot: "/repo", currentWindow: "codex", currentWindowId: "@2" },
      config(true),
      tmuxWithAgentsInTwoWorktrees(),
    );
    expect(result.scope).toBe("all");
    expect(result.items.map((item) => item.id).sort()).toEqual(["main-agent", "wt-agent"]);
  });

  it("force-global ignores teammate-window narrowing", () => {
    const tmux = {
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo-abc" })),
      listManagedWindows: vi.fn(() => [
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@1", windowIndex: 1, windowName: "claude" },
          metadata: { sessionId: "main-agent", label: "Main", command: "claude", worktreePath: "/repo" },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@2", windowIndex: 2, windowName: "codex" },
          metadata: {
            sessionId: "wt-agent",
            label: "Worktree",
            command: "codex",
            worktreePath: "/repo/.aimux/worktrees/feat-x",
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@3", windowIndex: 3, windowName: "claude" },
          metadata: {
            sessionId: "teammate",
            label: "Teammate",
            command: "claude",
            worktreePath: "/repo",
            team: { parentSessionId: "main-agent" },
          },
        },
      ]),
      listWindows: vi.fn(() => [
        { id: "@1", index: 1, name: "claude", active: false },
        { id: "@2", index: 2, name: "codex", active: false },
        { id: "@3", index: 3, name: "claude", active: true },
      ]),
    } as unknown as TmuxRuntimeManager;

    const result = listExposeAgentItems(
      { projectRoot: "/repo", currentWindow: "claude", currentWindowId: "@3" },
      config(true),
      tmux,
    );
    expect(result.scope).toBe("all");
    expect(result.items.map((item) => item.id).sort()).toEqual(["main-agent", "wt-agent"]);
  });
});
