import { describe, it, expect, beforeEach, vi } from "vitest";

const execSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const loadConfigMock = vi.fn();

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

vi.mock("node:fs", () => ({
  mkdirSync: mkdirSyncMock,
}));

vi.mock("./config.js", () => ({
  loadConfig: loadConfigMock,
}));

describe("worktree helpers", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue({
      worktrees: {
        baseDir: ".aimux/worktrees",
      },
    });
  });

  it("resolves created worktrees under .aimux/worktrees by default", async () => {
    execSyncMock.mockReturnValue("worktree /repo\n");
    const { getWorktreeCreatePath } = await import("./worktree.js");

    expect(getWorktreeCreatePath("fix-auth", "/repo")).toBe("/repo/.aimux/worktrees/fix-auth");
  });

  it("supports absolute worktree base directories", async () => {
    loadConfigMock.mockReturnValue({
      worktrees: {
        baseDir: "/tmp/aimux-worktrees",
      },
    });
    execSyncMock.mockReturnValue("worktree /repo\n");
    const { getWorktreeCreatePath } = await import("./worktree.js");

    expect(getWorktreeCreatePath("fix-auth", "/repo")).toBe("/tmp/aimux-worktrees/fix-auth");
  });

  it("creates the parent directory before adding the worktree", async () => {
    execSyncMock.mockReturnValue("worktree /repo\n");
    const { createWorktree } = await import("./worktree.js");

    const target = createWorktree("fix-auth", "/repo");

    expect(target).toBe("/repo/.aimux/worktrees/fix-auth");
    expect(mkdirSyncMock).toHaveBeenCalledWith("/repo/.aimux/worktrees", { recursive: true });
    expect(execSyncMock).toHaveBeenCalledWith('git worktree add "/repo/.aimux/worktrees/fix-auth" -b "fix-auth"', {
      cwd: "/repo",
      encoding: "utf-8",
      stdio: "pipe",
    });
  });
});
