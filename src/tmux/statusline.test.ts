import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths, getProjectStateDirFor } from "../paths.js";
import { renderTmuxStatusline } from "./statusline.js";

describe("renderTmuxStatusline", () => {
  const originalCwd = process.cwd();
  let repoRoot = "";
  const freshUpdatedAt = () => new Date().toISOString();

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-statusline-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("renders project identity on the left", () => {
    expect(renderTmuxStatusline(repoRoot, "top")).toContain("aimux");
    expect(renderTmuxStatusline(repoRoot, "top")).toContain("aimux-statusline-");
  });

  it("renders top-line task/context/metadata data", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        updatedAt: freshUpdatedAt(),
        sessions: [
          {
            id: "a",
            tool: "codex",
            label: "coder",
            windowName: "coder",
            role: "coder",
            tmuxWindowId: "@1",
            status: "running",
            active: true,
            headline: "Fix auth flow",
            worktreePath: repoRoot,
          },
          { id: "b", tool: "claude", status: "idle", windowName: "claude", worktreePath: repoRoot },
        ],
        metadata: {
          a: {
            context: {
              worktreeName: "mobile",
              branch: "feat/mobile-auth",
              pr: { number: 123 },
            },
            derived: {
              activity: "running",
              attention: "needs_input",
              unseenCount: 2,
              services: [{ url: "http://localhost:3000", port: 3000 }],
            },
          },
        },
        tasks: { pending: 2, assigned: 1 },
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "top", {
      currentWindow: "coder",
      currentWindowId: "@1",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(rendered).toContain("aimux");
    expect(rendered).toContain("ctl ok");
    expect(rendered).toContain("mobile");
    expect(rendered).toContain("feat/mobile-auth");
    expect(rendered).toContain("PR #123");
    expect(rendered).toContain(":3000");
    expect(rendered).toContain("tasks 2/1");
    expect(rendered).toContain("needs input");
  });

  it("renders bottom-line dashboard-specific screens on the dashboard window", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(statusPath, JSON.stringify({ updatedAt: freshUpdatedAt(), sessions: [], dashboardScreen: "plans" }));
    const rendered = renderTmuxStatusline(repoRoot, "bottom", { currentWindow: "dashboard", currentPath: repoRoot });
    expect(rendered).toContain("dashboard");
    expect(rendered).toContain("#[fg=black,bg=yellow] plans #[default]");
    expect(rendered).toContain("graveyard");
  });

  it("uses existing statusline data even if it is not freshly rewritten", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        updatedAt: freshUpdatedAt(),
        sessions: [
          {
            id: "a",
            tool: "codex",
            label: "coder",
            windowName: "coder",
            tmuxWindowId: "@1",
            status: "running",
            active: true,
            worktreePath: repoRoot,
          },
        ],
        metadata: {
          a: {
            context: { worktreeName: "mobile", branch: "feat/mobile-auth" },
            derived: { attention: "needs_input" },
          },
        },
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "top", {
      currentWindow: "coder",
      currentWindowId: "@1",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(rendered).toContain("ctl ok");
    expect(rendered).toContain("mobile");
    expect(rendered).toContain("needs input");
  });

  it("trims bottom-line segments to available width", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        updatedAt: freshUpdatedAt(),
        sessions: [],
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "bottom", {
      currentWindow: "very-long-window-name-for-codex-agent",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 70,
    });
    expect(rendered.length).toBeLessThanOrEqual(68);
  });

  it("renders bottom-line scoped agents and headline data", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        updatedAt: freshUpdatedAt(),
        sessions: [
          {
            id: "a",
            tool: "codex",
            label: "coder",
            windowName: "coder",
            tmuxWindowId: "@1",
            role: "coder",
            status: "running",
            active: true,
            headline: "Fix auth flow",
            worktreePath: repoRoot,
          },
          { id: "b", tool: "claude", status: "idle", windowName: "claude", worktreePath: repoRoot },
        ],
        metadata: {
          a: { derived: { attention: "needs_input", unseenCount: 3 } },
          b: { derived: { activity: "done" } },
        },
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "bottom", {
      currentWindow: "coder",
      currentWindowId: "@1",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(rendered).toContain("#[fg=black,bg=yellow] coder(coder) on you ? #[default]");
    expect(rendered).toContain("claude ✓");
    expect(rendered).toContain("  |  Fix auth flow");
    expect(rendered).toContain("Fix auth flow");
  });

  it("renders plugin-provided statusline segments for the active session", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        updatedAt: freshUpdatedAt(),
        sessions: [
          {
            id: "a",
            tool: "codex",
            label: "coder",
            windowName: "coder",
            tmuxWindowId: "@1",
            role: "coder",
            status: "running",
            active: true,
            headline: "Fix auth flow",
            worktreePath: repoRoot,
          },
        ],
        metadata: {
          a: {
            statusline: {
              top: [{ id: "transcript-length", text: "80kb" }],
              bottom: [{ id: "transcript-length", text: "80kb" }],
            },
          },
        },
      }),
    );
    const renderedTop = renderTmuxStatusline(repoRoot, "top", {
      currentWindow: "coder",
      currentWindowId: "@1",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    const renderedBottom = renderTmuxStatusline(repoRoot, "bottom", {
      currentWindow: "coder",
      currentWindowId: "@1",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(renderedTop).toContain("80kb");
    expect(renderedBottom).toContain("80kb");
  });

  it("renders scoped services alongside agents in the bottom line", () => {
    const nestedPath = join(repoRoot, ".aimux", "worktrees", "tealstreet-pr5180");
    mkdirSync(nestedPath, { recursive: true });
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        updatedAt: freshUpdatedAt(),
        sessions: [
          {
            id: "a",
            kind: "agent",
            tool: "claude",
            label: "claude-zjlduv",
            windowName: "claude",
            tmuxWindowId: "@7",
            role: "coder",
            headline: "Needs review",
            worktreePath: nestedPath,
          },
          {
            id: "svc-1",
            kind: "service",
            tool: "shell",
            label: "shell",
            windowName: "shell",
            tmuxWindowId: "@9",
            headline: "zsh",
            worktreePath: nestedPath,
          },
        ],
        metadata: {
          a: { derived: { attention: "needs_input" } },
        },
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "bottom", {
      currentWindow: "claude",
      currentWindowId: "@7",
      currentPath: join(nestedPath, "src"),
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(rendered).toContain("#[fg=black,bg=yellow] claude(coder) on you ? #[default]");
    expect(rendered).toContain("shell[svc]");
  });

  it("omits offline and exited sessions from scoped footer chips", () => {
    const nestedPath = join(repoRoot, ".aimux", "worktrees", "tealstreet-pr5180");
    mkdirSync(nestedPath, { recursive: true });
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        updatedAt: freshUpdatedAt(),
        sessions: [
          {
            id: "live-agent",
            kind: "agent",
            tool: "claude",
            label: "claude-live",
            windowName: "claude",
            tmuxWindowId: "@7",
            role: "coder",
            status: "running",
            worktreePath: nestedPath,
          },
          {
            id: "offline-agent",
            kind: "agent",
            tool: "codex",
            label: "codex-offline",
            windowName: "codex",
            tmuxWindowId: "@8",
            status: "offline",
            worktreePath: nestedPath,
          },
          {
            id: "exited-service",
            kind: "service",
            tool: "shell",
            label: "shell",
            windowName: "shell",
            tmuxWindowId: "@9",
            status: "exited",
            worktreePath: nestedPath,
          },
        ],
        metadata: {
          "live-agent": { derived: { attention: "needs_input" } },
        },
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "bottom", {
      currentWindow: "claude",
      currentWindowId: "@7",
      currentPath: join(nestedPath, "src"),
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(rendered).toContain("#[fg=black,bg=yellow] claude(coder) on you ? #[default]");
    expect(rendered).not.toContain("codex-offline");
    expect(rendered).not.toContain("shell[svc]");
  });

  it("scopes bottom-line agents to the enclosing worktree root for nested cwd paths", () => {
    const nestedPath = join(repoRoot, ".aimux", "worktrees", "tealchart-cleanup-11");
    mkdirSync(nestedPath, { recursive: true });
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        updatedAt: freshUpdatedAt(),
        sessions: [
          {
            id: "a",
            tool: "claude",
            label: "Claude",
            windowName: "claude",
            tmuxWindowId: "@7",
            role: "coder",
            headline: "Needs review",
            worktreePath: nestedPath,
          },
          {
            id: "b",
            tool: "codex",
            label: "Codex",
            windowName: "codex",
            tmuxWindowId: "@8",
            role: "reviewer",
            headline: "Running tests",
            worktreePath: nestedPath,
          },
        ],
        metadata: {
          a: { derived: { attention: "needs_input" } },
          b: { derived: { activity: "running" } },
        },
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "bottom", {
      currentWindow: "claude",
      currentWindowId: "@7",
      currentPath: join(nestedPath, "src", "components"),
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(rendered).toContain("#[fg=black,bg=yellow] claude(coder) on you ? #[default]");
    expect(rendered).toContain("codex(reviewer) ↻");
    expect(rendered).toContain("Needs review");
  });

  it("disambiguates duplicate tmux window names by current path", () => {
    const otherWorktree = join(repoRoot, "worktree-a");
    mkdirSync(otherWorktree, { recursive: true });
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        updatedAt: freshUpdatedAt(),
        sessions: [
          {
            id: "a",
            tool: "codex",
            label: "codex",
            windowName: "codex",
            tmuxWindowId: "@1",
            role: "coder",
            status: "running",
            active: false,
            worktreePath: repoRoot,
          },
          {
            id: "b",
            tool: "codex",
            label: "codex",
            windowName: "codex",
            tmuxWindowId: "@2",
            status: "running",
            active: true,
            worktreePath: otherWorktree,
          },
        ],
        metadata: {
          a: { derived: { attention: "needs_input" }, context: { worktreeName: "main", branch: "master" } },
          b: { derived: { activity: "running" }, context: { worktreeName: "worktree-a", branch: "feat/x" } },
        },
      }),
    );
    const top = renderTmuxStatusline(repoRoot, "top", {
      currentWindow: "codex",
      currentWindowId: "@1",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    const bottom = renderTmuxStatusline(repoRoot, "bottom", {
      currentWindow: "codex",
      currentWindowId: "@1",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(top).toContain("needs input");
    expect(bottom).toContain("codex(coder) on you ?");
    expect(bottom).not.toContain("[codex ↻]");
  });
});
