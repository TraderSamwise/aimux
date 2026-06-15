import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardSession, WorktreeGroup } from "./index.js";
import { deriveSessionSemantics } from "../session-semantics.js";
import { Dashboard, derivedStatusLabel } from "./index.js";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("Dashboard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses semantic display labels with pending actions taking precedence", () => {
    const semantic = deriveSessionSemantics({
      status: "running",
      attention: "needs_input",
    });

    expect(
      derivedStatusLabel({
        index: 0,
        id: "claude-1",
        command: "claude",
        status: "running",
        active: true,
        semantic,
      }),
    ).toBe("needs input");
    expect(
      derivedStatusLabel({
        index: 0,
        id: "claude-1",
        command: "claude",
        status: "running",
        active: true,
        semantic,
        pendingAction: "starting",
      }),
    ).toBe("starting");
    expect(
      derivedStatusLabel({
        index: 0,
        id: "claude-1",
        command: "claude",
        status: "waiting",
        active: true,
      }),
    ).toBe("thinking");
  });

  it("renders selected session context details", () => {
    const dashboard = new Dashboard();
    dashboard.update({
      sessions: [
        {
          index: 0,
          id: "codex-1",
          command: "codex",
          status: "running",
          active: true,
          label: "coder",
          worktreeName: "mobile",
          worktreeBranch: "feat/mobile-auth",
          cwd: "/repo/mobile",
          prNumber: 123,
          prTitle: "Fix mobile auth flow",
          prUrl: "https://github.com/acme/mobile/pull/123",
          repoOwner: "acme",
          repoName: "mobile",
        },
      ],
      services: [],
      worktreeGroups: [],
      hasWorktrees: false,
      focusedWorktreePath: undefined,
      navLevel: "sessions",
      selectedSessionId: "codex-1",
      selectedServiceId: undefined,
      selectedTeammates: [],
      runtimeLabel: "tmux",
      mainCheckout: { name: "Main Checkout", branch: "master" },
      worktreeRemoval: undefined,
      operationFailures: [],
      derivedStatusLabel: (session) => session.status,
    });

    const rendered = dashboard.render(140, 40);
    expect(rendered).toContain("DETAILS");
    expect(rendered).toContain("Worktree: mobile");
    expect(rendered).toContain("feat/mobile-auth");
    expect(rendered).toContain("PR #123: Fix mobile auth flow");
    expect(rendered).toContain("https://github.com/acme/mobile/pull/123");
  });

  it("renders persisted operation failures", () => {
    const dashboard = new Dashboard();
    dashboard.update({
      sessions: [],
      services: [],
      worktreeGroups: [
        {
          name: "demo",
          branch: "(failed)",
          path: "/repo/.aimux/worktrees/demo",
          status: "offline",
          sessions: [],
          services: [],
          operationFailure: {
            id: "failure-1",
            targetKind: "worktree",
            operation: "create",
            title: 'Failed to create worktree "demo"',
            message: "branch already exists",
            worktreePath: "/repo/.aimux/worktrees/demo",
            worktreeName: "demo",
            createdAt: "2026-05-01T00:00:00.000Z",
          },
        },
      ],
      hasWorktrees: true,
      focusedWorktreePath: "/repo/.aimux/worktrees/demo",
      navLevel: "worktrees",
      selectedSessionId: undefined,
      selectedServiceId: undefined,
      selectedTeammates: [],
      runtimeLabel: "tmux",
      mainCheckout: { name: "Main Checkout", branch: "master" },
      worktreeRemoval: undefined,
      operationFailures: [
        {
          id: "failure-1",
          targetKind: "worktree",
          operation: "create",
          title: 'Failed to create worktree "demo"',
          message: "branch already exists",
          worktreePath: "/repo/.aimux/worktrees/demo",
          worktreeName: "demo",
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ],
      derivedStatusLabel: (session) => session.status,
    });

    const rendered = dashboard.render(140, 40);
    expect(rendered).toContain("FAILED OPERATIONS");
    expect(rendered).toContain('Failed to create worktree "demo"');
    expect(stripAnsi(rendered)).toContain("failed");
    expect(rendered).toContain("Error: branch already exists");
  });

  it("renders semantic session states with labeled recency and worktree summaries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T00:01:00.000Z"));

    const workingSession: DashboardSession = {
      index: 0,
      id: "codex-working",
      command: "codex",
      status: "running",
      active: true,
      role: "coder",
      worktreePath: "/repo/.aimux/worktrees/notifications",
      worktreeName: "notifications",
      worktreeBranch: "notification-followup",
      unseenCount: 10,
      lastOutputAt: "2026-05-23T00:00:43.000Z",
      semantic: deriveSessionSemantics({
        status: "running",
        activity: "running",
        unseenCount: 10,
      }),
    };
    const responseSession: DashboardSession = {
      index: 1,
      id: "claude-response",
      command: "claude",
      status: "waiting",
      active: false,
      worktreePath: "/repo/.aimux/worktrees/notifications",
      worktreeName: "notifications",
      worktreeBranch: "notification-followup",
      lastOutputAt: "2026-05-23T00:00:20.000Z",
      notificationUnreadCount: 1,
      semantic: deriveSessionSemantics({
        status: "waiting",
        attention: "needs_response",
        notificationUnreadCount: 1,
        latestNotification: {
          id: "notif-1",
          title: "Needs response",
          body: "Agent is waiting on a response.",
          sessionId: "claude-response",
          targetKind: "session",
          unread: true,
          cleared: false,
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:00.000Z",
        },
      }),
    };
    const nextStepSession: DashboardSession = {
      index: 2,
      id: "codex-next",
      command: "codex",
      status: "idle",
      active: false,
      taskDescription: "Finish dashboard semantics",
      worktreePath: "/repo/.aimux/worktrees/notifications",
      worktreeName: "notifications",
      worktreeBranch: "notification-followup",
      becameIdleAt: "2026-05-23T00:00:20.000Z",
      lastOutputAt: "2026-05-23T00:00:18.000Z",
      semantic: deriveSessionSemantics({
        status: "idle",
        activity: "idle",
        hasActiveTask: true,
      }),
    };
    const worktreeGroup: WorktreeGroup = {
      name: "notifications",
      branch: "notification-followup",
      path: "/repo/.aimux/worktrees/notifications",
      status: "active",
      sessions: [workingSession, responseSession, nextStepSession],
      services: [],
    };
    const dashboard = new Dashboard();
    dashboard.update({
      sessions: [workingSession, responseSession, nextStepSession],
      overseerSessions: [],
      services: [],
      worktreeGroups: [worktreeGroup],
      hasWorktrees: true,
      focusedWorktreePath: "/repo/.aimux/worktrees/notifications",
      navLevel: "worktrees",
      selectedSessionId: undefined,
      selectedServiceId: undefined,
      selectedTeammates: [],
      runtimeLabel: "tmux",
      mainCheckout: { name: "Main Checkout", branch: "master" },
      worktreeRemoval: undefined,
      operationFailures: [],
      derivedStatusLabel,
    });

    const rendered = stripAnsi(dashboard.render(160, 40));

    expect(rendered).toContain("notifications");
    expect(rendered).toContain("notification-followup");
    expect(rendered).toContain("1 needs response");
    expect(rendered).toContain("1 next step");
    expect(rendered).toContain("1 working");
    expect(rendered).toContain("codex coder");
    expect(rendered).toContain("WORKING");
    expect(rendered).toContain("output 17s ago");
    expect(rendered).toContain("10 unseen");
    expect(rendered).toContain("NEEDS REPLY");
    expect(rendered).toContain("prompted 1m ago");
    expect(rendered).toContain("NEXT STEP");
    expect(rendered).toContain("output 42s ago");
    expect(rendered).toContain("idle now");
  });
});
