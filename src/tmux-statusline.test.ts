import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths, getProjectStateDirFor } from "./paths.js";
import { renderTmuxStatusline } from "./tmux-statusline.js";
import { TmuxRuntimeManager } from "./tmux-runtime-manager.js";

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
    expect(renderTmuxStatusline(repoRoot, "left")).toContain("aimux");
    expect(renderTmuxStatusline(repoRoot, "left")).toContain("aimux-statusline-");
  });

  it("renders session/task/headline/flash data on the right", () => {
    vi.spyOn(TmuxRuntimeManager.prototype, "listManagedWindows").mockReturnValue([
      {
        target: { sessionName: "aimux-mobile", windowId: "@1", windowIndex: 1, windowName: "coder" },
        metadata: {
          sessionId: "a",
          command: "codex",
          args: [],
          toolConfigKey: "codex",
          label: "coder",
          worktreePath: repoRoot,
        },
      },
      {
        target: { sessionName: "aimux-mobile", windowId: "@2", windowIndex: 2, windowName: "claude" },
        metadata: {
          sessionId: "b",
          command: "claude",
          args: [],
          toolConfigKey: "claude",
          worktreePath: repoRoot,
        },
      },
    ]);
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
        tasks: { pending: 2, assigned: 1 },
        flash: "Review created: auth",
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "right", {
      currentWindow: "coder",
      currentPath: repoRoot,
      currentSession: "aimux-mobile",
    });
    expect(rendered).toContain("●coder(coder)*");
    expect(rendered).toContain("·claude");
    expect(rendered).toContain("tasks 2/1");
    expect(rendered).toContain("Fix auth flow");
    expect(rendered).toContain("Review created: auth");
  });

  it("renders dashboard-specific screens on the dashboard window", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(statusPath, JSON.stringify({ sessions: [], dashboardScreen: "plans" }));
    const rendered = renderTmuxStatusline(repoRoot, "right", { currentWindow: "dashboard", currentPath: repoRoot });
    expect(rendered).toContain("dashboard");
    expect(rendered).toContain("[plans]");
    expect(rendered).toContain("graveyard");
  });

  it("omits stale statusline files", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(statusPath, JSON.stringify({ sessions: [{ id: "a", tool: "codex", status: "running" }] }));
    const stale = new Date(Date.now() - 20_000);
    utimesSync(statusPath, stale, stale);
    expect(renderTmuxStatusline(repoRoot, "right")).toBe("");
  });
});
