import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
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
    process.chdir(originalCwd);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("renders project identity on the left", () => {
    expect(renderTmuxStatusline(repoRoot, "left")).toContain("aimux");
    expect(renderTmuxStatusline(repoRoot, "left")).toContain("aimux-statusline-");
  });

  it("renders session/task/headline/flash data on the right", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(
      statusPath,
      JSON.stringify({
        sessions: [
          {
            id: "a",
            tool: "codex",
            label: "coder",
            role: "coder",
            status: "running",
            active: true,
            headline: "Fix auth flow",
          },
          { id: "b", tool: "claude", status: "idle" },
        ],
        tasks: { pending: 2, assigned: 1 },
        flash: "Review created: auth",
      }),
    );
    const rendered = renderTmuxStatusline(repoRoot, "right");
    expect(rendered).toContain("●coder(coder)*");
    expect(rendered).toContain("·claude");
    expect(rendered).toContain("tasks 2/1");
    expect(rendered).toContain("Fix auth flow");
    expect(rendered).toContain("Review created: auth");
  });

  it("omits stale statusline files", () => {
    const statusPath = join(getProjectStateDirFor(repoRoot), "statusline.json");
    writeFileSync(statusPath, JSON.stringify({ sessions: [{ id: "a", tool: "codex", status: "running" }] }));
    const stale = new Date(Date.now() - 20_000);
    utimesSync(statusPath, stale, stale);
    expect(renderTmuxStatusline(repoRoot, "right")).toBe("");
  });
});
