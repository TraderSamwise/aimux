import { describe, expect, it, vi } from "vitest";
import { derivedStatusLabel, type DashboardViewModel } from "../../dashboard/index.js";
import { deriveSessionSemantics } from "../../session-semantics.js";
import { stripAnsi } from "../render/text.js";
import { buildDashboardFooterHints, renderDashboardFrame } from "./dashboard-renderers.js";

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

describe("buildDashboardFooterHints", () => {
  const keys = (vm: Partial<DashboardViewModel>) =>
    new Set(buildDashboardFooterHints(baseDashboardViewModel(vm)).map((h) => h[0]));
  const sess = (over: Record<string, unknown> = {}) => [{ id: "a", status: "running", ...over } as never];

  it("returns a flat, ordered list (nav first, system last)", () => {
    const hints = buildDashboardFooterHints(
      baseDashboardViewModel({ hasWorktrees: true, navLevel: "sessions", sessions: sess() }),
    );
    expect(hints[0][0]).toBe("↑↓/jk");
    expect(hints.at(-2)).toEqual(["?", "help"]);
    expect(hints.at(-1)).toEqual(["q", "quit"]);
  });

  it("labels numeric shortcuts by the active dashboard navigation level", () => {
    const sessionLevel = buildDashboardFooterHints(
      baseDashboardViewModel({ hasWorktrees: true, navLevel: "sessions", sessions: sess() }),
    );
    const worktreeLevel = buildDashboardFooterHints(
      baseDashboardViewModel({ hasWorktrees: true, navLevel: "worktrees" }),
    );

    expect(sessionLevel.find((h) => h[0] === "1-9")).toEqual(["1-9", "entry"]);
    expect(worktreeLevel.find((h) => h[0] === "1-9")).toEqual(["1-9", "worktree"]);
  });

  it("tags the destructive kill key as danger", () => {
    const hints = buildDashboardFooterHints(
      baseDashboardViewModel({ hasWorktrees: false, sessions: sess(), selectedSessionId: "a" }),
    );
    expect(hints.find((h) => h[0] === "x")).toEqual(["x", "stop", "danger"]);
  });

  it("does not advertise resume for blocked offline sessions", () => {
    const hints = buildDashboardFooterHints(
      baseDashboardViewModel({
        hasWorktrees: true,
        navLevel: "sessions",
        sessions: sess({
          status: "offline",
          restoreState: "blocked",
          restoreBlockedReason: "missing exact resumable backend session id",
        }),
        selectedSessionId: "a",
      }),
    );
    expect(hints.find((h) => h[0] === "Enter")).toEqual(["Enter", "unavailable"]);
  });

  it("advertises resume for restorable exited sessions", () => {
    const hints = buildDashboardFooterHints(
      baseDashboardViewModel({
        hasWorktrees: true,
        navLevel: "sessions",
        sessions: sess({ status: "exited", restoreState: "available" }),
        selectedSessionId: "a",
      }),
    );
    expect(hints.find((h) => h[0] === "Enter")).toEqual(["Enter", "resume"]);
  });

  it("shows every active key per state variant", () => {
    // no sessions, no worktrees
    expect(keys({ hasWorktrees: false, sessions: [] })).toEqual(
      new Set(["u", "Tab", "n", "v", "f", "s", "H", "T", "o", "R", "?", "q"]),
    );
    // worktree level
    expect(keys({ hasWorktrees: true, navLevel: "worktrees" })).toEqual(
      new Set(["↑↓/jk", "1-9", "Enter", "u", "Tab", "n", "v", "f", "w", "?", "q"]),
    );
    // session level with worktrees + a selected session + a teammate
    expect(
      keys({
        hasWorktrees: true,
        navLevel: "sessions",
        sessions: sess(),
        selectedSessionId: "a",
        selectedTeammates: sess(),
      }),
    ).toEqual(
      new Set([
        "↑↓/jk",
        "⇧↑↓",
        "1-9",
        "Enter",
        "Esc/h",
        "u",
        "Tab",
        "n",
        "v",
        "f",
        "s",
        "H",
        "T",
        "o",
        "R",
        "e",
        "m",
        "r",
        "x",
        "?",
        "q",
      ]),
    );
    // flat session list with a selected session
    expect(keys({ hasWorktrees: false, navLevel: "sessions", sessions: sess(), selectedSessionId: "a" })).toEqual(
      new Set(["↑↓/jk", "Enter", "u", "Tab", "n", "v", "f", "w", "s", "H", "T", "o", "R", "x", "r", "?", "q"]),
    );
  });
});

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
          {
            index: 2,
            id: "codex-ready",
            command: "codex",
            status: "running",
            active: false,
            role: "coder",
            semantic: deriveSessionSemantics({
              status: "running",
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
    expect(plain).toContain("Ready");
    expect(plain).toContain("1 unread");
    expect(frame).toContain("\x1b[1;33;7m NEEDS INPUT \x1b[0m");
    expect(frame).toContain("\x1b[36;7m WORKING \x1b[0m");
  });

  it("suppresses the unread chip when the needs-input state already conveys it", () => {
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
            attention: "needs_input",
            notificationUnreadCount: 1,
            notificationNeedsInputUnreadCount: 1,
            semantic: deriveSessionSemantics({
              status: "running",
              attention: "needs_input",
              notificationUnreadCount: 1,
            }),
          },
        ],
        worktreeGroups: [{ name: "Main Checkout", branch: "master", status: "active", sessions: [], services: [] }],
      }),
      120,
      40,
    );
    const plain = stripAnsi(frame);
    expect(plain).toContain("NEEDS INPUT");
    expect(plain).not.toContain("unread");
  });

  it("still shows non-needs-input unread alongside the needs-input state", () => {
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
            attention: "needs_input",
            notificationUnreadCount: 2,
            notificationNeedsInputUnreadCount: 1,
            semantic: deriveSessionSemantics({
              status: "running",
              attention: "needs_input",
              notificationUnreadCount: 2,
            }),
          },
        ],
        worktreeGroups: [{ name: "Main Checkout", branch: "master", status: "active", sessions: [], services: [] }],
      }),
      120,
      40,
    );
    expect(stripAnsi(frame)).toContain("1 unread");
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
    expect(stripAnsi(frame)).toContain("team");
    expect(frame).toContain("review(reviewer)");
    expect(frame).toContain("working");
    expect(frame).toContain("scan(explorer)");
  });

  it("does not list offline worktree entries as active in details", () => {
    const { frame } = renderDashboardFrame(
      baseDashboardViewModel({
        navLevel: "worktrees",
        focusedWorktreePath: "/repo/.aimux/worktrees/wt",
        sessions: [
          {
            index: 0,
            id: "codex-offline",
            command: "codex",
            worktreePath: "/repo/.aimux/worktrees/wt",
            status: "offline",
            active: false,
          },
        ],
        services: [
          {
            id: "svc-offline",
            command: "shell",
            args: [],
            worktreePath: "/repo/.aimux/worktrees/wt",
            status: "offline",
            active: false,
          },
        ],
        worktreeGroups: [
          {
            name: "wt",
            branch: "wt",
            path: "/repo/.aimux/worktrees/wt",
            status: "active",
            sessions: [],
            services: [],
          },
        ],
      }),
      140,
      40,
    );

    const plain = stripAnsi(frame);
    expect(plain).toContain("Agents: 1");
    expect(plain).toContain("Services: 1");
    expect(plain).not.toContain("Active:");
    expect(plain).not.toContain("Running:");
  });

  it("shows pending service state instead of raw status in details", () => {
    const { frame } = renderDashboardFrame(
      baseDashboardViewModel({
        navLevel: "sessions",
        selectedServiceId: "svc-creating",
        services: [
          {
            id: "svc-creating",
            command: "shell",
            args: [],
            status: "running",
            active: false,
            pendingAction: "creating",
          },
        ],
        worktreeGroups: [{ name: "Main Checkout", branch: "master", status: "active", sessions: [], services: [] }],
      }),
      140,
      40,
    );

    const plain = stripAnsi(frame);
    expect(plain).toContain("State: Creating");
    expect(plain).not.toContain("Status: running");
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

  it("renders the version next to the title when provided", () => {
    const { frame } = renderDashboardFrame(baseDashboardViewModel({ version: "1.2.3" }), 120, 40);
    expect(stripAnsi(frame)).toContain("aimux v1.2.3 — agent multiplexer");

    const without = renderDashboardFrame(baseDashboardViewModel({ version: undefined }), 120, 40);
    expect(stripAnsi(without.frame)).not.toContain("v1.2.3");
  });

  it("numbers agents within a worktree group for quick jump", () => {
    const { frame } = renderDashboardFrame(
      baseDashboardViewModel({
        sessions: [
          {
            index: 0,
            id: "claude-0",
            command: "claude",
            worktreePath: "/repo/.aimux/worktrees/wt",
            worktreeName: "wt",
            status: "offline",
            active: false,
            semantic: deriveSessionSemantics({ status: "offline" }),
          },
          {
            index: 1,
            id: "codex-1",
            command: "codex",
            worktreePath: "/repo/.aimux/worktrees/wt",
            worktreeName: "wt",
            status: "offline",
            active: false,
            semantic: deriveSessionSemantics({ status: "offline" }),
          },
        ],
        worktreeGroups: [
          {
            name: "wt",
            branch: "feat/x",
            path: "/repo/.aimux/worktrees/wt",
            status: "offline",
            sessions: [],
            services: [],
          },
        ],
      }),
      120,
      40,
    );
    const plain = stripAnsi(frame);
    expect(plain).toMatch(/\[1\]\s+(claude|codex)/);
    expect(plain).toMatch(/\[2\]\s+(claude|codex)/);
  });

  it("scrolls to reveal the whole focused last card, not just its title", () => {
    const groups = [];
    const sessions = [];
    for (let i = 0; i < 12; i++) {
      const path = `/repo/.aimux/worktrees/wt${i}`;
      groups.push({ name: `wt${i}`, branch: `b${i}`, path, status: "offline" as const, sessions: [], services: [] });
      const agents = i === 11 ? 3 : 1;
      for (let a = 0; a < agents; a++) {
        sessions.push({
          index: i * 10 + a,
          id: `s${i}_${a}`,
          command: "claude",
          worktreePath: path,
          worktreeName: `wt${i}`,
          status: "offline" as const,
          active: false,
          semantic: deriveSessionSemantics({ status: "offline" }),
        });
      }
    }
    const { frame } = renderDashboardFrame(
      baseDashboardViewModel({
        sessions,
        worktreeGroups: groups,
        focusedWorktreePath: "/repo/.aimux/worktrees/wt11",
        navLevel: "worktrees",
        detailsPaneVisible: false,
      }),
      120,
      40,
    );
    const left = stripAnsi(frame)
      .split("\n")
      .map((l) => l.trimEnd());
    const titleIdx = left.findIndex((l) => l.includes("wt11"));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    // The focused card's third agent and bottom border must both be visible.
    const after = left.slice(titleIdx).join("\n");
    expect(after).toMatch(/\[3\]\s+claude/);
    expect(after).toContain("╰");
  });

  it("mutes activity chips for offline agents but keeps them colored for live ones", () => {
    const mk = (id: string, status: "offline" | "running") => ({
      index: 0,
      id,
      command: "codex",
      worktreePath: `/repo/.aimux/worktrees/${id}`,
      worktreeName: id,
      status,
      active: status === "running",
      unseenCount: 9,
      threadPendingCount: 1,
      semantic: deriveSessionSemantics(
        status === "running" ? { status: "running", activity: "running" } : { status: "offline" },
      ),
    });
    const { frame } = renderDashboardFrame(
      baseDashboardViewModel({
        sessions: [mk("off", "offline"), mk("on", "running")],
        worktreeGroups: [
          {
            name: "off",
            branch: "x",
            path: "/repo/.aimux/worktrees/off",
            status: "offline",
            sessions: [],
            services: [],
          },
          { name: "on", branch: "y", path: "/repo/.aimux/worktrees/on", status: "active", sessions: [], services: [] },
        ],
        detailsPaneVisible: false,
      }),
      140,
      30,
    );
    const offlineRow = frame.split("\r\n").find((l) => l.includes("1 pending") && l.includes("Offline"))!;
    const liveRow = frame.split("\r\n").find((l) => l.includes("1 pending") && l.includes("WORKING"))!;
    // Offline chips use the muted 256-color fg (245); live chips keep accent fg.
    expect(offlineRow).toContain("38;5;245");
    expect(offlineRow).not.toContain("38;5;174"); // not the danger "pending" accent
    expect(liveRow).toContain("38;5;174"); // danger "pending" accent retained
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
