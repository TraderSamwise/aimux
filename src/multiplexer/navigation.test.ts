import { describe, expect, it, vi } from "vitest";

const { findMainRepo, listWorktrees } = vi.hoisted(() => ({
  findMainRepo: vi.fn(() => "/repo"),
  listWorktrees: vi.fn(() => {
    throw new Error("local worktree read should not run");
  }),
}));

vi.mock("../worktree.js", () => ({
  findMainRepo,
  listWorktrees,
}));

import { showMigratePicker } from "./navigation.js";

describe("showMigratePicker", () => {
  it("builds dashboard migrate choices from service-backed worktree groups", () => {
    const host: any = {
      mode: "dashboard",
      projectRoot: "/repo",
      sessions: [{ id: "codex-1" }],
      activeIndex: 0,
      dashboardWorktreeGroupsCache: [
        { name: "Main Checkout", branch: "main", path: undefined },
        { name: "feature", branch: "feature", path: "/repo/.aimux/worktrees/feature" },
      ],
      openDashboardOverlay: vi.fn(),
      redrawDashboardWithOverlay: vi.fn(),
    };

    showMigratePicker(host);

    expect(host.migratePickerWorktrees).toEqual([
      { name: "(main)", path: "/repo" },
      { name: "feature", path: "/repo/.aimux/worktrees/feature" },
    ]);
    expect(host.migratePickerSessionId).toBe("codex-1");
    expect(host.openDashboardOverlay).toHaveBeenCalledWith("migrate-picker");
    expect(host.redrawDashboardWithOverlay).toHaveBeenCalledOnce();
    expect(listWorktrees).not.toHaveBeenCalled();
    expect(findMainRepo).not.toHaveBeenCalled();
  });
});
