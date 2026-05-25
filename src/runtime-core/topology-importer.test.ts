import { describe, expect, it } from "vitest";
import { buildRuntimeTopologyFromLegacyState } from "./topology-importer.js";

describe("buildRuntimeTopologyFromLegacyState", () => {
  it("projects live, offline, teammate, binding, and task facts into one topology", () => {
    const now = "2026-05-25T00:00:00.000Z";
    const topology = buildRuntimeTopologyFromLegacyState({
      projectRoot: "/repo",
      projectId: "repo-123",
      now,
      liveSessions: [
        {
          id: "parent",
          command: "claude",
          status: "running",
          startTime: Date.parse(now),
        },
      ],
      offlineSessions: [
        {
          id: "child",
          command: "codex",
          lifecycle: "offline",
          team: {
            teamId: "team-parent",
            parentSessionId: "parent",
            role: "reviewer",
          },
        },
      ],
      tasks: [
        {
          id: "task-1",
          status: "pending",
          assignedBy: "parent",
          description: "Review work",
          prompt: "Review the diff",
          createdAt: now,
          updatedAt: now,
        },
      ],
      metadataSessions: {
        parent: { backendSessionId: "claude-backend" },
      },
      sessionToolKeys: new Map([
        ["parent", "claude"],
        ["child", "codex"],
      ]),
      sessionTmuxTargets: new Map([
        [
          "parent",
          {
            sessionName: "aimux-repo",
            windowId: "@1",
            windowIndex: 1,
            windowName: "claude",
          },
        ],
      ]),
    });

    expect(topology.rigs).toMatchObject([{ id: "rig-repo-123", projectRoot: "/repo" }]);
    expect(topology.nodes).toMatchObject([
      { id: "node-parent", logicalId: "parent", runtime: "claude" },
      { id: "node-child", logicalId: "child", role: "reviewer", runtime: "codex" },
    ]);
    expect(topology.sessions).toMatchObject([
      { id: "parent", nodeId: "node-parent", status: "running", backendSessionId: "claude-backend" },
      { id: "child", nodeId: "node-child", status: "offline" },
    ]);
    expect(topology.bindings).toMatchObject([{ id: "binding-parent", nodeId: "node-parent", tmuxWindowId: "@1" }]);
    expect(topology.edges).toMatchObject([
      {
        id: "edge-parent-delegates-child",
        sourceNodeId: "node-parent",
        targetNodeId: "node-child",
        kind: "delegates",
      },
    ]);
    expect(topology.queue).toMatchObject([{ id: "task-1", sourceSessionId: "parent", kind: "task" }]);
  });
});
