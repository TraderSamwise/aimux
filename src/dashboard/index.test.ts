import { describe, expect, it } from "vitest";
import { Dashboard } from "./index.js";

describe("Dashboard", () => {
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
      runtimeLabel: "tmux",
      mainCheckout: { name: "Main Checkout", branch: "master" },
      worktreeRemoval: undefined,
      derivedStatusLabel: (session) => session.status,
    });

    const rendered = dashboard.render(120, 40);
    expect(rendered).toContain("Details");
    expect(rendered).toContain("Worktree: mobile");
    expect(rendered).toContain("feat/mobile-auth");
    expect(rendered).toContain("PR #123: Fix mobile auth flow");
    expect(rendered).toContain("https://github.com/acme/mobile/pull/123");
  });
});
