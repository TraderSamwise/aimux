import { describe, expect, it, vi } from "vitest";
import { buildDashboardSessions } from "./session-registry.js";

describe("buildDashboardSessions", () => {
  it("dedupes duplicate local sessions by session id and backend session id", () => {
    const sessions = buildDashboardSessions({
      sessions: [
        {
          id: "claude-abc123",
          command: "claude",
          backendSessionId: "backend-1",
          status: "running",
        },
        {
          id: "claude-abc123",
          command: "claude",
          backendSessionId: "backend-1",
          status: "running",
        },
      ],
      activeIndex: 0,
      offlineSessions: [],
      remoteInstances: [],
      getSessionLabel: vi.fn(() => "claude"),
      getSessionHeadline: vi.fn(() => undefined),
      getSessionTaskDescription: vi.fn(() => undefined),
      getSessionRole: vi.fn(() => "coder"),
      getSessionContext: vi.fn(() => undefined),
      getSessionDerived: vi.fn(() => undefined),
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe("claude-abc123");
  });

  it("hides sessions attached to graveyarded worktrees", () => {
    const sessions = buildDashboardSessions({
      sessions: [
        {
          id: "claude-hidden",
          command: "claude",
          status: "running",
          worktreePath: "/repo/.aimux/worktrees/hidden",
        },
        {
          id: "claude-visible",
          command: "claude",
          status: "running",
          worktreePath: "/repo/.aimux/worktrees/visible",
        },
      ],
      activeIndex: 0,
      offlineSessions: [
        {
          id: "codex-hidden",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          worktreePath: "/repo/.aimux/worktrees/hidden",
        },
      ],
      remoteInstances: [],
      hiddenWorktreePaths: new Set(["/repo/.aimux/worktrees/hidden"]),
      getSessionLabel: vi.fn(() => undefined),
      getSessionHeadline: vi.fn(() => undefined),
      getSessionTaskDescription: vi.fn(() => undefined),
      getSessionRole: vi.fn(() => undefined),
      getSessionContext: vi.fn(() => undefined),
      getSessionDerived: vi.fn(() => undefined),
    });

    expect(sessions.map((session) => session.id)).toEqual(["claude-visible"]);
  });
});
