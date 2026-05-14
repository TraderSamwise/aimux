import { describe, it, expect, beforeEach, vi } from "vitest";

const execSyncMock = vi.fn();
const execFileSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const loadConfigMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: execFileSyncMock,
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
    execFileSyncMock.mockReset();
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
    execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === "show-ref") throw new Error("missing branch");
      return "";
    });
    const { createWorktree } = await import("./worktree.js");

    const target = createWorktree("fix-auth", "/repo");

    expect(target).toBe("/repo/.aimux/worktrees/fix-auth");
    expect(mkdirSyncMock).toHaveBeenCalledWith("/repo/.aimux/worktrees", { recursive: true });
    expect(execFileSyncMock).toHaveBeenLastCalledWith("git", ["worktree", "add", target, "-b", "fix-auth"], {
      cwd: "/repo",
      encoding: "utf-8",
      stdio: "pipe",
    });
  });

  it("checks out an existing branch instead of recreating it", async () => {
    execSyncMock.mockReturnValue("worktree /repo\n");
    execFileSyncMock.mockReturnValue("");
    const { createWorktree } = await import("./worktree.js");

    const target = createWorktree("fix-auth", "/repo");

    expect(execFileSyncMock).toHaveBeenLastCalledWith("git", ["worktree", "add", target, "fix-auth"], {
      cwd: "/repo",
      encoding: "utf-8",
      stdio: "pipe",
    });
  });

  it("identifies Claude private agent scratch worktrees", async () => {
    const { isToolInternalWorktree } = await import("./worktree.js");

    expect(
      isToolInternalWorktree({
        name: "agent-a79377141defdccc4",
        path: "/repo/.claude/worktrees/agent-a79377141defdccc4",
        branch: "worktree-agent-a79377141defdccc4",
      }),
    ).toBe(true);
    expect(
      isToolInternalWorktree({
        name: "desktop-enhancements",
        path: "/repo/.claude/worktrees/desktop-enhancements",
        branch: "worktree-desktop-enhancements",
      }),
    ).toBe(false);
  });
});
