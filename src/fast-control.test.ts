import { describe, expect, it, vi } from "vitest";
import {
  listSwitchableAgentItems,
  listSwitchableAgentMenuItems,
  resolveAttentionAgent,
  resolveNextAgent,
  resolvePrevAgent,
} from "./fast-control.js";
import { TmuxRuntimeManager } from "./tmux-runtime-manager.js";

vi.mock("./worktree.js", () => ({
  listWorktrees: vi.fn(() => [{ path: "/repo" }, { path: "/repo/.aimux/worktrees/tealchart-cleanup-11" }]),
}));

describe("fast-control worktree scoping", () => {
  it("uses current window metadata worktree when cwd is outside the worktree", () => {
    const tmux = {
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo-abc" })),
      listManagedWindows: vi.fn(() => [
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@593", windowIndex: 4, windowName: "claude" },
          metadata: {
            sessionId: "claude-a",
            label: "Claude",
            command: "claude",
            worktreePath: "/repo/.aimux/worktrees/tealchart-cleanup-11",
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@594", windowIndex: 5, windowName: "codex" },
          metadata: {
            sessionId: "codex-b",
            label: "Codex",
            command: "codex",
            worktreePath: "/repo/.aimux/worktrees/tealchart-cleanup-11",
          },
        },
      ]),
      isWindowAlive: vi.fn(() => true),
      listWindows: vi.fn(() => [
        { id: "@593", index: 4, name: "claude", active: true },
        { id: "@594", index: 5, name: "codex", active: false },
      ]),
    } as unknown as TmuxRuntimeManager;

    const items = listSwitchableAgentItems(
      {
        projectRoot: "/repo",
        currentClientSession: "aimux-repo-abc-client-123",
        currentWindow: "claude",
        currentWindowId: "@593",
        currentPath: "/private/tmp/tealstreet-pr5180",
      },
      tmux,
    );

    expect(items.map((item) => item.target.windowId)).toEqual(["@593", "@594"]);
  });

  it("keeps unlinked worktree candidates after client-session ordering", () => {
    const tmux = {
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo-abc" })),
      listManagedWindows: vi.fn(() => [
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@596", windowIndex: 1, windowName: "claude" },
          metadata: {
            sessionId: "claude-a",
            label: "Claude",
            command: "claude",
            worktreePath: "/private/tmp/tealstreet-pr5180",
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@597", windowIndex: 4, windowName: "codex" },
          metadata: {
            sessionId: "codex-b",
            label: "Codex",
            command: "codex",
            worktreePath: "/private/tmp/tealstreet-pr5180",
          },
        },
      ]),
      isWindowAlive: vi.fn(() => true),
      listWindows: vi.fn(() => [
        { id: "@595", index: 0, name: "dashboard-77a017bd", active: false },
        { id: "@596", index: 3, name: "claude", active: true },
      ]),
    } as unknown as TmuxRuntimeManager;

    const items = listSwitchableAgentItems(
      {
        projectRoot: "/repo",
        currentClientSession: "aimux-repo-abc-client-123",
        currentWindow: "claude",
        currentWindowId: "@596",
        currentPath: "/private/tmp/tealstreet-pr5180",
      },
      tmux,
    );

    expect(items.map((item) => item.target.windowId)).toEqual(["@596", "@597"]);
  });

  it("orders menu items by true MRU recency", () => {
    const tmux = {
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo-abc" })),
      listManagedWindows: vi.fn(() => [
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@1", windowIndex: 1, windowName: "claude" },
          metadata: {
            sessionId: "claude-a",
            label: "Claude A",
            command: "claude",
            worktreePath: "/repo/wt",
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@2", windowIndex: 2, windowName: "codex" },
          metadata: {
            sessionId: "codex-b",
            label: "Codex B",
            command: "codex",
            worktreePath: "/repo/wt",
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@3", windowIndex: 3, windowName: "claude" },
          metadata: {
            sessionId: "claude-c",
            label: "Claude C",
            command: "claude",
            worktreePath: "/repo/wt",
          },
        },
      ]),
      isWindowAlive: vi.fn(() => true),
      listWindows: vi.fn().mockImplementation((sessionName: string) =>
        sessionName === "aimux-repo-abc"
          ? [
              { id: "@1", index: 1, name: "claude", active: true, activity: 100 },
              { id: "@2", index: 2, name: "codex", active: false, activity: 90 },
              { id: "@3", index: 3, name: "claude", active: false, activity: 80 },
            ]
          : [
              { id: "@1", index: 1, name: "claude", active: true, activity: 100 },
              { id: "@2", index: 2, name: "codex", active: false, activity: 90 },
              { id: "@3", index: 3, name: "claude", active: false, activity: 80 },
            ],
      ),
    } as unknown as TmuxRuntimeManager;

    const items = listSwitchableAgentMenuItems(
      {
        projectRoot: "/repo",
        currentClientSession: "aimux-repo-abc-client-123",
        currentWindow: "claude",
        currentWindowId: "@1",
        currentPath: "/repo/wt",
      },
      tmux,
    );

    expect(items.map((item) => item.target.windowId)).toEqual(["@1", "@2", "@3"]);
  });

  it("renders compact switch labels for autogenerated agent names and services", () => {
    const tmux = {
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo-abc" })),
      listManagedWindows: vi.fn(() => [
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@1", windowIndex: 1, windowName: "claude" },
          metadata: {
            kind: "agent",
            sessionId: "claude-zjlduv",
            label: "claude-zjlduv",
            role: "coder",
            command: "claude",
            worktreePath: "/repo/wt",
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@2", windowIndex: 2, windowName: "shell" },
          metadata: {
            kind: "service",
            sessionId: "shell-1",
            label: "shell",
            command: "shell",
            worktreePath: "/repo/wt",
          },
        },
      ]),
      isWindowAlive: vi.fn(() => true),
      listWindows: vi.fn(() => [
        { id: "@1", index: 1, name: "claude", active: true, activity: 100 },
        { id: "@2", index: 2, name: "shell", active: false, activity: 90 },
      ]),
    } as unknown as TmuxRuntimeManager;

    const items = listSwitchableAgentItems(
      {
        projectRoot: "/repo",
        currentClientSession: "aimux-repo-abc-client-123",
        currentWindow: "claude",
        currentWindowId: "@1",
        currentPath: "/repo/wt",
      },
      tmux,
    );

    expect(items.map((item) => item.label)).toEqual(["claude(coder)", "shell[svc]"]);
  });

  it("keeps root navigation out of teammate windows in the same worktree", () => {
    const tmux = {
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo-abc" })),
      listManagedWindows: vi.fn(() => [
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@1", windowIndex: 1, windowName: "parent" },
          metadata: {
            kind: "agent",
            sessionId: "parent",
            label: "parent",
            command: "claude",
            worktreePath: "/repo/wt",
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@2", windowIndex: 2, windowName: "reviewer" },
          metadata: {
            kind: "agent",
            sessionId: "reviewer",
            label: "reviewer",
            command: "codex",
            worktreePath: "/repo/wt",
            team: { teamId: "team-parent", parentSessionId: "parent", role: "reviewer", order: 1 },
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@3", windowIndex: 3, windowName: "shell" },
          metadata: {
            kind: "service",
            sessionId: "shell-1",
            label: "shell",
            command: "shell",
            worktreePath: "/repo/wt",
          },
        },
      ]),
      isWindowAlive: vi.fn(() => true),
      listWindows: vi.fn(() => [
        { id: "@1", index: 1, name: "parent", active: true, activity: 100 },
        { id: "@2", index: 2, name: "reviewer", active: false, activity: 90 },
        { id: "@3", index: 3, name: "shell", active: false, activity: 80 },
      ]),
    } as unknown as TmuxRuntimeManager;

    const context = {
      projectRoot: "/repo",
      currentClientSession: "aimux-repo-abc-client-123",
      currentWindow: "parent",
      currentWindowId: "@1",
      currentPath: "/repo/wt",
    };

    const items = listSwitchableAgentItems(context, tmux);
    expect(items.map((item) => item.target.windowId)).toEqual(["@1", "@3"]);
    expect(resolveNextAgent(context, tmux)?.target.windowId).toBe("@3");
    expect(resolvePrevAgent(context, tmux)?.target.windowId).toBe("@3");
  });

  it("cycles only direct teammates after entering teammate land", () => {
    const tmux = {
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo-abc" })),
      listManagedWindows: vi.fn(() => [
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@1", windowIndex: 1, windowName: "parent" },
          metadata: {
            kind: "agent",
            sessionId: "parent",
            label: "parent",
            command: "claude",
            worktreePath: "/repo/wt",
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@2", windowIndex: 4, windowName: "implementer" },
          metadata: {
            kind: "agent",
            sessionId: "implementer",
            label: "implementer",
            command: "codex",
            worktreePath: "/repo/other",
            team: { teamId: "team-parent", parentSessionId: "parent", role: "coder", order: 2 },
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@3", windowIndex: 3, windowName: "reviewer" },
          metadata: {
            kind: "agent",
            sessionId: "reviewer",
            label: "reviewer",
            command: "codex",
            worktreePath: "/repo/wt",
            team: { teamId: "team-parent", parentSessionId: "parent", role: "reviewer", order: 1 },
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@4", windowIndex: 2, windowName: "other-team" },
          metadata: {
            kind: "agent",
            sessionId: "other-team",
            label: "other-team",
            command: "codex",
            worktreePath: "/repo/wt",
            team: { teamId: "team-other", parentSessionId: "other-parent", role: "coder", order: 0 },
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@5", windowIndex: 5, windowName: "shell" },
          metadata: {
            kind: "service",
            sessionId: "shell-1",
            label: "shell",
            command: "shell",
            worktreePath: "/repo/wt",
          },
        },
      ]),
      isWindowAlive: vi.fn(() => true),
      listWindows: vi.fn(() => [
        { id: "@1", index: 1, name: "parent", active: false, activity: 100 },
        { id: "@2", index: 4, name: "implementer", active: true, activity: 90 },
        { id: "@3", index: 3, name: "reviewer", active: false, activity: 80 },
        { id: "@4", index: 2, name: "other-team", active: false, activity: 70 },
        { id: "@5", index: 5, name: "shell", active: false, activity: 60 },
      ]),
    } as unknown as TmuxRuntimeManager;

    const context = {
      projectRoot: "/repo",
      currentClientSession: "aimux-repo-abc-client-123",
      currentWindow: "implementer",
      currentWindowId: "@2",
      currentPath: "/repo/other",
    };

    const items = listSwitchableAgentItems(context, tmux);
    expect(items.map((item) => item.target.windowId)).toEqual(["@3", "@2"]);
    expect(resolveNextAgent(context, tmux)?.target.windowId).toBe("@3");
    expect(resolvePrevAgent(context, tmux)?.target.windowId).toBe("@3");
  });

  it("uses a dead current teammate window only for teammate scoping", () => {
    const tmux = {
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo-abc" })),
      listManagedWindows: vi.fn(() => [
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@1", windowIndex: 1, windowName: "parent" },
          metadata: {
            kind: "agent",
            sessionId: "parent",
            label: "parent",
            command: "claude",
            worktreePath: "/repo/wt",
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@2", windowIndex: 2, windowName: "dead-coder" },
          metadata: {
            kind: "agent",
            sessionId: "dead-coder",
            label: "dead-coder",
            command: "codex",
            worktreePath: "/repo/wt",
            team: { teamId: "team-parent", parentSessionId: "parent", role: "coder", order: 1 },
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@3", windowIndex: 3, windowName: "reviewer" },
          metadata: {
            kind: "agent",
            sessionId: "reviewer",
            label: "reviewer",
            command: "codex",
            worktreePath: "/repo/other",
            team: { teamId: "team-parent", parentSessionId: "parent", role: "reviewer", order: 2 },
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@4", windowIndex: 4, windowName: "other-team" },
          metadata: {
            kind: "agent",
            sessionId: "other-team",
            label: "other-team",
            command: "codex",
            worktreePath: "/repo/wt",
            team: { teamId: "team-other", parentSessionId: "other-parent", role: "coder", order: 1 },
          },
        },
      ]),
      isWindowAlive: vi.fn((target) => target.windowId !== "@2"),
      listWindows: vi.fn(() => [
        { id: "@1", index: 1, name: "parent", active: false, activity: 100 },
        { id: "@2", index: 2, name: "dead-coder", active: true, activity: 90 },
        { id: "@3", index: 3, name: "reviewer", active: false, activity: 80 },
        { id: "@4", index: 4, name: "other-team", active: false, activity: 70 },
      ]),
    } as unknown as TmuxRuntimeManager;

    const context = {
      projectRoot: "/repo",
      currentClientSession: "aimux-repo-abc-client-123",
      currentWindow: "dead-coder",
      currentWindowId: "@2",
      currentPath: "/repo/wt",
    };

    const items = listSwitchableAgentItems(context, tmux);
    expect(items.map((item) => item.target.windowId)).toEqual(["@3"]);
    expect(resolveNextAgent(context, tmux)?.target.windowId).toBe("@3");
    expect(resolvePrevAgent(context, tmux)?.target.windowId).toBe("@3");
  });

  it("excludes dead managed windows from switch controls", () => {
    const tmux = {
      getProjectSession: vi.fn(() => ({ sessionName: "aimux-repo-abc" })),
      listManagedWindows: vi.fn(() => [
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@1", windowIndex: 1, windowName: "claude" },
          metadata: {
            kind: "agent",
            sessionId: "claude-a",
            label: "Claude A",
            command: "claude",
            worktreePath: "/repo/wt",
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@2", windowIndex: 2, windowName: "codex" },
          metadata: {
            kind: "agent",
            sessionId: "codex-b",
            label: "Codex B",
            command: "codex",
            worktreePath: "/repo/wt",
          },
        },
        {
          target: { sessionName: "aimux-repo-abc", windowId: "@3", windowIndex: 3, windowName: "claude" },
          metadata: {
            kind: "agent",
            sessionId: "claude-c",
            label: "Claude C",
            command: "claude",
            worktreePath: "/repo/wt",
          },
        },
      ]),
      isWindowAlive: vi.fn((target) => target.windowId !== "@2"),
      listWindows: vi.fn(() => [
        { id: "@1", index: 1, name: "claude", active: true, activity: 100 },
        { id: "@2", index: 2, name: "codex", active: false, activity: 90 },
        { id: "@3", index: 3, name: "claude", active: false, activity: 80 },
      ]),
    } as unknown as TmuxRuntimeManager;

    const context = {
      projectRoot: "/repo",
      currentClientSession: "aimux-repo-abc-client-123",
      currentWindow: "claude",
      currentWindowId: "@1",
      currentPath: "/repo/wt",
    };

    expect(listSwitchableAgentItems(context, tmux).map((item) => item.target.windowId)).toEqual(["@1", "@3"]);
    expect(listSwitchableAgentMenuItems(context, tmux).map((item) => item.target.windowId)).toEqual(["@1", "@3"]);
    expect(resolveNextAgent(context, tmux)?.target.windowId).toBe("@3");
    expect(resolvePrevAgent(context, tmux)?.target.windowId).toBe("@3");
    expect(resolveAttentionAgent(context, tmux)).toBeNull();
  });
});
