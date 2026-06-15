import { describe, expect, it, vi } from "vitest";
import { derivedStatusLabel, type DashboardViewModel } from "../../dashboard/index.js";
import { deriveSessionSemantics } from "../../session-semantics.js";
import { stripAnsi } from "../render/text.js";
import { renderDashboardFrame } from "./dashboard-renderers.js";

function baseDashboardViewModel(overrides: Partial<DashboardViewModel>): DashboardViewModel {
  return {
    sessions: [],
    overseerSessions: [],
    services: [],
    worktreeGroups: [],
    hasWorktrees: true,
    focusedWorktreePath: undefined,
    navLevel: "worktrees",
    selectedSessionId: undefined,
    selectedServiceId: undefined,
    selectedTeammates: [],
    runtimeLabel: "tmux",
    mainCheckout: { name: "Main Checkout", branch: "master" },
    worktreeRemoval: undefined,
    operationFailures: [],
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

    const plain = stripAnsi(frame);
    expect(plain).toContain("NEEDS INPUT");
    expect(plain).toContain("WORKING");
    expect(plain).toContain("1 unread");
    expect(frame).toContain("\x1b[1;33;7m NEEDS INPUT \x1b[0m");
    expect(frame).toContain("\x1b[36;7m WORKING \x1b[0m");
  });

  it("renders output recency instead of last-used recency and highlights recently idle sessions", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-09T12:00:30.000Z"));
    try {
      const { frame } = renderDashboardFrame(
        baseDashboardViewModel({
          navLevel: "sessions",
          selectedSessionId: "codex-1",
          sessions: [
            {
              index: 0,
              id: "codex-1",
              command: "codex",
              status: "idle",
              active: true,
              lastUsedAt: "2026-05-09T11:00:00.000Z",
              lastOutputAt: "2026-05-09T12:00:15.000Z",
              becameIdleAt: "2026-05-09T12:00:20.000Z",
              semantic: deriveSessionSemantics({
                status: "idle",
                activity: "idle",
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

      expect(frame).toContain("15s ago");
      expect(frame).toContain("idle now");
      expect(frame).not.toContain("1h ago");
    } finally {
      now.mockRestore();
    }
  });

  it("does not render prompt-only event timestamps as output recency", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-09T12:00:30.000Z"));
    try {
      const { frame } = renderDashboardFrame(
        baseDashboardViewModel({
          navLevel: "sessions",
          selectedSessionId: "codex-1",
          sessions: [
            {
              index: 0,
              id: "codex-1",
              command: "codex",
              status: "running",
              active: true,
              lastEvent: { kind: "prompt", message: "next task", ts: "2026-05-09T12:00:15.000Z" },
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

      expect(frame).not.toContain("15s ago");
    } finally {
      now.mockRestore();
    }
  });

  it("does not label last-used timestamps as output recency", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-09T12:00:30.000Z"));
    try {
      const { frame } = renderDashboardFrame(
        baseDashboardViewModel({
          navLevel: "sessions",
          selectedSessionId: "codex-1",
          sessions: [
            {
              index: 0,
              id: "codex-1",
              command: "codex",
              status: "running",
              active: true,
              lastUsedAt: "2026-05-09T12:00:00.000Z",
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

      expect(stripAnsi(frame)).toContain("WORKING");
      expect(frame).not.toContain("output 30s ago");
    } finally {
      now.mockRestore();
    }
  });

  it("renders pending session labels even when semantic state is stale", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-09T12:00:30.000Z"));
    try {
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
              pendingAction: "starting",
              optimistic: true,
              pendingStartedAt: "2026-05-09T12:00:00.000Z",
              lastUsedAt: "2026-05-09T11:00:00.000Z",
              becameIdleAt: "2026-05-09T12:00:25.000Z",
              semantic: deriveSessionSemantics({
                status: "running",
                attention: "needs_input",
              }),
            },
            {
              index: 1,
              id: "codex-1",
              command: "codex",
              status: "running",
              active: false,
              pendingAction: "graveyarding",
              optimistic: true,
              pendingStartedAt: "2026-05-09T12:00:00.000Z",
              semantic: deriveSessionSemantics({
                status: "running",
                attention: "needs_input",
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

      const plain = stripAnsi(frame);
      expect(plain).toContain("claude");
      expect(plain).toContain("Starting");
      expect(plain).toContain("starting 30s ago");
      expect(plain).toContain("1 starting");
      expect(plain).toContain("codex");
      expect(plain).toContain("Removing");
      expect(plain).toContain("removing 30s ago");
      expect(plain).toContain("1 removing");
      expect(plain).toContain("State: Starting");
      expect(plain).toContain("Started: 30s ago");
      expect(plain).not.toContain("State: needs input");
      expect(plain).not.toContain("Attention: needs_input");
      expect(plain).not.toContain("prompted");
      expect(plain).not.toContain("idle now");
      expect(plain).not.toContain("1 needs input");
      expect(plain).not.toContain("graveyarding");
      expect(plain).not.toContain("1h ago");
    } finally {
      now.mockRestore();
    }
  });

  it("renders selected parent teammates in the details pane only", () => {
    const { frame } = renderDashboardFrame(
      baseDashboardViewModel({
        navLevel: "sessions",
        selectedSessionId: "parent",
        sessions: [
          {
            index: 0,
            id: "parent",
            command: "claude",
            status: "running",
            active: true,
            role: "coder",
          },
        ],
        selectedTeammates: [
          {
            index: 0,
            id: "reviewer",
            command: "codex",
            status: "running",
            active: false,
            role: "reviewer",
            team: { teamId: "team-1", parentSessionId: "parent", role: "reviewer", label: "review" },
            semantic: deriveSessionSemantics({ status: "running", activity: "running" }),
          },
          {
            index: 1,
            id: "explorer",
            command: "claude",
            status: "offline",
            active: false,
            team: { teamId: "team-1", parentSessionId: "parent", role: "explorer", label: "scan" },
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
      140,
      40,
    );

    expect(frame).toContain("Team");
    expect(frame).toContain("[e] team");
    expect(frame).toContain("review(reviewer)");
    expect(frame).toContain("working");
    expect(frame).toContain("scan(explorer)");
  });

  it("renders a dedicated Overseer line above the worktrees when an overseer exists", () => {
    const overseerSession = {
      index: 0,
      id: "claude-boss",
      command: "claude",
      status: "running" as const,
      active: false,
      role: "overseer",
      team: { teamId: "overseer", parentSessionId: "", role: "overseer" },
      semantic: deriveSessionSemantics({ status: "running", activity: "idle" }),
    };

    const withOverseer = renderDashboardFrame(
      baseDashboardViewModel({
        overseerSessions: [overseerSession],
        worktreeGroups: [{ name: "Main Checkout", branch: "master", status: "active", sessions: [], services: [] }],
      }),
      120,
      40,
    );
    expect(withOverseer.frame).toContain("\x1b[35mOverseer\x1b[0m");
    expect(stripAnsi(withOverseer.frame)).toContain("overseer");

    const withoutOverseer = renderDashboardFrame(
      baseDashboardViewModel({
        overseerSessions: [],
        worktreeGroups: [{ name: "Main Checkout", branch: "master", status: "active", sessions: [], services: [] }],
      }),
      120,
      40,
    );
    expect(withoutOverseer.frame).not.toContain("Overseer");
  });

  it("shows a DEV badge in the header only for the dev runtime", () => {
    const prod = renderDashboardFrame(baseDashboardViewModel({ isDevRuntime: false }), 120, 40);
    expect(prod.frame).not.toContain(" DEV ");
    expect(prod.frame).not.toContain("\x1b[33m───");

    const dev = renderDashboardFrame(baseDashboardViewModel({ isDevRuntime: true }), 120, 40);
    expect(dev.frame).toContain("\x1b[1;30;43m DEV \x1b[0m");
    expect(dev.frame).toContain("\x1b[33m───");
  });

  it("renders pending teammate labels even when semantic state is stale", () => {
    const { frame } = renderDashboardFrame(
      baseDashboardViewModel({
        navLevel: "sessions",
        selectedSessionId: "parent",
        sessions: [
          {
            index: 0,
            id: "parent",
            command: "claude",
            status: "running",
            active: true,
          },
        ],
        selectedTeammates: [
          {
            index: 1,
            id: "reviewer",
            command: "codex",
            status: "running",
            active: false,
            pendingAction: "stopping",
            optimistic: true,
            team: { teamId: "team-1", parentSessionId: "parent", role: "reviewer", label: "review" },
            semantic: deriveSessionSemantics({
              status: "running",
              attention: "needs_input",
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
      140,
      40,
    );

    expect(frame).toContain("review(reviewer) · stopping · on you");
  });
});
