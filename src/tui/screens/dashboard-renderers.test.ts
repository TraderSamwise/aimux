import { describe, expect, it } from "vitest";
import { derivedStatusLabel, type DashboardViewModel } from "../../dashboard/index.js";
import { renderDashboardFrame } from "./dashboard-renderers.js";

function baseDashboardViewModel(overrides: Partial<DashboardViewModel>): DashboardViewModel {
  return {
    sessions: [],
    services: [],
    worktreeGroups: [],
    hasWorktrees: true,
    focusedWorktreePath: undefined,
    navLevel: "worktrees",
    selectedSessionId: undefined,
    selectedServiceId: undefined,
    runtimeLabel: "tmux",
    mainCheckout: { name: "Main Checkout", branch: "master" },
    worktreeRemoval: undefined,
    detailsPaneVisible: true,
    scrollOffset: 0,
    derivedStatusLabel,
    ...overrides,
  };
}

describe("renderDashboardFrame worktree progress", () => {
  it("shows a simple creating state for creating worktrees", () => {
    const path = "/repo/.aimux/worktrees/e2e";

    const { frame } = renderDashboardFrame(
      baseDashboardViewModel({
        focusedWorktreePath: path,
        worktreeGroups: [
          {
            name: "e2e",
            branch: "(creating)",
            path,
            createdAt: "2026-05-09T12:00:00.000Z",
            status: "offline",
            pending: true,
            pendingAction: "creating",
            sessions: [],
            services: [],
          },
        ],
      }),
      120,
      40,
    );

    expect(frame).toContain("(creating...)");
    expect(frame).toContain("Status: creating");
    expect(frame).not.toContain("Elapsed:");
    expect(frame).not.toContain("Progress:");
  });
});
