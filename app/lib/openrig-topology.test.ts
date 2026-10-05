import { describe, expect, it } from "vitest";
import type { DesktopState } from "@/lib/desktop-state";
import { groupByWorktree } from "@/lib/desktop-state";
import { buildProjectTopology, healthForStatus } from "@/lib/openrig-topology";

describe("openrig-inspired topology model", () => {
  it("classifies lifecycle statuses into topology health", () => {
    expect(healthForStatus("running")).toBe("active");
    expect(healthForStatus("waiting")).toBe("attention");
    expect(healthForStatus("idle")).toBe("idle");
    expect(healthForStatus("offline")).toBe("offline");
    // In flight, not asking: `pendingAction` carries a lifecycle verb, and the
    // project service answers the same way for the same input.
    expect(healthForStatus("running", "stopping")).toBe("active");
    expect(healthForStatus("running", "resurrecting")).toBe("active");
  });

  it("builds a project/worktree/agent/service topology from desktop state", () => {
    const state: DesktopState = {
      ok: true,
      mainCheckoutInfo: { name: "aimux", branch: "main" },
      mainCheckoutPath: "/repo/aimux",
      worktrees: [{ name: "feature", path: "/repo/aimux-feature", branch: "feature/native" }],
      sessions: [
        {
          id: "agent-1",
          status: "running",
          command: "codex",
          worktreePath: "/repo/aimux",
          label: "Codex",
        },
        {
          id: "agent-2",
          status: "waiting",
          command: "claude",
          worktreePath: "/repo/aimux-feature",
        },
        // Split out from agent-2, which used to be waiting AND mid-action at
        // once -- so the summary could not say which of the two it was counting.
        {
          id: "agent-3",
          status: "running",
          command: "codex",
          worktreePath: "/repo/aimux-feature",
          pendingAction: "stopping",
        },
      ],
      services: [
        {
          id: "web",
          status: "offline",
          command: "yarn dev",
          worktreePath: "/repo/aimux-feature",
        },
      ],
    };

    const topology = buildProjectTopology(
      { name: "aimux", path: "/repo/aimux" },
      groupByWorktree(state),
      state,
    );

    expect(topology.summary).toEqual({
      worktrees: 2,
      agents: 3,
      services: 1,
      active: 2,
      attention: 1,
      offline: 1,
    });
    expect(topology.project.health).toBe("attention");
    expect(topology.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "agent:agent-1", label: "Codex" }),
        expect.objectContaining({ id: "agent:agent-2", label: "claude" }),
      ]),
    );
    expect(topology.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "project:/repo/aimux", to: "worktree:__main_checkout__" }),
        expect.objectContaining({ from: "worktree:/repo/aimux-feature", to: "agent:agent-2" }),
        expect.objectContaining({ from: "worktree:/repo/aimux-feature", to: "service:web" }),
      ]),
    );
  });
});
