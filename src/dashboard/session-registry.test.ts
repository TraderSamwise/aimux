import { describe, expect, it, vi } from "vitest";
import { buildDashboardSessions, selectDashboardTeammates } from "./session-registry.js";

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

  it("hides teammate sessions by default across local and offline sources", () => {
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
        {
          id: "codex-teammate-pending",
          command: "codex",
          status: "waiting",
          pendingAction: "creating",
          optimistic: true,
          team: { teamId: "team-1", parentSessionId: "claude-parent", role: "coder" },
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

describe("selectDashboardTeammates", () => {
  it("returns only the selected parent teammates in stable team order", () => {
    const sessions = [
      {
        index: 0,
        id: "parent-a",
        command: "claude",
        status: "running" as const,
        active: true,
      },
      {
        index: 1,
        id: "child-late",
        command: "codex",
        status: "running" as const,
        active: false,
        createdAt: "2026-05-01T00:00:10.000Z",
        team: { teamId: "team-a", parentSessionId: "parent-a", role: "reviewer" },
      },
      {
        index: 2,
        id: "child-first",
        command: "claude",
        status: "offline" as const,
        active: false,
        createdAt: "2026-05-01T00:00:20.000Z",
        team: { teamId: "team-a", parentSessionId: "parent-a", role: "coder", order: 1 },
      },
      {
        index: 3,
        id: "child-early",
        command: "claude",
        status: "running" as const,
        active: false,
        createdAt: "2026-05-01T00:00:01.000Z",
        team: { teamId: "team-a", parentSessionId: "parent-a", role: "explorer" },
      },
      {
        index: 4,
        id: "other-child",
        command: "codex",
        status: "running" as const,
        active: false,
        team: { teamId: "team-b", parentSessionId: "parent-b", role: "coder" },
      },
    ];

    const teammates = selectDashboardTeammates(sessions, sessions[0]);

    expect(teammates.map((session) => session.id)).toEqual(["child-first", "child-early", "child-late"]);
    expect(sessions[2]?.index).toBe(2);
    expect(teammates[0]?.index).toBe(0);
  });

  it("does not expose nested teammate teams", () => {
    const teammateParent = {
      index: 0,
      id: "teammate-parent",
      command: "claude",
      status: "running" as const,
      active: true,
      team: { teamId: "team-a", parentSessionId: "root", role: "coder" },
    };

    expect(
      selectDashboardTeammates(
        [
          teammateParent,
          {
            index: 1,
            id: "nested-child",
            command: "codex",
            status: "running",
            active: false,
            team: { teamId: "team-b", parentSessionId: "teammate-parent", role: "reviewer" },
          },
        ],
        teammateParent,
      ),
    ).toEqual([]);
  });
});
