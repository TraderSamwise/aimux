import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextWatcher } from "./context-bridge.js";
import { readHistory } from "./history.js";
import { initPaths, getContextDir, getProjectStateDir } from "../paths.js";
import { TmuxRuntimeManager, type TmuxTarget } from "../tmux-runtime-manager.js";

function target(windowId = "@3"): TmuxTarget {
  return {
    sessionName: "aimux-test-session",
    windowId,
    windowIndex: 3,
    windowName: "claude",
  };
}

describe("ContextWatcher tmux continuity", () => {
  let repoRoot = "";
  let projectStateDir = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-context-bridge-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
    projectStateDir = getProjectStateDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(projectStateDir, { recursive: true, force: true });
  });

  it("writes live.md from tmux pane snapshots when no structured history exists", () => {
    vi.spyOn(TmuxRuntimeManager.prototype, "captureTarget").mockReturnValue(
      ["Streaming output", "Still thinking through the change"].join("\n"),
    );

    const watcher = new ContextWatcher();
    (watcher as any).capturePaneSnapshot({
      id: "claude-live",
      command: "claude",
      tmuxTarget: target(),
    });

    const livePath = join(getContextDir(), "claude-live", "live.md");
    const live = readFileSync(livePath, "utf-8");
    expect(live).toContain("# claude-live (claude) — Live Snapshot");
    expect(live).toContain("Streaming output");
    expect(readHistory("claude-live")).toEqual([]);
  });

  it("captures a synthetic response turn when Claude returns to a visible prompt", () => {
    vi.spyOn(TmuxRuntimeManager.prototype, "captureTarget").mockReturnValue(
      ["sam@host ~/repo main", "▶▶ bypass permissions on (shift+tab to cycle)", "❯ "].join("\n"),
    );

    const watcher = new ContextWatcher();
    const session = {
      id: "claude-prompt",
      command: "claude",
      tmuxTarget: target("@4"),
    };

    (watcher as any).capturePaneSnapshot(session);
    (watcher as any).capturePaneSnapshot(session);

    const turns = readHistory("claude-prompt");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.type).toBe("response");
    expect(turns[0]?.content).toContain("bypass permissions");
  });

  it("captures a synthetic response turn when Codex returns to a visible prompt", () => {
    vi.spyOn(TmuxRuntimeManager.prototype, "captureTarget").mockReturnValue(
      ["The work is complete.", "", "› Find and fix a bug in @filename"].join("\n"),
    );

    const watcher = new ContextWatcher();
    const session = {
      id: "codex-prompt",
      command: "codex",
      tmuxTarget: target("@5"),
    };

    (watcher as any).capturePaneSnapshot(session);
    (watcher as any).capturePaneSnapshot(session);

    const turns = readHistory("codex-prompt");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.type).toBe("response");
    expect(turns[0]?.content).toContain("The work is complete.");
    expect(turns[0]?.content).toContain("Find and fix a bug");
  });
});
