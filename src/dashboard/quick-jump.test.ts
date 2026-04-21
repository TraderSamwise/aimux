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

  it("keeps main first and sorts agents and services newest first inside each worktree", () => {
    const worktrees = buildDashboardQuickJumpWorktrees({
      sessions: [
        {
          index: 0,
          id: "old-agent",
          command: "codex",
          status: "running",
          active: false,
          worktreePath: "/repo/w1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          index: 1,
          id: "new-agent",
          command: "claude",
          status: "running",
          active: false,
          worktreePath: "/repo/w1",
          createdAt: "2026-01-03T00:00:00.000Z",
        },
      ],
      services: [
        {
          id: "old-service",
          command: "shell",
          args: [],
          status: "running",
          active: false,
          worktreePath: "/repo/w1",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "new-service",
          command: "shell",
          args: [],
          status: "running",
          active: false,
          worktreePath: "/repo/w1",
          createdAt: "2026-01-04T00:00:00.000Z",
        },
      ],
      worktreeGroups: [
        {
          name: "older",
          branch: "older",
          path: "/repo/older",
          createdAt: "2026-01-01T00:00:00.000Z",
          status: "offline",
          sessions: [],
          services: [],
        },
        {
          name: "w1",
          branch: "feat/w1",
          path: "/repo/w1",
          createdAt: "2026-01-05T00:00:00.000Z",
          status: "active",
          sessions: [],
          services: [],
        },
      ],
      mainCheckout: { name: "Main Checkout", branch: "master" },
    });

    expect(worktrees.map((worktree) => worktree.name)).toEqual(["Main Checkout", "w1", "older"]);
    expect(worktrees[1]?.entries.map((entry) => [entry.digit, entry.kind, entry.id])).toEqual([
      [1, "session", "new-agent"],
      [2, "session", "old-agent"],
      [3, "service", "new-service"],
      [4, "service", "old-service"],
    ]);
  });
});
