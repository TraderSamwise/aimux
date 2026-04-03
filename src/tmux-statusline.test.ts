import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths, getProjectStateDirFor } from "./paths.js";
import { renderTmuxStatusline } from "./tmux-statusline.js";

describe("renderTmuxStatusline", () => {
  const originalCwd = process.cwd();
  let repoRoot = "";

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
        sessions: [
          {
            id: "a",
            tool: "codex",
            label: "coder",
            windowName: "coder",
            role: "coder",
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
        flash: "Review created: auth",
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "top", {
      currentWindow: "coder",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(rendered).toContain("aimux");
    expect(rendered).toContain("mobile");
    expect(rendered).toContain("feat/mobile-auth");
    expect(rendered).toContain("PR #123");
    expect(rendered).toContain(":3000");
    expect(rendered).toContain("tasks 2/1");
    expect(rendered).toContain("needs input");
  });

  it("renders bottom-line dashboard-specific screens on the dashboard window", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(statusPath, JSON.stringify({ sessions: [], dashboardScreen: "plans" }));
    const rendered = renderTmuxStatusline(repoRoot, "bottom", { currentWindow: "dashboard", currentPath: repoRoot });
    expect(rendered).toContain("dashboard");
    expect(rendered).toContain("[plans]");
    expect(rendered).toContain("graveyard");
  });

  it("uses existing statusline data even if it is not freshly rewritten", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        sessions: [{ id: "a", tool: "codex", label: "coder", status: "running", active: true, worktreePath: repoRoot }],
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
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(rendered).toContain("mobile");
    expect(rendered).toContain("needs input");
  });

  it("trims bottom-line segments to available width", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        sessions: [{ id: "a", tool: "codex", label: "coder", status: "running", active: true, worktreePath: repoRoot }],
        metadata: {
          a: {
            context: { worktreeName: "very-long-worktree-name", branch: "very-long-branch-name", pr: { number: 123 } },
            status: { text: "Working through a long task description" },
            derived: { activity: "running" },
          },
        },
        flash: "Review created: auth",
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "bottom", {
      currentWindow: "coder",
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
        sessions: [
          {
            id: "a",
            tool: "codex",
            label: "coder",
            windowName: "coder",
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
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(rendered).toContain("[coder(coder) on you ?]");
    expect(rendered).toContain("claude ✓");
    expect(rendered).toContain("Fix auth flow");
  });

  it("disambiguates duplicate tmux window names by current path", () => {
    const otherWorktree = join(repoRoot, "worktree-a");
    mkdirSync(otherWorktree, { recursive: true });
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        sessions: [
          {
            id: "a",
            tool: "codex",
            label: "codex",
            role: "coder",
            status: "running",
            active: false,
            worktreePath: repoRoot,
          },
          { id: "b", tool: "codex", label: "codex", status: "running", active: true, worktreePath: otherWorktree },
        ],
        metadata: {
          a: { derived: { attention: "needs_input" }, context: { worktreeName: "main", branch: "master" } },
          b: { derived: { activity: "running" }, context: { worktreeName: "worktree-a", branch: "feat/x" } },
        },
      }),
    );
    const top = renderTmuxStatusline(repoRoot, "top", {
      currentWindow: "codex",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    const bottom = renderTmuxStatusline(repoRoot, "bottom", {
      currentWindow: "codex",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(top).toContain("needs input");
    expect(bottom).toContain("codex(coder) on you ?");
    expect(bottom).not.toContain("[codex ↻]");
  });
});
