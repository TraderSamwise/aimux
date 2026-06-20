import { describe, expect, it, vi } from "vitest";

import { buildWorktreeListOverlayOutput } from "./overlay-renderers.js";

describe("buildWorktreeListOverlayOutput", () => {
  it("renders dashboard worktrees from the service-backed cache", () => {
    const ctx = {
      mode: "dashboard",
      dashboardWorktreeGroupsCache: [
        { name: "Main Checkout", branch: "main", path: undefined },
        { name: "feature", branch: "feature", path: "/repo/.aimux/worktrees/feature" },
      ],
      listAllWorktrees: vi.fn(() => {
        throw new Error("local worktree read should not run");
      }),
    };

    const output = buildWorktreeListOverlayOutput(ctx, 100, 30);

    expect(output).toContain("Main Checkout");
    expect(output).toContain("feature");
    expect(ctx.listAllWorktrees).not.toHaveBeenCalled();
  });
});
