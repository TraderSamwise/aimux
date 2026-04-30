import { describe, expect, it } from "vitest";

import { buildDashboardWorktreeGroups } from "./dashboard-model.js";

describe("buildDashboardWorktreeGroups", () => {
  it("always includes main checkout as the first group", () => {
    const groups = buildDashboardWorktreeGroups(
      {},
      [
        {
          index: 0,
          id: "main-agent",
          command: "codex",
          status: "running",
          active: false,
        },
      ],
      [],
      [
        {
          name: "Main Checkout",
          path: "/repo",
          branch: "master",
          isBare: false,
          createdAt: "2026-04-01T00:00:00.000Z",
        },
        {
          name: "feature-a",
          path: "/repo/.aimux/worktrees/feature-a",
          branch: "feature-a",
          isBare: false,
          createdAt: "2026-04-03T00:00:00.000Z",
        },
      ],
      "/repo",
    );

    expect(groups.map((group) => [group.path, group.name, group.branch])).toEqual([
      [undefined, "Main Checkout", "master"],
      ["/repo/.aimux/worktrees/feature-a", "feature-a", "feature-a"],
    ]);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["main-agent"]);
  });
});
