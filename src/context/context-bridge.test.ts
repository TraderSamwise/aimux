import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextWatcher } from "./context-bridge.js";
import { readHistory } from "./history.js";
import { initPaths, getContextDir, getProjectStateDir } from "../paths.js";
import { type TmuxTarget } from "../tmux-runtime-manager.js";
import { AGENT_OUTPUT_PARSER_FIXTURES } from "../agent-output-parser-fixtures.js";

function target(windowId = "@3"): TmuxTarget {
  return {
    sessionName: "aimux-test-session",
    windowId,
    windowIndex: 3,
    windowName: "claude",
  };
}

const parserFixture = (name: string) => {
  const fixture = AGENT_OUTPUT_PARSER_FIXTURES.find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`Missing parser fixture ${name}`);
  return fixture;
};

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
    const watcher = new ContextWatcher(() => ["Streaming output", "Still thinking through the change"].join("\n"));
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

  it("bounds live.md to recent pane content instead of growing unbounded", () => {
    const huge = Array.from({ length: 400 }, (_, index) => `line-${index.toString().padStart(3, "0")}`).join("\n");
    const watcher = new ContextWatcher(() => huge);
    (watcher as any).capturePaneSnapshot({
      id: "claude-bounded",
      command: "claude",
      tmuxTarget: target("@6"),
    });

    const livePath = join(getContextDir(), "claude-bounded", "live.md");
    const live = readFileSync(livePath, "utf-8");
    expect(live).not.toContain("line-000");
    expect(live).toContain("line-399");
    expect(Buffer.byteLength(live)).toBeLessThan(55 * 1024);
  });

  it("does not capture terminal chrome as a Claude response turn", () => {
    const watcher = new ContextWatcher(() =>
      ["sam@host ~/repo main", "▶▶ bypass permissions on (shift+tab to cycle)", "❯ "].join("\n"),
    );
    const session = {
      id: "claude-prompt",
      command: "claude",
      tmuxTarget: target("@4"),
    };

    (watcher as any).capturePaneSnapshot(session);
    (watcher as any).capturePaneSnapshot(session);

    const turns = readHistory("claude-prompt");
    expect(turns).toEqual([]);
  });

  it("captures only the last parsed response when Codex returns to a visible prompt", () => {
    const watcher = new ContextWatcher(() =>
      ["• The work is complete.", "", "› Find and fix a bug in @filename"].join("\n"),
    );
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
    expect(turns[0]?.content).not.toContain("Find and fix a bug");
  });

  it("does not capture Codex startup chrome as a response turn", () => {
    const watcher = new ContextWatcher(() =>
      [
        "╭──────────────────────────────────────────────╮",
        "│ >_ OpenAI Codex (v0.60.0)                    │",
        "│                                              │",
        "│ cwd: ~/repo                                  │",
        "╰──────────────────────────────────────────────╯",
        "",
        "› Find and fix a bug in @filename",
      ].join("\n"),
    );
    const session = {
      id: "codex-startup",
      command: "codex",
      tmuxTarget: target("@7"),
    };

    (watcher as any).capturePaneSnapshot(session);

    expect(readHistory("codex-startup")).toEqual([]);
  });

  it("does not capture Codex progress rows as a response turn", () => {
    const watcher = new ContextWatcher(() =>
      [
        "› reply exactly CODEX_OK",
        "",
        "• Starting MCP servers",
        "• Sautéed for 5s",
        "",
        "›",
      ].join("\n"),
    );
    const session = {
      id: "codex-progress",
      command: "codex",
      tmuxTarget: target("@8"),
    };

    (watcher as any).capturePaneSnapshot(session);

    expect(readHistory("codex-progress")).toEqual([]);
  });

  it("does not capture mined Codex startup suggestion loops as response turns", () => {
    const fixture = parserFixture("codex-live-startup-suggestion-loop");
    const watcher = new ContextWatcher(() => fixture.raw);
    const session = {
      id: "codex-startup-loop",
      command: "codex",
      tmuxTarget: target("@9"),
    };

    (watcher as any).capturePaneSnapshot(session);

    expect(readHistory("codex-startup-loop")).toEqual([]);
  });

  it("captures Claude responses without capturing mined tool action rows", () => {
    const fixture = parserFixture("claude-live-tool-action-rows");
    const watcher = new ContextWatcher(() => [fixture.raw, "", "❯ "].join("\n"));
    const session = {
      id: "claude-tool-actions",
      command: "claude",
      tmuxTarget: target("@10"),
    };

    (watcher as any).capturePaneSnapshot(session);

    const turns = readHistory("claude-tool-actions");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.type).toBe("response");
    expect(turns[0]?.content).toContain("All checks are green");
    expect(turns[0]?.content).not.toContain("Bash(cd");
    expect(turns[0]?.content).not.toContain("Read 2 files");
    expect(turns[0]?.content).not.toContain("Update(src/relay.ts)");
  });
});
