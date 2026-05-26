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
    expect(healthForStatus("running", "needs approval")).toBe("attention");
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
          pendingAction: "review",
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
      agents: 2,
      services: 1,
      active: 1,
      attention: 1,
      offline: 1,
    });
    expect(topology.project.health).toBe("attention");
    expect(topology.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "project:/repo/aimux", to: "worktree:__main_checkout__" }),
        expect.objectContaining({ from: "worktree:/repo/aimux-feature", to: "agent:agent-2" }),
        expect.objectContaining({ from: "worktree:/repo/aimux-feature", to: "service:web" }),
      ]),
    );
  });
});
