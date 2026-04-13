import { describe, expect, it } from "vitest";
import { buildDashboardQuickJumpWorktrees, resolveDashboardQuickJumpTarget } from "./quick-jump.js";

describe("dashboard quick jump", () => {
  it("numbers worktrees and entries in visual order including services", () => {
    const worktrees = buildDashboardQuickJumpWorktrees({
      sessions: [
        {
          index: 0,
          id: "main-agent",
          command: "codex",
          status: "running",
          active: false,
        },
        {
          index: 1,
          id: "wt-agent",
          command: "claude",
          status: "running",
          active: false,
          worktreePath: "/repo/w1",
          worktreeName: "w1",
          worktreeBranch: "feat/w1",
        },
      ],
      services: [
        {
          id: "main-service",
          command: "shell",
          args: [],
          status: "running",
          active: false,
        },
        {
          id: "wt-service",
          command: "shell",
          args: [],
          status: "running",
          active: false,
          worktreePath: "/repo/w1",
          worktreeName: "w1",
          worktreeBranch: "feat/w1",
        },
      ],
      worktreeGroups: [
        {
          name: "w1",
          branch: "feat/w1",
          path: "/repo/w1",
          status: "active",
          sessions: [],
          services: [],
        },
      ],
      mainCheckout: { name: "Main Checkout", branch: "master" },
    });

    expect(worktrees.map((worktree) => [worktree.digit, worktree.name])).toEqual([
      [1, "Main Checkout"],
      [2, "w1"],
    ]);
    expect(worktrees[0]?.entries.map((entry) => [entry.digit, entry.kind, entry.id])).toEqual([
      [1, "session", "main-agent"],
      [2, "service", "main-service"],
    ]);
    expect(worktrees[1]?.entries.map((entry) => [entry.digit, entry.kind, entry.id])).toEqual([
      [1, "session", "wt-agent"],
      [2, "service", "wt-service"],
    ]);
  });

  it("resolves one digit to a worktree and two digits to an entry", () => {
    const worktrees = buildDashboardQuickJumpWorktrees({
      sessions: [
        {
          index: 0,
          id: "agent-1",
          command: "codex",
          status: "running",
          active: false,
        },
      ],
      services: [
        {
          id: "service-1",
          command: "shell",
          args: [],
          status: "running",
          active: false,
        },
      ],
      worktreeGroups: [],
      mainCheckout: { name: "Main Checkout", branch: "master" },
    });

    expect(resolveDashboardQuickJumpTarget(worktrees, "1")).toMatchObject({
      kind: "worktree",
      worktree: { digit: 1, path: undefined, name: "Main Checkout" },
    });
    expect(resolveDashboardQuickJumpTarget(worktrees, "12")).toMatchObject({
      kind: "entry",
      worktree: { digit: 1, path: undefined, name: "Main Checkout" },
      entry: { digit: 2, kind: "service", id: "service-1" },
      entryIndex: 1,
    });
  });
});
