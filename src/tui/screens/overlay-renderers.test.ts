import { describe, expect, it, vi } from "vitest";

import { buildHelpOverlayOutput, buildWorktreeListOverlayOutput } from "./overlay-renderers.js";

function plain(value: string): string {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b[78]/g, "");
}

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

describe("buildHelpOverlayOutput", () => {
  it("documents dashboard-local shortcuts instead of stale tmux-prefixed commands", () => {
    const output = plain(buildHelpOverlayOutput({}, 120, 40));

    expect(output).toContain("?  show help");
    expect(output).toContain("n  new agent");
    expect(output).toContain("v  new service");
    expect(output).toContain("x  stop or remove selected item");
    expect(output).not.toContain("Ctrl+A c  new agent");
    expect(output).not.toContain("Ctrl+A v  request review");
  });
});
