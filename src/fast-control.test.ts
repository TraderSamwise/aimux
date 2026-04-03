import { describe, expect, it, vi } from "vitest";
import { listSwitchableAgentItems } from "./fast-control.js";
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
});
