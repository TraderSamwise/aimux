import { describe, expect, it } from "vitest";
import {
  buildDashboardSessions,
  getRemoteOwnedSessionKeys,
  orderDashboardSessionsByVisualWorktree,
} from "./dashboard-session-registry.js";
import type { SessionState } from "./multiplexer.js";
import type { InstanceInfo } from "./instance-registry.js";

describe("dashboard-session-registry", () => {
  it("builds dashboard sessions with remote and offline dedupe", () => {
    const offlineSessions: SessionState[] = [
      {
        id: "offline-1",
        tool: "claude",
        toolConfigKey: "claude",
        command: "claude",
        args: [],
        backendSessionId: "backend-offline",
        label: "offline claude",
      },
      {
        id: "offline-dup",
        tool: "codex",
        toolConfigKey: "codex",
        command: "codex",
        args: [],
        backendSessionId: "backend-1",
      },
    ];

    const remoteInstances: InstanceInfo[] = [
      {
        instanceId: "other-1",
        pid: 123,
        startedAt: "2026-03-30T00:00:00.000Z",
        heartbeat: "2026-03-30T00:00:00.000Z",
        cwd: "/tmp",
        sessions: [
          { id: "remote-1", tool: "codex", backendSessionId: "backend-remote", worktreePath: "/repo/w1" },
          { id: "local-1", tool: "codex" },
        ],
      },
    ];

    const sessions = buildDashboardSessions({
      sessions: [
        {
          id: "local-1",
          command: "codex",
          backendSessionId: "backend-1",
          status: "running",
          worktreePath: "/repo",
        },
      ],
      activeIndex: 0,
      offlineSessions,
      remoteInstances,
      mainRepoPath: "/repo",
      isServerSession: () => false,
      getSessionLabel: (id) => (id === "local-1" ? "primary" : undefined),
      getSessionHeadline: () => undefined,
      getSessionTaskDescription: () => undefined,
      getSessionRole: () => undefined,
      getSessionContext: () => undefined,
      getSessionDerived: () => undefined,
    });

    expect(sessions.map((session) => session.id)).toEqual(["local-1", "remote-1", "offline-1"]);
    expect(sessions[0].worktreePath).toBeUndefined();
    expect(sessions[1].remoteInstanceId).toBe("other-1");
    expect(sessions[2].status).toBe("offline");
    expect(sessions[2].label).toBe("offline claude");
  });

  it("orders sessions by visual worktree order", () => {
    const ordered = orderDashboardSessionsByVisualWorktree(
      [
        { index: 0, id: "w2", command: "codex", status: "running", active: false, worktreePath: "/repo/w2" },
        { index: 1, id: "main", command: "claude", status: "idle", active: true, worktreePath: undefined },
        { index: 2, id: "w1", command: "codex", status: "running", active: false, worktreePath: "/repo/w1" },
      ],
      [undefined, "/repo/w1", "/repo/w2"],
      "/repo",
    );

    expect(ordered.map((session) => session.id)).toEqual(["main", "w1", "w2"]);
  });

  it("collects remote owned session keys", () => {
    const owned = getRemoteOwnedSessionKeys([
      {
        instanceId: "other-1",
        pid: 123,
        startedAt: "2026-03-30T00:00:00.000Z",
        heartbeat: "2026-03-30T00:00:00.000Z",
        cwd: "/tmp",
        sessions: [
          { id: "remote-1", tool: "codex", backendSessionId: "backend-1" },
          { id: "remote-2", tool: "claude" },
        ],
      },
    ]);

    expect(owned).toEqual(new Set(["remote-1", "backend-1", "remote-2"]));
  });
});
