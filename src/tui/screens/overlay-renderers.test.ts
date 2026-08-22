import { describe, expect, it, vi } from "vitest";

import {
  buildAgentRestoreConfirmOverlayOutput,
  buildHelpOverlayOutput,
  buildOverseerOverlayOutput,
  buildWorktreeListOverlayOutput,
} from "./overlay-renderers.js";

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

describe("buildAgentRestoreConfirmOverlayOutput", () => {
  it("renders restore and cancel as modal choices", () => {
    const output = plain(
      buildAgentRestoreConfirmOverlayOutput(
        {
          agentRestoreConfirmSelection: "cancel",
          dashboardAgentRestoreOfferCache: {
            sessionIds: ["claude-1", "codex-2"],
            sessions: [
              { id: "claude-1", label: "claude(coder)" },
              { id: "codex-2", label: "codex(coder)" },
            ],
          },
        },
        100,
        30,
      ) ?? "",
    );

    expect(output).toContain("RESTORE AGENTS");
    expect(output).toContain("Restore 2 previously running agents for this project?");
    expect(output).toContain("claude(coder), codex(coder)");
    expect(output).toContain("Restore");
    expect(output).toContain("Cancel");
    expect(output).toContain("←/→  choose");
    expect(output).toContain("Enter  confirm");
    expect(output).toContain("Esc  cancel");
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

describe("buildOverseerOverlayOutput", () => {
  it("renders the off state without requiring a persistent dashboard row", () => {
    const output = plain(
      buildOverseerOverlayOutput(
        {
          dashboardOverseerSessionsCache: [],
          dashboardSessionsCache: [],
          getSelectedDashboardSessionForActions: () => undefined,
        },
        100,
        30,
      ),
    );

    expect(output).toContain("Overseer");
    expect(output).toContain("Status: Off");
    expect(output).toContain("Overseer: none running");
    expect(output).toContain("Watching: 0 agents");
    expect(output).toContain("Enter  start");
    expect(output).toContain("w  watch selected");
  });

  it("renders the live overseer and selected agent loop state", () => {
    const selected = {
      id: "codex-1",
      command: "codex",
      status: "working",
      loop: { active: true, goal: "keep progressing" },
    };
    const output = plain(
      buildOverseerOverlayOutput(
        {
          dashboardOverseerSessionsCache: [{ id: "overseer-1", command: "claude", status: "working" }],
          dashboardSessionsCache: [selected],
          getSelectedDashboardSessionForActions: () => selected,
        },
        100,
        30,
      ),
    );

    expect(output).toContain("Status: Active");
    expect(output).toContain("Overseer: claude working");
    expect(output).toContain("Watching: 1 agent");
    expect(output).toContain("Selected: codex watched");
    expect(output).toContain("codex working - keep progressing");
    expect(output).toContain("x  stop overseer");
  });

  it("reads overseers from the dashboard view model", () => {
    const output = plain(
      buildOverseerOverlayOutput(
        {
          dashboard: {
            viewModel: {
              overseerSessions: [{ id: "overseer-1", command: "claude", status: "ready" }],
            },
          },
          dashboardSessionsCache: [],
          getSelectedDashboardSessionForActions: () => undefined,
        },
        100,
        30,
      ),
    );

    expect(output).toContain("Status: Active");
    expect(output).toContain("Overseer: claude ready");
    expect(output).toContain("x  stop overseer");
  });
});
