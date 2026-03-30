import { describe, expect, it, vi } from "vitest";
import { TmuxRuntimeManager, type TmuxExec, type TmuxInteractiveExec } from "./tmux-runtime-manager.js";

function createExecMock(): TmuxExec & { calls: Array<{ args: string[]; cwd?: string }> } {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const exec = ((args: string[], options?: { cwd?: string }) => {
    calls.push({ args, cwd: options?.cwd });
    const joined = args.join(" ");
    if (joined === "-V") return "tmux 3.5a";
    if (joined.startsWith("has-session -t ")) throw new Error("missing");
    if (joined.startsWith("list-windows -t ")) return "";
    if (joined.startsWith("show-window-options -v -t @3 @aimux-meta")) {
      return JSON.stringify({
        sessionId: "codex-abc123",
        command: "codex",
        args: ["--full-auto"],
        toolConfigKey: "codex",
        worktreePath: "/repo/mobile",
      });
    }
    if (joined.startsWith("new-window -P")) return "@3\t3\tcodex";
    return "";
  }) as TmuxExec & { calls: Array<{ args: string[]; cwd?: string }> };
  exec.calls = calls;
  return exec;
}

describe("TmuxRuntimeManager", () => {
  it("detects tmux availability", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    expect(manager.isAvailable()).toBe(true);
    expect(exec.calls[0]?.args).toEqual(["-V"]);
  });

  it("derives deterministic per-project session names", () => {
    const manager = new TmuxRuntimeManager(createExecMock());
    const a = manager.getProjectSession("/repo/mobile");
    const b = manager.getProjectSession("/repo/mobile");
    const c = manager.getProjectSession("/repo/web");
    expect(a.sessionName).toBe(b.sessionName);
    expect(a.projectId).toBe(b.projectId);
    expect(a.sessionName).not.toBe(c.sessionName);
    expect(a.sessionName).toMatch(/^aimux-mobile-/);
  });

  it("creates a detached project session when missing", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    const session = manager.ensureProjectSession("/repo/mobile");
    expect(session.sessionName).toMatch(/^aimux-mobile-/);
    expect(exec.calls.some((call) => call.args[0] === "new-session")).toBe(true);
    const createCall = exec.calls.find((call) => call.args[0] === "new-session");
    expect(createCall?.cwd).toBe("/repo/mobile");
    expect(exec.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          args: ["set-option", "-t", session.sessionName, "prefix", "C-a"],
        }),
        expect.objectContaining({
          args: ["set-option", "-t", session.sessionName, "prefix2", "C-b"],
        }),
        expect.objectContaining({
          args: ["bind-key", "-T", "prefix", "C-a", "send-prefix"],
        }),
        expect.objectContaining({
          args: [
            "bind-key",
            "-T",
            "prefix",
            "d",
            "run-shell",
            "-b",
            "cd '#{pane_current_path}' && aimux >/dev/null 2>&1",
          ],
        }),
      ]),
    );
  });

  it("creates a dashboard window when missing", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    vi.spyOn(manager, "listWindows")
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ id: "@0", index: 0, name: "dashboard", active: true }]);
    const target = manager.ensureDashboardWindow("aimux-mobile-abc", "/repo/mobile");
    expect(target.windowId).toBe("@0");
    expect(exec.calls.some((call) => call.args[0] === "new-window")).toBe(true);
  });

  it("creates agent windows with target metadata", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    const target = manager.createWindow("aimux-mobile-abc", "codex", "/repo/mobile", "codex", ["--full-auto"]);
    expect(target).toEqual({
      sessionName: "aimux-mobile-abc",
      windowId: "@3",
      windowIndex: 3,
      windowName: "codex",
    });
    expect(exec.calls.at(-1)?.args.slice(0, 8)).toEqual([
      "new-window",
      "-P",
      "-t",
      "aimux-mobile-abc",
      "-c",
      "/repo/mobile",
      "-n",
      "codex",
    ]);
  });

  it("switches client inside tmux and attaches outside tmux", () => {
    const exec = createExecMock();
    const interactiveCalls: Array<{ args: string[]; cwd?: string }> = [];
    const interactiveExec: TmuxInteractiveExec = (args, options) => {
      interactiveCalls.push({ args, cwd: options?.cwd });
    };
    const manager = new TmuxRuntimeManager(exec, interactiveExec);
    const target = {
      sessionName: "aimux-mobile-abc",
      windowId: "@3",
      windowIndex: 3,
      windowName: "codex",
    };

    manager.openTarget(target, { insideTmux: true });
    manager.openTarget(target, { insideTmux: false });

    expect(interactiveCalls.at(-2)?.args).toEqual(["switch-client", "-t", "aimux-mobile-abc:3"]);
    expect(interactiveCalls.at(-1)?.args).toEqual(["attach-session", "-t", "aimux-mobile-abc"]);
  });

  it("captures pane output and sends input primitives", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    const target = {
      sessionName: "aimux-mobile-abc",
      windowId: "@3",
      windowIndex: 3,
      windowName: "codex",
    };

    manager.captureTarget(target, { startLine: -200 });
    manager.sendText(target, "hello");
    manager.sendEnter(target);

    expect(exec.calls.at(-3)?.args).toEqual(["capture-pane", "-p", "-J", "-t", "@3", "-S", "-200"]);
    expect(exec.calls.at(-2)?.args).toEqual(["send-keys", "-t", "@3", "-l", "hello"]);
    expect(exec.calls.at(-1)?.args).toEqual(["send-keys", "-t", "@3", "Enter"]);
  });

  it("stores and reads aimux metadata on tmux windows", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    const target = {
      sessionName: "aimux-mobile-abc",
      windowId: "@3",
      windowIndex: 3,
      windowName: "codex",
    };

    manager.setWindowMetadata(target, {
      sessionId: "codex-abc123",
      command: "codex",
      args: ["--full-auto"],
      toolConfigKey: "codex",
      worktreePath: "/repo/mobile",
    });

    expect(exec.calls.at(-1)?.args).toEqual([
      "set-window-option",
      "-q",
      "-t",
      "@3",
      "@aimux-meta",
      JSON.stringify({
        sessionId: "codex-abc123",
        command: "codex",
        args: ["--full-auto"],
        toolConfigKey: "codex",
        worktreePath: "/repo/mobile",
      }),
    ]);

    expect(manager.getWindowMetadata(target)).toEqual({
      sessionId: "codex-abc123",
      command: "codex",
      args: ["--full-auto"],
      toolConfigKey: "codex",
      worktreePath: "/repo/mobile",
    });
  });

  it("respawns a window with a specific command", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    manager.respawnWindow(
      {
        sessionName: "aimux-mobile-abc",
        windowId: "@0",
        windowIndex: 0,
        windowName: "dashboard",
      },
      {
        cwd: "/repo/mobile",
        command: "/usr/local/bin/node",
        args: ["/repo/mobile/dist/main.js", "--tmux-dashboard-internal"],
      },
    );
    expect(exec.calls.at(-1)?.args).toEqual([
      "respawn-window",
      "-k",
      "-t",
      "@0",
      "-c",
      "/repo/mobile",
      "/usr/local/bin/node",
      "/repo/mobile/dist/main.js",
      "--tmux-dashboard-internal",
    ]);
  });

  it("detects whether aimux is already inside tmux", () => {
    const manager = new TmuxRuntimeManager(createExecMock());
    expect(manager.isInsideTmux({ TMUX: "/tmp/tmux-1000/default,123,0" } as NodeJS.ProcessEnv)).toBe(true);
    expect(manager.isInsideTmux({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
