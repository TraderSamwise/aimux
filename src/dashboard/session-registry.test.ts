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

  it("hides teammate sessions by default across local remote and offline sources", () => {
    const sessions = buildDashboardSessions({
      sessions: [
        {
          id: "claude-parent",
          command: "claude",
          status: "running",
        },
        {
          id: "claude-teammate-local",
          command: "claude",
          status: "running",
          team: { teamId: "team-1", parentSessionId: "claude-parent", role: "reviewer" },
        },
      ],
      activeIndex: 0,
      offlineSessions: [
        {
          id: "codex-teammate-offline",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          team: { teamId: "team-1", parentSessionId: "claude-parent", role: "coder" },
        },
      ],
      remoteInstances: [
        {
          instanceId: "remote-1",
          pid: 123,
          startedAt: "2026-05-01T00:00:00.000Z",
          heartbeat: "2026-05-01T00:00:01.000Z",
          cwd: "/repo",
          sessions: [
            {
              id: "claude-teammate-remote",
              tool: "claude",
              team: { teamId: "team-1", parentSessionId: "claude-parent", role: "explorer" },
            },
          ],
        },
      ],
      getSessionLabel: vi.fn(() => undefined),
      getSessionHeadline: vi.fn(() => undefined),
      getSessionTaskDescription: vi.fn(() => undefined),
      getSessionRole: vi.fn(() => undefined),
      getSessionContext: vi.fn(() => undefined),
      getSessionDerived: vi.fn(() => undefined),
    });

    expect(sessions.map((session) => session.id)).toEqual(["claude-parent"]);
  });

  it("can include teammate sessions and preserves teammate metadata", () => {
    const sessions = buildDashboardSessions({
      sessions: [
        {
          id: "claude-teammate-local",
          command: "claude",
          status: "running",
          team: { teamId: "team-1", parentSessionId: "claude-parent", role: "reviewer", order: 2 },
        },
      ],
      activeIndex: 0,
      offlineSessions: [],
      remoteInstances: [],
      includeTeammates: true,
      getSessionLabel: vi.fn(() => undefined),
      getSessionHeadline: vi.fn(() => undefined),
      getSessionTaskDescription: vi.fn(() => undefined),
      getSessionRole: vi.fn(() => undefined),
      getSessionContext: vi.fn(() => undefined),
      getSessionDerived: vi.fn(() => undefined),
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.team).toEqual({
      teamId: "team-1",
      parentSessionId: "claude-parent",
      role: "reviewer",
      order: 2,
    });
  });
});
