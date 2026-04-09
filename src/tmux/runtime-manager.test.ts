import { describe, expect, it, vi } from "vitest";
import {
  MANAGED_TMUX_AGENT_WINDOW_OPTIONS,
  TmuxRuntimeManager,
  type TmuxExec,
  type TmuxInteractiveExec,
} from "./runtime-manager.js";

function createExecMock(): TmuxExec & { calls: Array<{ args: string[]; cwd?: string }> } {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const exec = ((args: string[], options?: { cwd?: string }) => {
    calls.push({ args, cwd: options?.cwd });
    const joined = args.join(" ");
    if (joined === "-V") return "tmux 3.5a";
    if (joined.startsWith("has-session -t ")) throw new Error("missing");
    if (joined.startsWith("list-windows -t aimux-mobile-abc-client-")) {
      const linked = calls.some((call) => call.args[0] === "link-window");
      return linked ? "@0\t0\tdashboard-268eff9c\t1\t100\n@3\t3\tcodex\t0\t90" : "@0\t0\tdashboard-268eff9c\t1\t100";
    }
    if (joined.startsWith("list-windows -t ")) return "";
    if (joined.startsWith("display-message -p -t @0 #{pane_dead}")) return "0";
    if (joined === "display-message -p #{client_session}") return "user-main";
    if (joined === "display-message -p #{client_tty}") return "/dev/ttys111";
    if (joined === "display-message -p #{window_id}") return "@3";
    if (joined === "display-message -p #{window_name}") return "codex";
    if (joined.startsWith("show-options -v -t aimux-mobile-abc @aimux-project-root")) return "/repo/mobile";
    if (joined.startsWith("show-options -v -t aimux-mobile-abc @aimux-return-session")) return "user-main";
    if (joined.startsWith("show-options -v -t aimux-mobile-abc terminal-features")) return "";
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

  it("treats missing tmux server state as empty session and window lists", () => {
    const exec = vi.fn<TmuxExec>((args: string[]) => {
      const joined = args.join(" ");
      if (joined === "-V") return "tmux 3.5a";
      if (joined === "list-sessions -F #{session_name}") {
        throw new Error("error connecting to /private/tmp/tmux-501/default (No such file or directory)");
      }
      if (joined.startsWith("list-windows -t aimux-mobile-abc ")) {
        throw new Error("error connecting to /private/tmp/tmux-501/default (No such file or directory)");
      }
      return "";
    });
    const manager = new TmuxRuntimeManager(exec);

    expect(manager.listSessionNames()).toEqual([]);
    expect(manager.listWindows("aimux-mobile-abc")).toEqual([]);
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
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "prefix")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "prefix2")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "mouse")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "set-clipboard")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "copy-command")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "repeat-time")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "extended-keys")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "extended-keys-format")).toBe(
      true,
    );
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "focus-events")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "bell-action")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-window-option" && call.args[3] === "monitor-bell")).toBe(
      true,
    );
    expect(
      exec.calls.some((call) => call.args[0] === "source-file" && call.args[1]?.includes("mouse-bindings.conf")),
    ).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "status")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "status-interval")).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "bind-key" && call.args[1] === "-T" && call.args[2] === "prefix" && call.args[3] === "q",
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "bind-key" && call.args[1] === "-T" && call.args[2] === "prefix" && call.args[3] === "Any",
      ),
    ).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "unbind-key" && call.args[3] === "s")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "unbind-key" && call.args[3] === "n")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "unbind-key" && call.args[3] === "p")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "unbind-key" && call.args[3] === "u")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "unbind-key" && call.args[3] === "d")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "unbind-key" && call.args[3] === "K")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "bind-key" && call.args[3] === "C-a")).toBe(true);
    expect(
      exec.calls.some(
        (call) => call.args[0] === "bind-key" && call.args.join(" ").includes("scripts/tmux-control.sh' menu"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "bind-key" &&
          call.args[1] === "-r" &&
          call.args.join(" ").includes("scripts/tmux-control.sh' next"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "bind-key" &&
          call.args.includes("n") &&
          call.args.join(" ").includes("--current-window-id '#{window_id}'") &&
          call.args.join(" ").includes("--pane-id '#{pane_id}'"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "bind-key" &&
          call.args[1] === "-r" &&
          call.args.join(" ").includes("scripts/tmux-control.sh' prev"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) => call.args[0] === "bind-key" && call.args.join(" ").includes("scripts/tmux-control.sh' attention"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "bind-key" &&
          call.args.join(" ").includes(" prefix d ") &&
          call.args[4] === "if-shell" &&
          call.args.join(" ").includes("tmux select-window -t :0") &&
          call.args.join(" ").includes("scripts/tmux-control.sh") &&
          call.args.join(" ").includes(" dashboard --project-root "),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "bind-key" &&
          call.args[1] === "-T" &&
          call.args[2] === "prefix" &&
          call.args[3] === "K" &&
          call.args[4] === "clear-history" &&
          call.args.includes("C-l"),
      ),
    ).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "status-left")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "status-right")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "status-format[0]")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "status-format[1]")).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "set-option" &&
          call.args[3] === "status-format[0]" &&
          call.args[4]?.includes("scripts/tmux-statusline.sh"),
      ),
    ).toBe(true);
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

  it("detects whether a window is alive", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    expect(
      manager.isWindowAlive({
        sessionName: "aimux-mobile-abc",
        windowId: "@0",
        windowIndex: 0,
        windowName: "dashboard",
      }),
    ).toBe(true);
  });

  it("lists managed windows across the host and client project session family without duplicates", () => {
    const hostSessionName = new TmuxRuntimeManager(createExecMock()).getProjectSession("/repo/mobile").sessionName;
    const clientSessionName = `${hostSessionName}-client-deadbeef`;
    const exec = vi.fn<TmuxExec>((args: string[]) => {
      const joined = args.join(" ");
      if (joined === "-V") return "tmux 3.5a";
      if (joined === "list-sessions -F #{session_name}") {
        return `${hostSessionName}\n${clientSessionName}\nother`;
      }
      if (
        joined ===
        `list-windows -t ${hostSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}`
      ) {
        return "@3\t3\tcodex\t1\t100\n@9\t9\tshell\t0\t90";
      }
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}`
      ) {
        return "@3\t3\tcodex\t0\t100\n@10\t10\tdashboard\t1\t110";
      }
      if (joined === "show-window-options -v -t @3 @aimux-meta") {
        return JSON.stringify({
          sessionId: "codex-abc123",
          command: "codex",
          args: ["--full-auto"],
          toolConfigKey: "codex",
          worktreePath: "/repo/mobile",
        });
      }
      if (joined === "show-window-options -v -t @9 @aimux-meta") {
        return JSON.stringify({
          sessionId: "service-123",
          command: "shell",
          args: ["-lc", "npm run dev"],
          toolConfigKey: "service",
          worktreePath: "/repo/mobile",
          kind: "service",
        });
      }
      if (joined === "show-window-options -v -t @10 @aimux-meta") {
        return JSON.stringify({
          sessionId: "dashboard-123",
          command: "dashboard",
          args: [],
          toolConfigKey: "dashboard",
          worktreePath: "/repo/mobile",
        });
      }
      if (joined.startsWith("show-window-options -v -t ")) throw new Error("missing");
      return "";
    });
    const manager = new TmuxRuntimeManager(exec);

    const entries = manager.listProjectManagedWindows("/repo/mobile");
    expect(entries.map((entry) => entry.target.windowId)).toEqual(["@3", "@9", "@10"]);
    expect(entries.map((entry) => entry.target.sessionName)).toEqual([
      hostSessionName,
      hostSessionName,
      clientSessionName,
    ]);
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
    const clientSessionName = manager.getProjectClientSessionName("aimux-mobile-abc", "268eff9c");
    const target = {
      sessionName: "aimux-mobile-abc",
      windowId: "@3",
      windowIndex: 3,
      windowName: "codex",
    };

    const prev = process.env.AIMUX_CLIENT_KEY;
    process.env.AIMUX_CLIENT_KEY = "test-client";
    try {
      manager.openTarget(target, { insideTmux: true });
      manager.openTarget(target, { insideTmux: false });
    } finally {
      if (prev === undefined) delete process.env.AIMUX_CLIENT_KEY;
      else process.env.AIMUX_CLIENT_KEY = prev;
    }

    expect(
      exec.calls.some(
        (call) => call.args.join(" ") === `set-option -t ${clientSessionName} @aimux-return-session user-main`,
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args.join(" ") ===
          `new-session -d -s ${clientSessionName} -c /repo/mobile -n dashboard sh -lc tail -f /dev/null`,
      ),
    ).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "@aimux-runtime-build")).toBe(
      true,
    );
    expect(interactiveCalls.at(-2)?.args).toEqual(["switch-client", "-t", `${clientSessionName}:3`]);
    expect(interactiveCalls.at(-1)?.args).toEqual(["attach-session", "-t", `${clientSessionName}:3`]);
  });

  it("still resolves the client session for already-resolved managed targets inside tmux", () => {
    const exec = createExecMock();
    const interactiveCalls: Array<{ args: string[]; cwd?: string }> = [];
    const interactiveExec: TmuxInteractiveExec = (args, options) => {
      interactiveCalls.push({ args, cwd: options?.cwd });
    };
    const manager = new TmuxRuntimeManager(exec, interactiveExec);
    const prev = process.env.AIMUX_CLIENT_KEY;
    process.env.AIMUX_CLIENT_KEY = "test-client";

    try {
      manager.openTarget(
        {
          sessionName: "aimux-mobile-abc",
          windowId: "@0",
          windowIndex: 0,
          windowName: "dashboard-268eff9c",
        },
        { insideTmux: true, alreadyResolved: true },
      );
    } finally {
      if (prev === undefined) delete process.env.AIMUX_CLIENT_KEY;
      else process.env.AIMUX_CLIENT_KEY = prev;
    }

    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "new-session" &&
          call.args.some((arg) => arg.startsWith("aimux-mobile-abc-client-")) &&
          call.args.includes("/repo/mobile"),
      ),
    ).toBe(true);
    expect(interactiveCalls.at(-1)?.args?.[0]).toBe("switch-client");
    expect(interactiveCalls.at(-1)?.args?.[1]).toBe("-t");
    expect(interactiveCalls.at(-1)?.args?.[2]).toMatch(/^aimux-mobile-abc-client-[a-f0-9]{8}:0$/);
  });

  it("recreates a stale reused client session when its runtime contract drifts", () => {
    const hostSessionName = new TmuxRuntimeManager(createExecMock()).getProjectSession("/repo/mobile").sessionName;
    const clientSessionName = `${hostSessionName}-client-deadbeef`;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      if (joined === "-V") return "tmux 3.5a";
      if (joined === `has-session -t ${hostSessionName}`) return "";
      if (joined === `has-session -t ${clientSessionName}`) return "";
      if (
        joined ===
        `list-windows -t ${hostSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}`
      ) {
        return "@0\t0\tdashboard-268eff9c\t1\t100";
      }
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}`
      ) {
        return "@1\t1\tdashboard-268eff9c\t1\t100\n@3\t3\tcodex\t0\t90";
      }
      if (joined === `show-options -v -t ${clientSessionName} @aimux-host-session`) return hostSessionName;
      if (joined === `show-options -v -t ${clientSessionName} @aimux-project-root`) return "/repo/mobile";
      if (joined === `show-options -v -t ${clientSessionName} @aimux-runtime-build`) return "stale-build";
      if (joined.startsWith("show-options -v -t ") && joined.endsWith(" terminal-features")) return "";
      if (args[0] === "set-option" && args[1] === "-as" && args[4] === "terminal-features") return "";
      if (joined.startsWith("list-windows -t ")) return "";
      return "";
    };
    const interactiveCalls: Array<{ args: string[]; cwd?: string }> = [];
    const interactiveExec: TmuxInteractiveExec = (args, options) => {
      interactiveCalls.push({ args, cwd: options?.cwd });
    };
    const manager = new TmuxRuntimeManager(exec, interactiveExec);

    (
      manager as unknown as { ensureClientSession: (host: string, client: string, root: string) => void }
    ).ensureClientSession(hostSessionName, clientSessionName, "/repo/mobile");

    expect(calls.some((call) => call.args.join(" ") === `kill-session -t ${clientSessionName}`)).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.args.join(" ") ===
          `new-session -d -s ${clientSessionName} -c /repo/mobile -n dashboard sh -lc tail -f /dev/null`,
      ),
    ).toBe(true);
  });

  it("leaves managed tmux sessions by switching back when nested", () => {
    const exec = createExecMock();
    const interactiveCalls: Array<{ args: string[]; cwd?: string }> = [];
    const interactiveExec: TmuxInteractiveExec = (args, options) => {
      interactiveCalls.push({ args, cwd: options?.cwd });
    };
    const probeManager = new TmuxRuntimeManager(exec, interactiveExec);
    const clientSessionName = probeManager.getProjectClientSessionName("aimux-mobile-abc", "test-client");
    const manager = new TmuxRuntimeManager(
      ((args, options) => {
        if (args.join(" ") === "display-message -p #{client_session}") {
          return clientSessionName;
        }
        if (args.join(" ") === `show-options -v -t ${clientSessionName} @aimux-return-session`) {
          return "user-main";
        }
        return exec(args, options);
      }) as TmuxExec,
      interactiveExec,
    );

    manager.leaveManagedSession({ insideTmux: true, sessionName: "aimux-mobile-abc" });
    manager.leaveManagedSession({ insideTmux: false });

    expect(interactiveCalls.at(-2)?.args).toEqual(["switch-client", "-t", "user-main"]);
    expect(interactiveCalls.at(-1)?.args).toEqual(["detach-client"]);
  });

  it("detaches when there is no valid external return session", () => {
    const exec = createExecMock();
    const interactiveCalls: Array<{ args: string[]; cwd?: string }> = [];
    const interactiveExec: TmuxInteractiveExec = (args, options) => {
      interactiveCalls.push({ args, cwd: options?.cwd });
    };
    const manager = new TmuxRuntimeManager(
      ((args, options) => {
        if (args.join(" ") === "show-options -v -t aimux-mobile-abc @aimux-return-session") return "aimux-mobile-abc";
        return exec(args, options);
      }) as TmuxExec,
      interactiveExec,
    );

    manager.leaveManagedSession({ insideTmux: true, sessionName: "aimux-mobile-abc" });
    expect(interactiveCalls.at(-1)?.args).toEqual(["detach-client"]);
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
    manager.sendKey(target, "C-j");

    expect(exec.calls.slice(-4).map((call) => call.args)).toEqual([
      ["capture-pane", "-p", "-J", "-t", "@3", "-S", "-200"],
      ["send-keys", "-t", "@3", "-l", "hello"],
      ["send-keys", "-t", "@3", "Enter"],
      ["send-keys", "-t", "@3", "C-j"],
    ]);
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

  it("applies managed agent window policy in one place", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    const target = {
      sessionName: "aimux-mobile-abc",
      windowId: "@3",
      windowIndex: 3,
      windowName: "codex",
    };

    manager.applyManagedAgentWindowPolicy(target, "codex");

    expect(exec.calls.slice(-2).map((call) => call.args)).toEqual([
      ["set-window-option", "-q", "-t", "@3", "@aimux-tool", "codex"],
      ["set-window-option", "-q", "-t", "@3", "allow-passthrough", MANAGED_TMUX_AGENT_WINDOW_OPTIONS.allowPassthrough],
    ]);
  });

  it("does not keep appending duplicate terminal features when a managed session is reconfigured", () => {
    let terminalFeatures = "";
    let hasSession = false;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      if (joined === "-V") return "tmux 3.5a";
      if (joined.startsWith("has-session -t aimux-mobile-")) {
        if (!hasSession) throw new Error("missing");
        return "";
      }
      if (joined.startsWith("new-session -d -s aimux-mobile-")) {
        hasSession = true;
        return "";
      }
      if (joined.startsWith("show-options -v -t aimux-mobile-") && joined.endsWith(" terminal-features")) {
        return terminalFeatures;
      }
      if (args[0] === "set-option" && args[1] === "-as" && args[4] === "terminal-features") {
        const next = args[5]!.replace(/^,/, "");
        terminalFeatures = [terminalFeatures, next].filter(Boolean).join("\n");
        return "";
      }
      if (joined.startsWith("list-windows -t ")) return "";
      return "";
    };

    const manager = new TmuxRuntimeManager(exec);
    manager.ensureProjectSession("/repo/mobile");
    manager.ensureProjectSession("/repo/mobile");

    const featureAppendCalls = calls.filter((call) => call.args[0] === "set-option" && call.args[1] === "-as");
    expect(featureAppendCalls).toHaveLength(2);
    expect(terminalFeatures.split("\n")).toEqual(["xterm*:extkeys", "xterm*:hyperlinks"]);
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
