import { describe, expect, it, vi } from "vitest";
import { listSwitchableAgentItems, listSwitchableAgentMenuItems } from "./fast-control.js";
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

  it("orders menu items by recency and starts on the next item instead of current", () => {
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

    expect(items.map((item) => item.target.windowId)).toEqual(["@2", "@1", "@3"]);
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
});
