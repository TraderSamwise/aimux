import { describe, expect, it } from "vitest";
import { derivedStatusLabel, type DashboardViewModel } from "../../dashboard/index.js";
import { deriveSessionSemantics } from "../../session-semantics.js";
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

  it("color-codes semantic agent states", () => {
    const { frame } = renderDashboardFrame(
      baseDashboardViewModel({
        navLevel: "sessions",
        selectedSessionId: "claude-1",
        sessions: [
          {
            index: 0,
            id: "claude-1",
            command: "claude",
            status: "running",
            active: true,
            role: "coder",
            attention: "needs_input",
            semantic: deriveSessionSemantics({
              status: "running",
              attention: "needs_input",
              notificationUnreadCount: 1,
            }),
          },
          {
            index: 1,
            id: "codex-1",
            command: "codex",
            status: "running",
            active: false,
            role: "coder",
            activity: "running",
            semantic: deriveSessionSemantics({
              status: "running",
              activity: "running",
            }),
          },
        ],
        worktreeGroups: [
          {
            name: "Main Checkout",
            branch: "master",
            status: "active",
            sessions: [],
            services: [],
          },
        ],
      }),
      120,
      40,
    );

    expect(frame).toContain("\x1b[1;33mneeds input\x1b[0m");
    expect(frame).toContain("\x1b[1;33mon you\x1b[0m");
    expect(frame).toContain("\x1b[36mworking\x1b[0m");
  });
});
