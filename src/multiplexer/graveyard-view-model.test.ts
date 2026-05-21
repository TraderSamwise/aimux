import { describe, expect, it } from "vitest";
import { buildGraveyardViewModel } from "./graveyard-view-model.js";

describe("buildGraveyardViewModel", () => {
  it("uses one selectable action model while displaying attached worktree agents and services", () => {
    const view = buildGraveyardViewModel({
      worktrees: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          branch: "demo",
          graveyardedAt: "2026-05-01T00:00:00.000Z",
          agents: [
            {
              id: "codex-1",
              tool: "codex",
              toolConfigKey: "codex",
              command: "codex",
              args: [],
              worktreePath: "/repo/.aimux/worktrees/demo",
            },
          ],
          services: [
            {
              id: "service-1",
              label: "shell",
              worktreePath: "/repo/.aimux/worktrees/demo",
            },
          ],
        },
      ],
      agents: [
        {
          id: "claude-1",
          tool: "claude",
          toolConfigKey: "claude",
          command: "claude",
          args: [],
          worktreePath: "/repo/.aimux/worktrees/demo",
        },
      ],
      lastUsedById: {
        "codex-1": { lastUsedAt: "2026-05-01T00:00:00.000Z" },
        "claude-1": { lastUsedAt: "2026-05-02T00:00:00.000Z" },
        "service-1": { lastUsedAt: "2026-05-03T00:00:00.000Z" },
      },
    });

    expect(view.selectableRows).toHaveLength(1);
    expect(view.selectableRows[0]).toMatchObject({
      kind: "worktree",
      actionIndex: 0,
      actionNumber: 1,
      lastUsedAt: "2026-05-03T00:00:00.000Z",
    });
    expect(view.rows.map((row) => row.kind)).toEqual([
      "section",
      "worktree",
      "attached-agent-display",
      "attached-agent-display",
      "attached-service-display",
    ]);
  });

  it("does not render duplicate flat agents already embedded under a graveyarded worktree", () => {
    const worktreePath = "/repo/.aimux/worktrees/demo";
    const duplicateAgent = {
      id: "codex-1",
      tool: "codex",
      toolConfigKey: "codex",
      command: "codex",
      args: [],
      worktreePath,
    };
    const view = buildGraveyardViewModel({
      worktrees: [
        {
          name: "demo",
          path: worktreePath,
          branch: "demo",
          graveyardedAt: "2026-05-01T00:00:00.000Z",
          agents: [duplicateAgent],
        },
      ],
      agents: [duplicateAgent],
    });

    expect(view.rows.filter((row) => row.kind === "attached-agent-display")).toHaveLength(1);
    expect(view.rows.some((row) => row.kind === "standalone-agent")).toBe(false);
    expect(view.rows.some((row) => row.kind === "agent-worktree")).toBe(false);
  });

  it("groups standalone graveyarded agents by worktree and leaves only missing-path agents orphaned", () => {
    const view = buildGraveyardViewModel({
      worktrees: [],
      agents: [
        {
          id: "codex-1",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          worktreePath: "/repo/.aimux/worktrees/demo",
        },
        {
          id: "claude-1",
          tool: "claude",
          toolConfigKey: "claude",
          command: "claude",
          args: [],
        },
      ],
      lastUsedById: {
        "codex-1": { lastUsedAt: "2026-05-02T00:00:00.000Z" },
      },
    });

    expect(view.rows.map((row) => row.kind)).toEqual([
      "section",
      "agent-worktree",
      "standalone-agent",
      "section",
      "orphan-agent",
    ]);
    expect(view.selectableRows.map((row) => [row.kind, row.actionNumber])).toEqual([
      ["standalone-agent", 1],
      ["orphan-agent", 2],
    ]);
  });

  it("orders worktrees by most recent attached activity and caps visible attached agents", () => {
    const olderPath = "/repo/.aimux/worktrees/older";
    const newerPath = "/repo/.aimux/worktrees/newer";
    const view = buildGraveyardViewModel({
      worktrees: [
        {
          name: "older",
          path: olderPath,
          branch: "older",
          graveyardedAt: "2026-05-01T00:00:00.000Z",
          agents: [{ id: "older-agent", tool: "codex", toolConfigKey: "codex", command: "codex", args: [] }],
        },
        {
          name: "newer",
          path: newerPath,
          branch: "newer",
          graveyardedAt: "2026-05-01T00:00:00.000Z",
          agents: Array.from({ length: 7 }, (_, index) => ({
            id: `newer-agent-${index}`,
            tool: "claude",
            toolConfigKey: "claude",
            command: "claude",
            args: [],
          })),
        },
      ],
      agents: [],
      lastUsedById: {
        "older-agent": { lastUsedAt: "2026-05-02T00:00:00.000Z" },
        "newer-agent-0": { lastUsedAt: "2026-05-03T00:00:00.000Z" },
      },
    });

    expect(view.selectableRows.map((row) => row.kind === "worktree" && row.entry.name)).toEqual(["newer", "older"]);
    const newerRow = view.selectableRows[0];
    expect(newerRow).toMatchObject({
      kind: "worktree",
      attachedAgents: expect.any(Array),
      visibleAttachedAgents: expect.any(Array),
      hiddenAttachedAgentCount: 2,
    });
    if (newerRow.kind !== "worktree") throw new Error("expected worktree row");
    expect(newerRow.attachedAgents).toHaveLength(7);
    expect(newerRow.visibleAttachedAgents).toHaveLength(5);
    expect(view.rows.map((row) => row.kind).filter((kind) => kind === "attached-more-display")).toHaveLength(1);
  });

  it("renders orphan teammates as display-only diagnostic rows", () => {
    const view = buildGraveyardViewModel({
      worktrees: [],
      agents: [],
      parentSessions: [
        {
          id: "parent",
          tool: "claude",
          toolConfigKey: "claude",
          command: "claude",
          args: [],
        },
      ],
      teammates: [
        {
          id: "attached-teammate",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          team: { teamId: "team-1", parentSessionId: "parent" },
        },
        {
          id: "orphan-teammate",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          team: { teamId: "team-1", parentSessionId: "missing-parent" },
        },
      ],
      lastUsedById: {
        "orphan-teammate": { lastUsedAt: "2026-05-04T00:00:00.000Z" },
      },
    });

    expect(view.rows.map((row) => row.kind)).toEqual(["section", "orphan-teammate"]);
    expect(view.rows[1]).toMatchObject({
      kind: "orphan-teammate",
      entry: { id: "orphan-teammate" },
      parentSessionId: "missing-parent",
      lastUsedAt: "2026-05-04T00:00:00.000Z",
    });
    expect(view.selectableRows).toEqual([]);
  });

  it("does not mark teammates orphaned when the parent is a graveyard entry or attached to a graveyarded worktree", () => {
    const attachedParent = {
      id: "attached-parent",
      tool: "claude",
      toolConfigKey: "claude",
      command: "claude",
      args: [],
      worktreePath: "/repo/.aimux/worktrees/demo",
    };
    const view = buildGraveyardViewModel({
      worktrees: [
        {
          name: "demo",
          path: "/repo/.aimux/worktrees/demo",
          branch: "demo",
          graveyardedAt: "2026-05-01T00:00:00.000Z",
          agents: [attachedParent],
        },
      ],
      agents: [
        {
          id: "flat-parent",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          worktreePath: "/repo/.aimux/worktrees/other",
        },
      ],
      teammates: [
        {
          id: "child-of-attached",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: [],
          team: { teamId: "team-1", parentSessionId: "attached-parent" },
        },
        {
          id: "child-of-flat",
          tool: "claude",
          toolConfigKey: "claude",
          command: "claude",
          args: [],
          team: { teamId: "team-2", parentSessionId: "flat-parent" },
        },
      ],
    });

    expect(view.rows.some((row) => row.kind === "orphan-teammate")).toBe(false);
  });

  it("does not duplicate teammate rows already present in graveyard entries", () => {
    const teammate = {
      id: "graveyarded-teammate",
      tool: "codex",
      toolConfigKey: "codex",
      command: "codex",
      args: [],
      worktreePath: "/repo/.aimux/worktrees/demo",
      team: { teamId: "team-1", parentSessionId: "missing-parent" },
    };
    const view = buildGraveyardViewModel({
      worktrees: [],
      agents: [teammate],
      teammates: [teammate],
    });

    expect(view.rows.map((row) => row.kind)).toEqual(["section", "agent-worktree", "standalone-agent"]);
    expect(view.rows.some((row) => row.kind === "orphan-teammate")).toBe(false);
    expect(view.selectableRows).toHaveLength(1);
  });
});
