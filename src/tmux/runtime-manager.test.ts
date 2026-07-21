import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MANAGED_TMUX_AGENT_WINDOW_OPTIONS,
  TmuxRuntimeManager,
  buildDefaultRootMouseBindingsConfig,
  type TmuxExec,
  type TmuxInteractiveExec,
} from "./runtime-manager.js";
import { AIMUX_TMUX_RUNTIME_CONTRACT_VERSION, TMUX_RUNTIME_CONTRACT_OPTION } from "../runtime-owner.js";

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

  it("ignores malformed client sessions when finding the attached client for a target", () => {
    const exec = vi.fn<TmuxExec>((args: string[]) => {
      const joined = args.join(" ");
      if (joined === "-V") return "tmux 3.5a";
      if (joined === "list-clients -F #{client_tty}\t#{session_name}\t#{window_id}\t#{client_name}") {
        return [
          "/dev/ttys100\taimux-mobile-abc-client-live\t@3\tbad",
          "/dev/ttys101\taimux-mobile-abc-client-deadbeef\t@9\tgood",
        ].join("\n");
      }
      return "";
    });
    const manager = new TmuxRuntimeManager(exec);

    expect(
      manager.getAttachedClientForTarget({
        sessionName: "aimux-mobile-abc",
        windowId: "@3",
        windowIndex: 3,
        windowName: "codex",
      }),
    ).toEqual({
      tty: "/dev/ttys101",
      sessionName: "aimux-mobile-abc-client-deadbeef",
      windowId: "@9",
      name: "good",
    });
  });

  it("derives deterministic per-project session names", () => {
    const manager = new TmuxRuntimeManager(createExecMock());
    const a = manager.getProjectSession("/repo/mobile");
    const b = manager.getProjectSession("/repo/mobile");
    const c = manager.getProjectSession("/repo/web");
    expect(a.sessionName).toBe(b.sessionName);
    expect(a.projectId).toBe(b.projectId);
    expect(a.sessionName).not.toBe(c.sessionName);
    expect(a.projectId).toMatch(/^mobile-[a-f0-9]{12}$/);
    expect(a.sessionName).toBe(`aimux-${a.projectId}`);
  });

  it("renames legacy sha1 project sessions to the canonical project id", () => {
    let renamed = false;
    const exec = vi.fn<TmuxExec>((args: string[]) => {
      const joined = args.join(" ");
      if (joined === "list-sessions -F #{session_name}") return "aimux-mobile-7a62ea91ca";
      if (joined === "rename-session -t aimux-mobile-7a62ea91ca aimux-mobile-078d0ecd20ec") {
        renamed = true;
        return "";
      }
      if (joined === "has-session -t aimux-mobile-078d0ecd20ec" && renamed) return "";
      if (joined.startsWith("has-session -t ")) throw new Error("missing");
      if (joined.startsWith("show-options -v -t aimux-mobile-")) return "";
      if (joined.startsWith("list-windows -t aimux-mobile-")) return "";
      return "";
    });
    const manager = new TmuxRuntimeManager(exec);
    const session = manager.ensureProjectSession("/repo/mobile");

    expect(exec).toHaveBeenCalledWith(["rename-session", "-t", "aimux-mobile-7a62ea91ca", session.sessionName]);
    expect(exec.mock.calls.some(([args]) => args[0] === "new-session")).toBe(false);
  });

  it("repairs legacy project sessions before listing managed windows", () => {
    const metadata = {
      kind: "agent",
      sessionId: "codex-legacy",
      command: "codex",
      args: [],
      toolConfigKey: "codex",
      worktreePath: "/repo/mobile",
    };
    let repaired = false;
    const exec = vi.fn<TmuxExec>((args: string[]) => {
      const joined = args.join(" ");
      if (joined === "list-sessions -F #{session_name}") {
        return repaired
          ? "aimux-mobile-078d0ecd20ec\naimux-mobile-078d0ecd20ec-client-12345678"
          : "aimux-mobile-7a62ea91ca\naimux-mobile-7a62ea91ca-client-12345678";
      }
      if (joined.startsWith("rename-session -t aimux-mobile-7a62ea91ca")) {
        repaired = true;
        return "";
      }
      if (joined.startsWith("list-windows -t aimux-mobile-078d0ecd20ec -F ")) {
        return `@3\t3\tcodex\t1\t100\t0\t${JSON.stringify(metadata)}`;
      }
      if (joined.startsWith("list-windows -t aimux-mobile-078d0ecd20ec-client-12345678 -F ")) return "";
      return "";
    });
    const manager = new TmuxRuntimeManager(exec);

    const windows = manager.listProjectManagedWindows("/repo/mobile");

    expect(exec).toHaveBeenCalledWith(["rename-session", "-t", "aimux-mobile-7a62ea91ca", "aimux-mobile-078d0ecd20ec"]);
    expect(exec).toHaveBeenCalledWith([
      "rename-session",
      "-t",
      "aimux-mobile-7a62ea91ca-client-12345678",
      "aimux-mobile-078d0ecd20ec-client-12345678",
    ]);
    expect(windows).toEqual([
      {
        target: {
          sessionName: "aimux-mobile-078d0ecd20ec",
          windowId: "@3",
          windowIndex: 3,
          windowName: "codex",
          paneDead: false,
        },
        metadata,
      },
    ]);
  });

  it("includes repaired legacy client sessions when the canonical host already exists", () => {
    const metadata = {
      kind: "agent",
      sessionId: "codex-legacy-client",
      command: "codex",
      args: [],
      toolConfigKey: "codex",
      worktreePath: "/repo/mobile",
    };
    let repaired = false;
    const exec = vi.fn<TmuxExec>((args: string[]) => {
      const joined = args.join(" ");
      if (joined === "list-sessions -F #{session_name}") {
        return repaired
          ? "aimux-mobile-078d0ecd20ec\naimux-mobile-078d0ecd20ec-client-12345678"
          : "aimux-mobile-078d0ecd20ec\naimux-mobile-7a62ea91ca-client-12345678";
      }
      if (
        joined === "rename-session -t aimux-mobile-7a62ea91ca-client-12345678 aimux-mobile-078d0ecd20ec-client-12345678"
      ) {
        repaired = true;
        return "";
      }
      if (joined.startsWith("list-windows -t aimux-mobile-078d0ecd20ec -F ")) return "";
      if (joined.startsWith("list-windows -t aimux-mobile-078d0ecd20ec-client-12345678 -F ")) {
        return `@4\t4\tcodex\t1\t100\t0\t${JSON.stringify(metadata)}`;
      }
      return "";
    });
    const manager = new TmuxRuntimeManager(exec);

    const windows = manager.listProjectManagedWindows("/repo/mobile");

    expect(exec).toHaveBeenCalledWith([
      "rename-session",
      "-t",
      "aimux-mobile-7a62ea91ca-client-12345678",
      "aimux-mobile-078d0ecd20ec-client-12345678",
    ]);
    expect(windows).toEqual([
      {
        target: {
          sessionName: "aimux-mobile-078d0ecd20ec-client-12345678",
          windowId: "@4",
          windowIndex: 4,
          windowName: "codex",
          paneDead: false,
        },
        metadata,
      },
    ]);
  });

  it("finds managed windows when the requested project root is a symlink alias", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "aimux-tmux-root-"));
    const realRoot = join(tmpRoot, "real");
    const linkRoot = join(tmpRoot, "link");
    rmSync(realRoot, { recursive: true, force: true });
    rmSync(linkRoot, { recursive: true, force: true });
    try {
      symlinkSync(tmpRoot, linkRoot);
      const metadata = {
        kind: "agent",
        sessionId: "codex-realpath",
        command: "codex",
        args: [],
        toolConfigKey: "codex",
        worktreePath: realRoot,
      };
      const realSession = new TmuxRuntimeManager(createExecMock()).getProjectSession(tmpRoot).sessionName;
      const exec = vi.fn<TmuxExec>((args: string[]) => {
        const joined = args.join(" ");
        if (joined === "list-sessions -F #{session_name}") return realSession;
        if (joined === `show-options -v -t ${realSession} @aimux-project-root`) return tmpRoot;
        if (joined.startsWith(`list-windows -t ${realSession} -F `)) {
          return `@9\t9\tcodex\t1\t100\t0\t${JSON.stringify(metadata)}`;
        }
        return "";
      });
      const manager = new TmuxRuntimeManager(exec);

      const windows = manager.listProjectManagedWindows(linkRoot);

      expect(windows).toEqual([
        {
          target: {
            sessionName: realSession,
            windowId: "@9",
            windowIndex: 9,
            windowName: "codex",
            paneDead: false,
          },
          metadata,
        },
      ]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("creates a detached project session when missing", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    const session = manager.ensureProjectSession("/repo/mobile");
    expect(session.sessionName).toMatch(/^aimux-mobile-/);
    expect(exec.calls.some((call) => call.args[0] === "new-session")).toBe(true);
    const createCall = exec.calls.find((call) => call.args[0] === "new-session");
    expect(createCall?.cwd).toBe("/repo/mobile");
    expect(
      exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "@aimux-project-state-dir"),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "set-option" &&
          call.args[3] === TMUX_RUNTIME_CONTRACT_OPTION &&
          call.args[4] === AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
      ),
    ).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "prefix")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "prefix2")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "mouse")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "window-size")).toBe(true);
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
      exec.calls.some((call) => call.args[0] === "set-window-option" && call.args[3] === "aggressive-resize"),
    ).toBe(true);
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
    expect(exec.calls.some((call) => call.args[0] === "unbind-key" && call.args[3] === "e")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "unbind-key" && call.args[3] === "K")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "unbind-key" && call.args[3] === "0")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "unbind-key" && call.args[3] === "1")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "bind-key" && call.args[3] === "C-a")).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "bind-key" &&
          call.args[3] === "0" &&
          call.args.includes("run-shell") &&
          call.args.includes("true"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "bind-key" &&
          call.args[3] === "1" &&
          call.args.join(" ").includes("scripts/tmux-control.sh' window --index 1"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) => call.args[0] === "bind-key" && call.args.join(" ").includes("scripts/tmux-control.sh' menu"),
      ),
    ).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "unbind-key" && call.args[3] === "g")).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "bind-key" &&
          call.args[2] === "prefix" &&
          call.args[3] === "g" &&
          call.args.join(" ").includes("scripts/tmux-control.sh' expose"),
      ),
    ).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "unbind-key" && call.args[3] === "m")).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "bind-key" &&
          call.args[2] === "prefix" &&
          call.args[3] === "m" &&
          call.args.join(" ").includes("scripts/tmux-control.sh' meta"),
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
          call.args.join(" ").includes("--current-window-id #{q:window_id}") &&
          call.args.join(" ").includes("--pane-id #{q:pane_id}"),
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
          call.args[3] === "e" &&
          call.args.join(" ").includes("scripts/tmux-control.sh' team"),
      ),
    ).toBe(true);
    const dashboardBinding = exec.calls.find(
      (call) =>
        call.args[0] === "bind-key" &&
        call.args.join(" ").includes(" prefix d ") &&
        call.args[4] === "run-shell" &&
        !call.args.join(" ").includes("tmux select-window -t :0") &&
        call.args.join(" ").includes("scripts/tmux-control.sh") &&
        call.args.join(" ").includes(" dashboard --current-client-session "),
    );
    expect(dashboardBinding).toBeTruthy();
    expect(dashboardBinding?.args.join(" ")).toContain("--current-client-session #{q:client_session}");
    expect(dashboardBinding?.args.join(" ")).toContain("--current-path #{q:pane_current_path}");
    const globalControlBindings = exec.calls.filter(
      (call) =>
        call.args[0] === "bind-key" && call.args.includes("prefix") && call.args.join(" ").includes("tmux-control.sh"),
    );
    expect(globalControlBindings.some((call) => call.args.join(" ").includes("--project-root"))).toBe(false);
    expect(globalControlBindings.some((call) => call.args.join(" ").includes("--project-state-dir"))).toBe(false);
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
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "bind-key" &&
          call.args[1] === "-T" &&
          call.args[2] === "prefix" &&
          call.args[3] === "L" &&
          call.args[4] === "clear-history" &&
          call.args.includes("C-l"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "set-hook" &&
          call.args[1] === "-t" &&
          call.args[3] === "pane-focus-in" &&
          call.args[4]?.includes("scripts/tmux-control.sh") &&
          call.args[4]?.includes(" active "),
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
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "set-option" &&
          call.args[3] === "status-format[0]" &&
          call.args[4]?.includes("#{?pane_in_mode") &&
          call.args[4]?.includes("scroll"),
      ),
    ).toBe(true);
  });

  it("applies the full managed session contract after async session creation", async () => {
    const exec = createExecMock();
    const asyncCalls: Array<{ args: string[]; cwd?: string }> = [];
    const execAsync = vi.fn(async (args: string[], options?: { cwd?: string }) => {
      asyncCalls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      if (joined.startsWith("has-session -t ")) throw new Error("missing");
      return "";
    });
    const manager = new TmuxRuntimeManager(exec, () => {}, execAsync);

    const session = await manager.ensureProjectSessionAsync("/repo/mobile");

    expect(session.sessionName).toMatch(/^aimux-mobile-/);
    expect(asyncCalls.some((call) => call.args[0] === "new-session" && call.cwd === "/repo/mobile")).toBe(true);
    expect(exec.calls.some((call) => call.args[0] === "set-option" && call.args[3] === "prefix")).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "bind-key" &&
          call.args[2] === "prefix" &&
          call.args[3] === "g" &&
          call.args.join(" ").includes("scripts/tmux-control.sh' expose"),
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args[0] === "set-option" &&
          call.args[3] === TMUX_RUNTIME_CONTRACT_OPTION &&
          call.args[4] === AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
      ),
    ).toBe(true);
  });

  it("stamps missing runtime contract on an existing project session", () => {
    const sessionName = new TmuxRuntimeManager(createExecMock()).getProjectSession("/repo/mobile").sessionName;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      if (joined === "-V") return "tmux 3.5a";
      if (joined === `has-session -t ${sessionName}`) return "";
      if (joined === `show-options -v -t ${sessionName} ${TMUX_RUNTIME_CONTRACT_OPTION}`) return "";
      if (joined.startsWith("list-windows -t ")) return "";
      if (joined.startsWith("show-options -v -t ") && joined.endsWith(" terminal-features")) return "";
      return "";
    };
    const manager = new TmuxRuntimeManager(exec);

    manager.ensureProjectSession("/repo/mobile");

    expect(calls.some((call) => call.args[0] === "new-session")).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.args[0] === "set-option" &&
          call.args[3] === TMUX_RUNTIME_CONTRACT_OPTION &&
          call.args[4] === AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
      ),
    ).toBe(true);
  });

  it("stamps a new project session runtime contract before long configuration", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    const session = manager.ensureProjectSession("/repo/mobile");
    const contractIndex = exec.calls.findIndex(
      (call) => call.args[0] === "set-option" && call.args[3] === TMUX_RUNTIME_CONTRACT_OPTION,
    );
    const projectRootIndex = exec.calls.findIndex(
      (call) => call.args.join(" ") === `set-option -t ${session.sessionName} @aimux-project-root /repo/mobile`,
    );

    expect(contractIndex).toBeGreaterThan(-1);
    expect(projectRootIndex).toBeGreaterThan(-1);
    expect(contractIndex).toBeLessThan(projectRootIndex);
  });

  it("keeps default project host sessions alive", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);

    manager.ensureProjectSession("/repo/mobile");

    expect(exec.calls.find((call) => call.args[0] === "new-session")?.args.join(" ")).toContain(
      "sh -lc tail -f /dev/null",
    );
  });

  it("recreates a project session when tmux drops it during contract stamping", () => {
    let sessionExists = false;
    let dropNextContract = true;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      if (joined === "-V") return "tmux 3.5a";
      if (joined.startsWith("has-session -t ")) {
        if (!sessionExists) throw new Error("missing");
        return "";
      }
      if (joined === "list-sessions -F #{session_name}") return "";
      if (joined.startsWith("new-session -d -s ")) {
        sessionExists = true;
        return "";
      }
      if (args[0] === "set-option" && args[3] === TMUX_RUNTIME_CONTRACT_OPTION && dropNextContract) {
        dropNextContract = false;
        sessionExists = false;
        throw new Error("no such session: aimux-mobile-abc");
      }
      if (joined.startsWith("list-windows -t ")) return "";
      if (joined.startsWith("show-options -v -t ") && joined.endsWith(" terminal-features")) return "";
      return "";
    };
    const manager = new TmuxRuntimeManager(exec);

    manager.ensureProjectSession("/repo/mobile");

    expect(calls.filter((call) => call.args[0] === "new-session")).toHaveLength(2);
    expect(
      calls.filter((call) => call.args[0] === "set-option" && call.args[3] === TMUX_RUNTIME_CONTRACT_OPTION),
    ).toHaveLength(3);
  });

  it("recreates a project session when tmux drops it during configuration", () => {
    let sessionExists = false;
    let dropNextConfiguration = true;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      if (joined === "-V") return "tmux 3.5a";
      if (joined.startsWith("has-session -t ")) {
        if (!sessionExists) throw new Error("missing");
        return "";
      }
      if (joined === "list-sessions -F #{session_name}") return "";
      if (joined.startsWith("new-session -d -s ")) {
        sessionExists = true;
        return "";
      }
      if (args[0] === "set-option" && args[3] === "@aimux-project-root" && dropNextConfiguration) {
        dropNextConfiguration = false;
        sessionExists = false;
        throw new Error("no such session: aimux-mobile-abc");
      }
      if (joined.startsWith("list-windows -t ")) return "";
      if (joined.startsWith("show-options -v -t ") && joined.endsWith(" terminal-features")) return "";
      return "";
    };
    const manager = new TmuxRuntimeManager(exec);

    const session = manager.ensureProjectSession("/repo/mobile");

    expect(session.sessionName).toMatch(/^aimux-mobile-/);
    expect(calls.filter((call) => call.args[0] === "new-session")).toHaveLength(2);
    expect(
      calls.filter((call) => call.args[0] === "set-option" && call.args[3] === "@aimux-project-root"),
    ).toHaveLength(2);
  });

  it("bakes control-plane identity into the expose/meta bindings when set", () => {
    const prevHome = process.env.AIMUX_HOME;
    const prevHost = process.env.AIMUX_DAEMON_HOST;
    const prevPort = process.env.AIMUX_DAEMON_PORT;
    process.env.AIMUX_HOME = "/home/user/.aimux-custom";
    process.env.AIMUX_DAEMON_HOST = "127.0.0.2";
    process.env.AIMUX_DAEMON_PORT = "44191";
    try {
      const exec = createExecMock();
      const manager = new TmuxRuntimeManager(exec);
      manager.ensureProjectSession("/repo/mobile");
      const bindings = exec.calls.filter((c) => c.args[0] === "bind-key" && c.args[2] === "prefix");
      const g = bindings.find((c) => c.args[3] === "g")?.args.join(" ") ?? "";
      const m = bindings.find((c) => c.args[3] === "m")?.args.join(" ") ?? "";
      for (const binding of [g, m]) {
        expect(binding).toContain("--aimux-home");
        expect(binding).toContain("/home/user/.aimux-custom");
        expect(binding).toContain("--daemon-host");
        expect(binding).toContain("127.0.0.2");
        expect(binding).toContain("--daemon-port");
        expect(binding).toContain("44191");
      }
    } finally {
      if (prevHome === undefined) delete process.env.AIMUX_HOME;
      else process.env.AIMUX_HOME = prevHome;
      if (prevHost === undefined) delete process.env.AIMUX_DAEMON_HOST;
      else process.env.AIMUX_DAEMON_HOST = prevHost;
      if (prevPort === undefined) delete process.env.AIMUX_DAEMON_PORT;
      else process.env.AIMUX_DAEMON_PORT = prevPort;
    }
  });

  it("binds prefix i to the coordination control path", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);

    manager.ensureProjectSession("/repo/mobile");

    const binding = exec.calls.find(
      (call) => call.args[0] === "bind-key" && call.args[2] === "prefix" && call.args[3] === "i",
    );
    expect(binding?.args.join(" ")).toContain("tmux-control.sh' coordination");
  });

  it("routes wheel-up to tmux copy-mode for managed agent windows", () => {
    const config = buildDefaultRootMouseBindingsConfig({
      openPaneLinkCommand: "open-pane-link",
      openStatusPrCommand: "open-status-pr",
    });

    expect(config).toContain(
      'bind-key -T root WheelUpPane if-shell -F "#{||:#{@aimux-tool},#{&&:#{!=:#{alternate_on},1},#{!=:#{mouse_any_flag},1}}}" "copy-mode -e \\; send-keys -X -N 1 scroll-up" "send-keys -M"',
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
      if (joined.startsWith(`list-windows -t ${hostSessionName} -F `)) {
        return [
          `@3\t3\tcodex\t1\t100\t0\t${JSON.stringify({
            sessionId: "codex-abc123",
            command: "codex",
            args: ["--full-auto"],
            toolConfigKey: "codex",
            worktreePath: "/repo/mobile",
          })}`,
          `@9\t9\tshell\t0\t90\t0\t${JSON.stringify({
            sessionId: "service-123",
            command: "shell",
            args: ["-lc", "npm run dev"],
            toolConfigKey: "service",
            worktreePath: "/repo/mobile",
            kind: "service",
          })}`,
        ].join("\n");
      }
      if (joined.startsWith(`list-windows -t ${clientSessionName} -F `)) {
        return [
          `@3\t3\tcodex\t0\t100\t0\t${JSON.stringify({
            sessionId: "codex-abc123",
            command: "codex",
            args: ["--full-auto"],
            toolConfigKey: "codex",
            worktreePath: "/repo/mobile",
          })}`,
          `@10\t10\tdashboard\t1\t110\t1\t${JSON.stringify({
            sessionId: "dashboard-123",
            command: "dashboard",
            args: [],
            toolConfigKey: "dashboard",
            worktreePath: "/repo/mobile",
          })}`,
        ].join("\n");
      }
      if (joined.startsWith("show-window-options -v -t ")) throw new Error("missing");
      return "";
    });
    const manager = new TmuxRuntimeManager(exec);

    const entries = manager.listProjectManagedWindows("/repo/mobile");
    expect(entries.map((entry) => entry.target.windowId)).toEqual(["@3", "@9", "@10"]);
    expect(entries.find((entry) => entry.target.windowId === "@10")?.target.paneDead).toBe(true);
    expect(entries.map((entry) => entry.target.sessionName)).toEqual([
      hostSessionName,
      hostSessionName,
      clientSessionName,
    ]);
  });

  it("finds managed windows by backend session id", () => {
    const exec = vi.fn<TmuxExec>((args: string[]) => {
      const joined = args.join(" ");
      if (joined === "-V") return "tmux 3.5a";
      if (joined.startsWith("list-windows -t aimux-mobile-abc -F ")) {
        return `@3\t3\tcodex\t1\t100\t0\t${JSON.stringify({
          kind: "agent",
          sessionId: "codex-new",
          backendSessionId: "backend-existing",
          command: "codex",
          args: [],
          toolConfigKey: "codex",
        })}`;
      }
      return "";
    });
    const manager = new TmuxRuntimeManager(exec);

    const match = manager.findManagedWindow("aimux-mobile-abc", { backendSessionId: "backend-existing" });

    expect(match?.target.windowId).toBe("@3");
    expect(match?.metadata.sessionId).toBe("codex-new");
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

  it("atomically replaces a client dashboard placeholder when opening a dashboard", () => {
    const hostSessionName = "aimux-mobile-abc";
    const clientSessionName = `${hostSessionName}-client-268eff9c`;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      const linked = calls.some((call) => call.args.join(" ") === `link-window -d -s @10 -t ${clientSessionName}`);
      const swapped = calls.some(
        (call) => call.args.join(" ") === `swap-window -s ${clientSessionName}:@10 -t ${clientSessionName}:0`,
      );
      if (joined === "-V") return "tmux 3.5a";
      if (joined === `has-session -t ${clientSessionName}`) throw new Error("missing");
      if (joined === `show-options -v -t ${hostSessionName} @aimux-project-root`) return "/repo/mobile";
      if (joined === `show-options -v -t ${clientSessionName} renumber-windows`) return "on";
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        if (swapped) return "@10\t0\tdashboard\t1\t100\n@placeholder\t1\tdashboard\t0\t100";
        if (linked) return "@placeholder\t0\tdashboard\t1\t100\n@10\t1\tdashboard\t0\t100";
        return "@placeholder\t0\tdashboard\t1\t100";
      }
      if (joined.startsWith(`show-options -v -t ${clientSessionName} terminal-features`)) return "";
      return "";
    };
    const interactiveCalls: Array<{ args: string[]; cwd?: string }> = [];
    const interactiveExec: TmuxInteractiveExec = (args, options) => {
      interactiveCalls.push({ args, cwd: options?.cwd });
    };
    const manager = new TmuxRuntimeManager(exec, interactiveExec);

    manager.openTarget(
      { sessionName: hostSessionName, windowId: "@10", windowIndex: 0, windowName: "dashboard" },
      { insideTmux: true, clientSuffix: "268eff9c" },
    );

    expect(
      calls.some((call) => call.args.join(" ") === `set-option -t ${clientSessionName} renumber-windows off`),
    ).toBe(true);
    expect(calls.some((call) => call.args.join(" ") === `link-window -d -s @10 -t ${clientSessionName}`)).toBe(true);
    expect(
      calls.some((call) => call.args.join(" ") === `swap-window -s ${clientSessionName}:@10 -t ${clientSessionName}:0`),
    ).toBe(true);
    expect(calls.some((call) => call.args.join(" ") === `unlink-window -t ${clientSessionName}:@placeholder`)).toBe(
      true,
    );
    expect(calls.some((call) => call.args[0] === "kill-window")).toBe(false);
    expect(calls.some((call) => call.args.join(" ") === `set-option -t ${clientSessionName} renumber-windows on`)).toBe(
      true,
    );
    expect(interactiveCalls.at(-1)?.args).toEqual(["switch-client", "-t", `${clientSessionName}:0`]);
  });

  it("moves an already linked dashboard into the requested client slot", () => {
    const hostSessionName = "aimux-mobile-abc";
    const clientSessionName = `${hostSessionName}-client-268eff9c`;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      const swapped = calls.some(
        (call) => call.args.join(" ") === `swap-window -s ${clientSessionName}:@10 -t ${clientSessionName}:0`,
      );
      if (joined === "-V") return "tmux 3.5a";
      if (joined === `has-session -t ${clientSessionName}`) return "";
      if (joined === `show-options -v -t ${hostSessionName} @aimux-project-root`) return "/repo/mobile";
      if (joined === `show-options -v -t ${clientSessionName} renumber-windows`) return "on";
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        if (swapped) return "@10\t0\tdashboard\t0\t100\n@placeholder\t1\tdashboard\t1\t100";
        return "@placeholder\t0\tdashboard\t1\t100\n@10\t1\tdashboard\t0\t100";
      }
      if (joined.startsWith(`show-options -v -t ${clientSessionName} terminal-features`)) return "";
      return "";
    };
    const interactiveCalls: Array<{ args: string[]; cwd?: string }> = [];
    const manager = new TmuxRuntimeManager(exec, (args, options) => {
      interactiveCalls.push({ args, cwd: options?.cwd });
    });

    manager.openTarget(
      { sessionName: hostSessionName, windowId: "@10", windowIndex: 0, windowName: "dashboard" },
      { insideTmux: true, clientSuffix: "268eff9c" },
    );

    expect(calls.some((call) => call.args.join(" ") === `link-window -d -s @10 -t ${clientSessionName}`)).toBe(false);
    expect(
      calls.some((call) => call.args.join(" ") === `swap-window -s ${clientSessionName}:@10 -t ${clientSessionName}:0`),
    ).toBe(true);
    expect(calls.some((call) => call.args.join(" ") === `unlink-window -t ${clientSessionName}:@placeholder`)).toBe(
      true,
    );
    expect(interactiveCalls.at(-1)?.args).toEqual(["switch-client", "-t", `${clientSessionName}:0`]);
  });

  it("moves an already linked dashboard into an empty requested client slot", () => {
    const hostSessionName = "aimux-mobile-abc";
    const clientSessionName = `${hostSessionName}-client-268eff9c`;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      const moved = calls.some(
        (call) => call.args.join(" ") === `move-window -s ${clientSessionName}:@10 -t ${clientSessionName}:0`,
      );
      if (joined === "-V") return "tmux 3.5a";
      if (joined === `has-session -t ${clientSessionName}`) return "";
      if (joined === `show-options -v -t ${hostSessionName} @aimux-project-root`) return "/repo/mobile";
      if (joined === `show-options -v -t ${clientSessionName} renumber-windows`) return "on";
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        return moved ? "@10\t0\tdashboard\t1\t100" : "@10\t1\tdashboard\t1\t100";
      }
      if (joined.startsWith(`show-options -v -t ${clientSessionName} terminal-features`)) return "";
      return "";
    };
    const interactiveCalls: Array<{ args: string[]; cwd?: string }> = [];
    const manager = new TmuxRuntimeManager(exec, (args, options) => {
      interactiveCalls.push({ args, cwd: options?.cwd });
    });

    manager.openTarget(
      { sessionName: hostSessionName, windowId: "@10", windowIndex: 0, windowName: "dashboard" },
      { insideTmux: true, clientSuffix: "268eff9c" },
    );

    expect(calls.some((call) => call.args.join(" ") === `link-window -d -s @10 -t ${clientSessionName}`)).toBe(false);
    expect(
      calls.some((call) => call.args.join(" ") === `move-window -s ${clientSessionName}:@10 -t ${clientSessionName}:0`),
    ).toBe(true);
    expect(calls.some((call) => call.args[0] === "unlink-window")).toBe(false);
    expect(interactiveCalls.at(-1)?.args).toEqual(["switch-client", "-t", `${clientSessionName}:0`]);
  });

  it("preserves a pre-existing dashboard link when moving it into the requested slot fails", () => {
    const hostSessionName = "aimux-mobile-abc";
    const clientSessionName = `${hostSessionName}-client-268eff9c`;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      if (joined === "-V") return "tmux 3.5a";
      if (joined === `has-session -t ${clientSessionName}`) return "";
      if (joined === `show-options -v -t ${hostSessionName} @aimux-project-root`) return "/repo/mobile";
      if (joined === `show-options -v -t ${clientSessionName} renumber-windows`) return "on";
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        return "@10\t1\tdashboard\t1\t100";
      }
      if (joined === `move-window -s ${clientSessionName}:@10 -t ${clientSessionName}:0`) {
        throw new Error("move failed");
      }
      if (joined.startsWith(`show-options -v -t ${clientSessionName} terminal-features`)) return "";
      return "";
    };
    const manager = new TmuxRuntimeManager(exec, () => {});

    expect(() =>
      manager.openTarget(
        { sessionName: hostSessionName, windowId: "@10", windowIndex: 0, windowName: "dashboard" },
        { insideTmux: true, clientSuffix: "268eff9c" },
      ),
    ).toThrow("move failed");

    expect(calls.some((call) => call.args.join(" ") === `link-window -d -s @10 -t ${clientSessionName}`)).toBe(false);
    expect(
      calls.some((call) => call.args.join(" ") === `move-window -s ${clientSessionName}:@10 -t ${clientSessionName}:0`),
    ).toBe(true);
    expect(calls.some((call) => call.args[0] === "unlink-window")).toBe(false);
  });

  it("keeps the existing dashboard slot intact when linking into it fails", () => {
    const hostSessionName = "aimux-mobile-abc";
    const clientSessionName = `${hostSessionName}-client-268eff9c`;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      if (joined === "-V") return "tmux 3.5a";
      if (joined === `has-session -t ${clientSessionName}`) return "";
      if (joined === `show-options -v -t ${hostSessionName} @aimux-project-root`) return "/repo/mobile";
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        return "@placeholder\t0\tdashboard\t1\t100\n@codex\t1\tcodex\t0\t100";
      }
      if (joined === `link-window -d -s @10 -t ${clientSessionName}`) {
        throw new Error("link failed");
      }
      if (joined.startsWith(`show-options -v -t ${clientSessionName} terminal-features`)) return "";
      return "";
    };
    const manager = new TmuxRuntimeManager(exec, () => {});

    expect(() =>
      manager.openTarget(
        { sessionName: hostSessionName, windowId: "@10", windowIndex: 0, windowName: "dashboard" },
        { insideTmux: true, clientSuffix: "268eff9c" },
      ),
    ).toThrow("link failed");

    expect(calls.some((call) => call.args.join(" ") === "kill-window -t @placeholder")).toBe(false);
    expect(calls.some((call) => call.args.join(" ") === `unlink-window -t ${clientSessionName}:@placeholder`)).toBe(
      false,
    );
    expect(calls.some((call) => call.args.includes("-k"))).toBe(false);
    expect(calls.some((call) => call.args.join(" ") === "kill-window -t @codex")).toBe(false);
  });

  it("disables window renumbering when replacing a dashboard in a multi-window client session", () => {
    const hostSessionName = "aimux-mobile-abc";
    const clientSessionName = `${hostSessionName}-client-268eff9c`;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      const linked = calls.some((call) => call.args.join(" ") === `link-window -d -s @10 -t ${clientSessionName}`);
      const swapped = calls.some(
        (call) => call.args.join(" ") === `swap-window -s ${clientSessionName}:@10 -t ${clientSessionName}:0`,
      );
      if (joined === "-V") return "tmux 3.5a";
      if (joined === `has-session -t ${clientSessionName}`) return "";
      if (joined === `show-options -v -t ${hostSessionName} @aimux-project-root`) return "/repo/mobile";
      if (joined === `show-options -v -t ${clientSessionName} renumber-windows`) return "on";
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        if (swapped) return "@10\t0\tdashboard\t1\t100\n@codex\t1\tcodex\t0\t100\n@placeholder\t2\tdashboard\t0\t100";
        if (linked) return "@placeholder\t0\tdashboard\t1\t100\n@codex\t1\tcodex\t0\t100\n@10\t2\tdashboard\t0\t100";
        return "@placeholder\t0\tdashboard\t1\t100\n@codex\t1\tcodex\t0\t100";
      }
      if (joined.startsWith(`show-options -v -t ${clientSessionName} terminal-features`)) return "";
      return "";
    };
    const manager = new TmuxRuntimeManager(exec, () => {});

    manager.openTarget(
      { sessionName: hostSessionName, windowId: "@10", windowIndex: 0, windowName: "dashboard" },
      { insideTmux: true, clientSuffix: "268eff9c" },
    );

    const unlinkIndex = calls.findIndex(
      (call) => call.args.join(" ") === `unlink-window -t ${clientSessionName}:@placeholder`,
    );
    const disableIndex = calls.findIndex(
      (call) => call.args.join(" ") === `set-option -t ${clientSessionName} renumber-windows off`,
    );
    const restoreIndex = calls.findIndex(
      (call) => call.args.join(" ") === `set-option -t ${clientSessionName} renumber-windows on`,
    );
    expect(disableIndex).toBeGreaterThan(-1);
    expect(unlinkIndex).toBeGreaterThan(disableIndex);
    expect(restoreIndex).toBeGreaterThan(unlinkIndex);
    expect(calls.some((call) => call.args.join(" ") === "kill-window -t @placeholder")).toBe(false);
    expect(calls.some((call) => call.args.join(" ") === "kill-window -t @codex")).toBe(false);
  });

  it("unlinks a newly linked dashboard when slot replacement verification fails", () => {
    const hostSessionName = "aimux-mobile-abc";
    const clientSessionName = `${hostSessionName}-client-268eff9c`;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      const linked = calls.some((call) => call.args.join(" ") === `link-window -d -s @10 -t ${clientSessionName}`);
      if (joined === "-V") return "tmux 3.5a";
      if (joined === `has-session -t ${clientSessionName}`) return "";
      if (joined === `show-options -v -t ${hostSessionName} @aimux-project-root`) return "/repo/mobile";
      if (joined === `show-options -v -t ${clientSessionName} renumber-windows`) return "on";
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        if (linked) return "@placeholder\t0\tdashboard\t1\t100\n@10\t1\tdashboard\t0\t100";
        return "@placeholder\t0\tdashboard\t1\t100";
      }
      if (joined.startsWith(`show-options -v -t ${clientSessionName} terminal-features`)) return "";
      return "";
    };
    const manager = new TmuxRuntimeManager(exec, () => {});

    expect(() =>
      manager.openTarget(
        { sessionName: hostSessionName, windowId: "@10", windowIndex: 0, windowName: "dashboard" },
        { insideTmux: true, clientSuffix: "268eff9c" },
      ),
    ).toThrow(`Failed to replace dashboard slot ${clientSessionName}:0`);

    expect(
      calls.some((call) => call.args.join(" ") === `swap-window -s ${clientSessionName}:@10 -t ${clientSessionName}:0`),
    ).toBe(true);
    expect(calls.some((call) => call.args.join(" ") === `unlink-window -t ${clientSessionName}:@10`)).toBe(true);
  });

  it("restores window renumbering when dashboard link fails", () => {
    const hostSessionName = "aimux-mobile-abc";
    const clientSessionName = `${hostSessionName}-client-268eff9c`;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      if (joined === "-V") return "tmux 3.5a";
      if (joined === `has-session -t ${clientSessionName}`) throw new Error("missing");
      if (joined === `show-options -v -t ${hostSessionName} @aimux-project-root`) return "/repo/mobile";
      if (joined === `show-options -v -t ${clientSessionName} renumber-windows`) return "on";
      if (joined === `link-window -d -s @10 -t ${clientSessionName}`) throw new Error("link failed");
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        return "@placeholder\t0\tdashboard\t1\t100";
      }
      if (joined.startsWith(`show-options -v -t ${clientSessionName} terminal-features`)) return "";
      return "";
    };
    const manager = new TmuxRuntimeManager(exec, () => {});

    expect(() =>
      manager.openTarget(
        { sessionName: hostSessionName, windowId: "@10", windowIndex: 0, windowName: "dashboard" },
        { insideTmux: true, clientSuffix: "268eff9c" },
      ),
    ).toThrow("link failed");

    expect(
      calls.some((call) => call.args.join(" ") === `set-option -t ${clientSessionName} renumber-windows off`),
    ).toBe(true);
    expect(calls.some((call) => call.args.join(" ") === `set-option -t ${clientSessionName} renumber-windows on`)).toBe(
      true,
    );
    expect(calls.some((call) => call.args[0] === "kill-window")).toBe(false);
  });

  it("restores window renumbering when stale dashboard unlink fails", () => {
    const hostSessionName = "aimux-mobile-abc";
    const clientSessionName = `${hostSessionName}-client-268eff9c`;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      const linked = calls.some((call) => call.args.join(" ") === `link-window -d -s @10 -t ${clientSessionName}`);
      const swapped = calls.some(
        (call) => call.args.join(" ") === `swap-window -s ${clientSessionName}:@10 -t ${clientSessionName}:0`,
      );
      if (joined === "-V") return "tmux 3.5a";
      if (joined === `has-session -t ${clientSessionName}`) throw new Error("missing");
      if (joined === `show-options -v -t ${hostSessionName} @aimux-project-root`) return "/repo/mobile";
      if (joined === `show-options -v -t ${clientSessionName} renumber-windows`) return "on";
      if (joined === `unlink-window -t ${clientSessionName}:@placeholder`) throw new Error("unlink failed");
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        if (swapped) return "@10\t0\tdashboard\t1\t100\n@placeholder\t1\tdashboard\t0\t100";
        if (linked) return "@placeholder\t0\tdashboard\t1\t100\n@10\t1\tdashboard\t0\t100";
        return "@placeholder\t0\tdashboard\t1\t100";
      }
      if (joined.startsWith(`show-options -v -t ${clientSessionName} terminal-features`)) return "";
      return "";
    };
    const manager = new TmuxRuntimeManager(exec, () => {});

    manager.openTarget(
      { sessionName: hostSessionName, windowId: "@10", windowIndex: 0, windowName: "dashboard" },
      { insideTmux: true, clientSuffix: "268eff9c" },
    );

    expect(calls.some((call) => call.args.join(" ") === `unlink-window -t ${clientSessionName}:@placeholder`)).toBe(
      true,
    );
    expect(calls.some((call) => call.args.join(" ") === `set-option -t ${clientSessionName} renumber-windows on`)).toBe(
      true,
    );
  });

  it("switches an explicit client tty + suffix for cross-project openTarget", () => {
    const exec = createExecMock();
    const interactiveCalls: Array<{ args: string[]; cwd?: string }> = [];
    const interactiveExec: TmuxInteractiveExec = (args, options) => {
      interactiveCalls.push({ args, cwd: options?.cwd });
    };
    const manager = new TmuxRuntimeManager(exec, interactiveExec);
    const clientSessionName = manager.getProjectClientSessionName("aimux-mobile-abc", "268eff9c");

    manager.openTarget(
      { sessionName: "aimux-mobile-abc", windowId: "@3", windowIndex: 3, windowName: "codex" },
      { insideTmux: true, clientTty: "/dev/ttys999", clientSuffix: "268eff9c", returnSessionName: "other-client" },
    );

    // resolved B's per-this-client session from the explicit suffix (no ambient client lookup)
    expect(exec.calls.some((call) => call.args[0] === "new-session" && call.args.includes(clientSessionName))).toBe(
      true,
    );
    // recorded the explicit return session, and switched the explicit client tty
    expect(
      exec.calls.some(
        (call) => call.args.join(" ") === `set-option -t ${clientSessionName} @aimux-return-session other-client`,
      ),
    ).toBe(true);
    expect(interactiveCalls.at(-1)?.args).toEqual([
      "switch-client",
      "-c",
      "/dev/ttys999",
      "-t",
      `${clientSessionName}:3`,
    ]);
  });

  it("resolves cross-project client-session targets through their host session", () => {
    const baseExec = createExecMock();
    const hostSessionName = "aimux-mobile-abc";
    const otherClientSessionName = `${hostSessionName}-client-deadbeef`;
    const currentClientSessionName = `${hostSessionName}-client-268eff9c`;
    const exec = ((args, options) => {
      const joined = args.join(" ");
      if (joined === `show-options -v -t ${otherClientSessionName} @aimux-host-session`) return hostSessionName;
      return baseExec(args, options);
    }) as TmuxExec & { calls: Array<{ args: string[]; cwd?: string }> };
    exec.calls = baseExec.calls;
    const interactiveCalls: Array<{ args: string[]; cwd?: string }> = [];
    const interactiveExec: TmuxInteractiveExec = (args, options) => {
      interactiveCalls.push({ args, cwd: options?.cwd });
    };
    const manager = new TmuxRuntimeManager(exec, interactiveExec);

    manager.openTarget(
      { sessionName: otherClientSessionName, windowId: "@3", windowIndex: 3, windowName: "codex" },
      { insideTmux: true, clientTty: "/dev/ttys999", clientSuffix: "268eff9c", returnSessionName: "origin-client" },
    );

    expect(
      exec.calls.some(
        (call) =>
          call.args.join(" ") ===
          `new-session -d -s ${currentClientSessionName} -c /repo/mobile -n dashboard sh -lc tail -f /dev/null`,
      ),
    ).toBe(true);
    expect(
      exec.calls.some(
        (call) =>
          call.args.join(" ") === `set-option -t ${currentClientSessionName} @aimux-return-session origin-client`,
      ),
    ).toBe(true);
    expect(interactiveCalls.at(-1)?.args).toEqual([
      "switch-client",
      "-c",
      "/dev/ttys999",
      "-t",
      `${currentClientSessionName}:3`,
    ]);
  });

  it("resolves noncanonical root-metadata hosts through this client's session", () => {
    const hostSessionName = "renamed-host";
    const clientSessionName = `${hostSessionName}-client-268eff9c`;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      const linked = calls.some((call) => call.args[0] === "link-window");
      if (joined === "-V") return "tmux 3.5a";
      if (joined === `has-session -t ${clientSessionName}`) throw new Error("missing");
      if (joined === `show-options -v -t ${hostSessionName} @aimux-project-root`) return "/repo/mobile";
      if (
        joined ===
        `list-windows -t ${hostSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        return "@0\t0\tdashboard-268eff9c\t1\t100\n@3\t3\tcodex\t0\t90";
      }
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        return linked ? "@0\t0\tdashboard-268eff9c\t1\t100\n@3\t3\tcodex\t0\t90" : "@0\t0\tdashboard-268eff9c\t1\t100";
      }
      if (joined.startsWith(`show-options -v -t ${clientSessionName} terminal-features`)) return "";
      return "";
    };
    const interactiveCalls: Array<{ args: string[]; cwd?: string }> = [];
    const interactiveExec: TmuxInteractiveExec = (args, options) => {
      interactiveCalls.push({ args, cwd: options?.cwd });
    };
    const manager = new TmuxRuntimeManager(exec, interactiveExec);

    manager.openTarget(
      { sessionName: hostSessionName, windowId: "@3", windowIndex: 3, windowName: "codex" },
      { insideTmux: true, clientTty: "/dev/ttys999", clientSuffix: "268eff9c", returnSessionName: "origin-client" },
    );

    expect(
      calls.some(
        (call) =>
          call.args.join(" ") ===
          `new-session -d -s ${clientSessionName} -c /repo/mobile -n dashboard sh -lc tail -f /dev/null`,
      ),
    ).toBe(true);
    expect(calls.some((call) => call.args.join(" ") === `link-window -d -s @3 -t ${clientSessionName}`)).toBe(true);
    expect(interactiveCalls.at(-1)?.args).toEqual([
      "switch-client",
      "-c",
      "/dev/ttys999",
      "-t",
      `${clientSessionName}:3`,
    ]);
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

  it("links a host dashboard into the client dashboard slot when opening from inside tmux", () => {
    const hostSessionName = "aimux-mobile-abc";
    const clientSessionName = `${hostSessionName}-client-268eff9c`;
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const exec: TmuxExec = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const joined = args.join(" ");
      const linked = calls.some((call) => call.args.join(" ") === `link-window -d -s @121 -t ${clientSessionName}`);
      const swapped = calls.some(
        (call) => call.args.join(" ") === `swap-window -s ${clientSessionName}:@121 -t ${clientSessionName}:0`,
      );
      if (joined === "-V") return "tmux 3.5a";
      if (joined === `has-session -t ${clientSessionName}`) return "";
      if (joined === `show-options -v -t ${hostSessionName} @aimux-project-root`) return "/repo/mobile";
      if (joined === `show-options -v -t ${clientSessionName} renumber-windows`) return "on";
      if (joined === `show-options -v -t ${clientSessionName} @aimux-host-session`) return hostSessionName;
      if (joined === `show-options -v -t ${clientSessionName} @aimux-project-root`) return "/repo/mobile";
      if (joined === `show-options -v -t ${clientSessionName} @aimux-runtime-build`) return "";
      if (joined.startsWith(`show-options -v -t ${clientSessionName} terminal-features`)) return "";
      if (joined === "display-message -p #{client_session}") return clientSessionName;
      if (
        joined ===
        `list-windows -t ${hostSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        return "@121\t0\tdashboard\t1\t100\t0\n@46\t2\tcodex\t0\t90\t0";
      }
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        if (swapped) return "@121\t0\tdashboard\t1\t100\t0\n@125\t1\tdashboard\t0\t100\t0";
        if (linked) return "@125\t0\tdashboard\t1\t100\t0\n@121\t1\tdashboard\t0\t100\t0";
        return "@125\t0\tdashboard\t1\t100\t0";
      }
      return "";
    };
    const interactiveCalls: Array<{ args: string[]; cwd?: string }> = [];
    const interactiveExec: TmuxInteractiveExec = (args, options) => {
      interactiveCalls.push({ args, cwd: options?.cwd });
    };
    const manager = new TmuxRuntimeManager(exec, interactiveExec);

    manager.openTarget(
      { sessionName: hostSessionName, windowId: "@121", windowIndex: 0, windowName: "dashboard" },
      { insideTmux: true, clientTty: "/dev/ttys999", clientSuffix: "268eff9c" },
    );

    expect(calls.some((call) => call.args.join(" ") === "kill-window -t @125")).toBe(false);
    expect(calls.some((call) => call.args.join(" ") === `link-window -d -s @121 -t ${clientSessionName}`)).toBe(true);
    expect(
      calls.some(
        (call) => call.args.join(" ") === `swap-window -s ${clientSessionName}:@121 -t ${clientSessionName}:0`,
      ),
    ).toBe(true);
    expect(calls.some((call) => call.args.join(" ") === `unlink-window -t ${clientSessionName}:@125`)).toBe(true);
    expect(interactiveCalls.at(-1)?.args).toEqual([
      "switch-client",
      "-c",
      "/dev/ttys999",
      "-t",
      `${clientSessionName}:0`,
    ]);
  });

  it("repairs a stale reused client session without destroying linked windows", () => {
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
        `list-windows -t ${hostSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        return "@0\t0\tdashboard-268eff9c\t1\t100";
      }
      if (
        joined ===
        `list-windows -t ${clientSessionName} -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}	#{pane_dead}`
      ) {
        return "@1\t1\tdashboard-268eff9c\t1\t100\n@3\t3\tcodex\t0\t90";
      }
      if (joined === `show-options -v -t ${clientSessionName} @aimux-host-session`) return hostSessionName;
      if (joined === `show-options -v -t ${clientSessionName} @aimux-project-root`) return "/repo/mobile";
      if (joined === `show-options -v -t ${clientSessionName} @aimux-runtime-build`) return "stale-build";
      if (joined.startsWith("show-options -v -t ") && joined.endsWith(" terminal-features")) return "";
      if (args[0] === "set-option" && args[1] === "-as" && args[4] === "terminal-features") return "";
      if (joined === `move-window -s @1 -t ${clientSessionName}:0`) return "";
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

    expect(calls.some((call) => call.args.join(" ") === `kill-session -t ${clientSessionName}`)).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.args.join(" ") ===
          `new-session -d -s ${clientSessionName} -c /repo/mobile -n dashboard sh -lc tail -f /dev/null`,
      ),
    ).toBe(false);
    expect(calls.some((call) => call.args.join(" ") === `move-window -s @1 -t ${clientSessionName}:0`)).toBe(true);
    expect(calls.some((call) => call.args[0] === "set-option" && call.args[3] === "@aimux-runtime-build")).toBe(true);
  });

  it("stamps a new client session runtime contract before long configuration", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    const hostSessionName = manager.getProjectSession("/repo/mobile").sessionName;
    const clientSessionName = `${hostSessionName}-client-deadbeef`;

    (
      manager as unknown as { ensureClientSession: (host: string, client: string, root: string) => void }
    ).ensureClientSession(hostSessionName, clientSessionName, "/repo/mobile");

    const contractIndex = exec.calls.findIndex(
      (call) => call.args[0] === "set-option" && call.args[3] === TMUX_RUNTIME_CONTRACT_OPTION,
    );
    const projectRootIndex = exec.calls.findIndex(
      (call) => call.args.join(" ") === `set-option -t ${clientSessionName} @aimux-project-root /repo/mobile`,
    );
    expect(contractIndex).toBeGreaterThan(-1);
    expect(projectRootIndex).toBeGreaterThan(-1);
    expect(contractIndex).toBeLessThan(projectRootIndex);
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
    manager.resizeTarget(target, 100, 32);

    expect(exec.calls.slice(-5).map((call) => call.args)).toEqual([
      ["capture-pane", "-p", "-J", "-t", "@3", "-S", "-200"],
      ["send-keys", "-t", "@3", "-l", "hello"],
      ["send-keys", "-t", "@3", "Enter"],
      ["send-keys", "-t", "@3", "C-j"],
      ["resize-window", "-t", "@3", "-x", "100", "-y", "32"],
    ]);
  });

  it("starts and stops pane pipes with a quoted file sink", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    const target = {
      sessionName: "aimux-mobile-abc",
      windowId: "@3",
      windowIndex: 3,
      windowName: "codex",
    };

    manager.startPanePipe(target, "cat >> /tmp/plain.log");
    manager.pipeTargetToFile(target, "/tmp/aimux tap/it's.log", { onlyIfNotPiped: true });
    manager.stopPanePipe(target);

    expect(exec.calls.slice(-3).map((call) => call.args)).toEqual([
      ["pipe-pane", "-t", "@3", "cat >> /tmp/plain.log"],
      ["pipe-pane", "-t", "@3", "-o", `cat >> '/tmp/aimux tap/it'"'"'s.log'`],
      ["pipe-pane", "-t", "@3"],
    ]);
  });

  it("can mark pane pipe file sinks with an ownership token", () => {
    const exec = createExecMock();
    const manager = new TmuxRuntimeManager(exec);
    const target = {
      sessionName: "aimux-mobile-abc",
      windowId: "@3",
      windowIndex: 3,
      windowName: "codex",
    };

    manager.pipeTargetToFile(target, "/tmp/aimux tap/output.log", {
      onlyIfNotPiped: true,
      ownership: { token: "tap-token", tokenFilePath: "/tmp/aimux tap/token.txt" },
    });

    const command = exec.calls.at(-1)?.args.at(-1) ?? "";
    expect(exec.calls.at(-1)?.args.slice(0, -1)).toEqual(["pipe-pane", "-t", "@3", "-o"]);
    expect(command).toContain("sh -c");
    expect(command).toContain("'tap-token'");
    expect(command).toContain("'/tmp/aimux tap/token.txt'");
    expect(command).toContain("'/tmp/aimux tap/output.log'");
    expect(command).toContain("trap");
  });

  it("does not leak raw tmux launch argv when window creation fails", () => {
    const manager = new TmuxRuntimeManager(
      vi.fn<TmuxExec>(() => {
        throw new Error("Command failed: tmux new-window env -i OPENAI_API_KEY=sk-real SECRET_TOKEN=abc");
      }),
    );

    expect(() =>
      manager.createWindow("aimux-proj", "claude", "/repo", "env", ["-i", "OPENAI_API_KEY=sk-real", "claude"]),
    ).toThrow('tmux failed to create window "claude" in session aimux-proj');
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

    expect(exec.calls.slice(-3).map((call) => call.args)).toEqual([
      ["set-window-option", "-q", "-t", "@3", "@aimux-tool", "codex"],
      ["set-window-option", "-q", "-t", "@3", "allow-passthrough", MANAGED_TMUX_AGENT_WINDOW_OPTIONS.allowPassthrough],
      ["set-window-option", "-q", "-t", "@3", "aggressive-resize", MANAGED_TMUX_AGENT_WINDOW_OPTIONS.aggressiveResize],
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
        args: ["/repo/mobile/dist/launcher-bin.js", "--tmux-dashboard-internal"],
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
      "/repo/mobile/dist/launcher-bin.js",
      "--tmux-dashboard-internal",
    ]);
  });

  it("replaces a window only after a detached replacement reports ready", () => {
    const exec = vi.fn<TmuxExec>((args: string[]) => {
      const joined = args.join(" ");
      if (joined === "display-message -p -t @1 #{window_active}") return "1";
      if (joined.startsWith("new-window -d -P -t aimux-mobile-abc ")) {
        return "@2\t2\taimux-reload-1";
      }
      if (joined === "show-window-options -v -t @2 @ready") return "stamp";
      if (joined.startsWith("list-windows -t aimux-mobile-abc -F ")) {
        return ["@2\t0\tdashboard\t1\t100\t0", "@1\t2\tdashboard-old\t0\t90\t0"].join("\n");
      }
      return "";
    });
    const manager = new TmuxRuntimeManager(exec);

    const replacement = manager.replaceWindowWhenReady(
      {
        sessionName: "aimux-mobile-abc",
        windowId: "@1",
        windowIndex: 0,
        windowName: "dashboard",
      },
      {
        cwd: "/repo/mobile",
        command: "/usr/local/bin/node",
        args: ["/repo/mobile/dist/launcher-bin.js", "--tmux-dashboard-internal"],
      },
      { option: "@ready", value: "stamp", timeoutMs: 100 },
    );

    expect(replacement).toEqual({
      sessionName: "aimux-mobile-abc",
      windowId: "@2",
      windowIndex: 0,
      windowName: "dashboard",
      paneDead: false,
    });
    const newWindowCall = exec.mock.calls.find((call) => call[0][0] === "new-window")?.[0] ?? [];
    expect(newWindowCall).toContain("-d");
    expect(newWindowCall[newWindowCall.indexOf("-n") + 1]).not.toMatch(/^dashboard/);
    const ordered = exec.mock.calls
      .map((call) => call[0].join(" "))
      .filter((call) => /rename-window|swap-window|kill-window|select-window/.test(call));
    expect(ordered).toEqual([
      "rename-window -t @1 dashboard-old",
      "rename-window -t @2 dashboard",
      "swap-window -d -s @2 -t @1",
      "kill-window -t @1",
      "select-window -t @2",
    ]);
  });

  it("kills a timed-out replacement without touching the original window", () => {
    const exec = vi.fn<TmuxExec>((args: string[]) => {
      const joined = args.join(" ");
      if (joined === "display-message -p -t @1 #{window_active}") return "0";
      if (joined.startsWith("new-window -d -P -t aimux-mobile-abc ")) {
        return "@2\t2\taimux-reload-1";
      }
      if (joined === "show-window-options -v -t @2 @ready") return "";
      return "";
    });
    const manager = new TmuxRuntimeManager(exec);

    expect(() =>
      manager.replaceWindowWhenReady(
        {
          sessionName: "aimux-mobile-abc",
          windowId: "@1",
          windowIndex: 0,
          windowName: "dashboard",
        },
        {
          cwd: "/repo/mobile",
          command: "/usr/local/bin/node",
          args: ["/repo/mobile/dist/launcher-bin.js", "--tmux-dashboard-internal"],
        },
        { option: "@ready", value: "stamp", timeoutMs: 1 },
      ),
    ).toThrow(/Timed out waiting for replacement tmux window @2/);

    expect(exec.mock.calls.map((call) => call[0].join(" "))).toContain("kill-window -t @2");
    expect(exec.mock.calls.map((call) => call[0].join(" "))).not.toContain("kill-window -t @1");
  });

  it("rolls back a ready replacement when the window swap fails", () => {
    const exec = vi.fn<TmuxExec>((args: string[]) => {
      const joined = args.join(" ");
      if (joined === "display-message -p -t @1 #{window_active}") return "1";
      if (joined.startsWith("new-window -d -P -t aimux-mobile-abc ")) {
        return "@2\t2\taimux-reload-1";
      }
      if (joined === "show-window-options -v -t @2 @ready") return "stamp";
      if (joined === "swap-window -d -s @2 -t @1") throw new Error("swap failed");
      return "";
    });
    const manager = new TmuxRuntimeManager(exec);

    expect(() =>
      manager.replaceWindowWhenReady(
        {
          sessionName: "aimux-mobile-abc",
          windowId: "@1",
          windowIndex: 0,
          windowName: "dashboard",
        },
        {
          cwd: "/repo/mobile",
          command: "/usr/local/bin/node",
          args: ["/repo/mobile/dist/launcher-bin.js", "--tmux-dashboard-internal"],
        },
        { option: "@ready", value: "stamp", timeoutMs: 100 },
      ),
    ).toThrow(/swap failed/);

    const calls = exec.mock.calls.map((call) => call[0].join(" "));
    expect(calls).toEqual(
      expect.arrayContaining([
        "rename-window -t @1 dashboard-old",
        "rename-window -t @2 dashboard",
        "swap-window -d -s @2 -t @1",
        "rename-window -t @1 dashboard",
        "kill-window -t @2",
      ]),
    );
    expect(calls.some((call) => /^rename-window -t @2 aimux-reload-1-[a-z0-9]+$/.test(call))).toBe(true);
    expect(calls).not.toContain("kill-window -t @1");
  });

  it("detects whether aimux is already inside tmux", () => {
    const manager = new TmuxRuntimeManager(createExecMock());
    expect(manager.isInsideTmux({ TMUX: "/tmp/tmux-1000/default,123,0" } as NodeJS.ProcessEnv)).toBe(true);
    expect(manager.isInsideTmux({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
