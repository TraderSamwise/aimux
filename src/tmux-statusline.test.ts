import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths, getProjectStateDirFor } from "./paths.js";
import { renderTmuxStatusline } from "./tmux-statusline.js";

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
        sessions: [],
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "top", {
      currentWindow: "coder",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(rendered).toContain("aimux");
    expect(rendered).toContain("ctl ok");
    expect(rendered).not.toContain("mobile");
  });

  it("renders bottom-line dashboard-specific screens on the dashboard window", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(statusPath, JSON.stringify({ updatedAt: freshUpdatedAt(), sessions: [], dashboardScreen: "plans" }));
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
        updatedAt: freshUpdatedAt(),
        sessions: [{ id: "a", tool: "codex", label: "coder", status: "running", active: true, worktreePath: repoRoot }],
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "top", {
      currentWindow: "coder",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(rendered).toContain("ctl ok");
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
        sessions: [],
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "bottom", {
      currentWindow: "coder",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
      width: 220,
    });
    expect(rendered).toBe("[coder]");
  });

  it("disambiguates duplicate tmux window names by current path", () => {
    const otherWorktree = join(repoRoot, "worktree-a");
    mkdirSync(otherWorktree, { recursive: true });
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        updatedAt: freshUpdatedAt(),
        sessions: [],
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
    expect(top).toContain("ctl ok");
    expect(bottom).toContain("[codex]");
  });
});
