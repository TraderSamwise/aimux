import { createHash } from "node:crypto";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";

export interface TmuxExecOptions {
  cwd?: string;
}

export type TmuxExec = (args: string[], options?: TmuxExecOptions) => string;

export interface TmuxWindowInfo {
  id: string;
  index: number;
  name: string;
  active: boolean;
}

export interface TmuxSessionRef {
  projectRoot: string;
  projectId: string;
  sessionName: string;
}

export interface TmuxTarget {
  sessionName: string;
  windowId: string;
  windowIndex: number;
  windowName: string;
}

export interface OpenTargetOptions {
  insideTmux?: boolean;
}

export interface CaptureTargetOptions {
  /** Number of lines from the bottom of scrollback to include. */
  startLine?: number;
}

export interface TmuxCommandSpec {
  cwd: string;
  command: string;
  args: string[];
}

const DEFAULT_EXEC: TmuxExec = (args, options) =>
  execFileSync("tmux", args, {
    cwd: options?.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export class TmuxRuntimeManager {
  constructor(private readonly exec: TmuxExec = DEFAULT_EXEC) {}

  isAvailable(): boolean {
    try {
      this.exec(["-V"]);
      return true;
    } catch {
      return false;
    }
  }

  getProjectSession(projectRoot: string): TmuxSessionRef {
    const projectId = createHash("sha1").update(projectRoot).digest("hex").slice(0, 10);
    const slug = basename(projectRoot).replace(/[^a-zA-Z0-9_-]+/g, "-") || "project";
    return {
      projectRoot,
      projectId,
      sessionName: `aimux:${slug}:${projectId}`,
    };
  }

  hasSession(sessionName: string): boolean {
    try {
      this.exec(["has-session", "-t", sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  ensureProjectSession(projectRoot: string, dashboardCommand?: TmuxCommandSpec): TmuxSessionRef {
    const session = this.getProjectSession(projectRoot);
    if (!this.hasSession(session.sessionName)) {
      const argv =
        dashboardCommand && dashboardCommand.args.length >= 0
          ? [
              "new-session",
              "-d",
              "-s",
              session.sessionName,
              "-c",
              dashboardCommand.cwd,
              "-n",
              "dashboard",
              dashboardCommand.command,
              ...dashboardCommand.args,
            ]
          : [
              "new-session",
              "-d",
              "-s",
              session.sessionName,
              "-c",
              projectRoot,
              "-n",
              "dashboard",
              "sh",
              "-lc",
              "printf ''",
            ];
      this.exec(argv, { cwd: projectRoot });
    }
    return session;
  }

  listWindows(sessionName: string): TmuxWindowInfo[] {
    const raw = this.exec([
      "list-windows",
      "-t",
      sessionName,
      "-F",
      "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}",
    ]);
    if (!raw) return [];
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, index, name, active] = line.split("\t");
        return {
          id,
          index: Number(index),
          name,
          active: active === "1",
        };
      });
  }

  getTargetByWindowId(sessionName: string, windowId: string): TmuxTarget | null {
    const window = this.listWindows(sessionName).find((entry) => entry.id === windowId);
    if (!window) return null;
    return {
      sessionName,
      windowId: window.id,
      windowIndex: window.index,
      windowName: window.name,
    };
  }

  hasWindow(target: TmuxTarget): boolean {
    return this.getTargetByWindowId(target.sessionName, target.windowId) !== null;
  }

  ensureDashboardWindow(sessionName: string, projectRoot: string, dashboardCommand?: TmuxCommandSpec): TmuxTarget {
    const existing = this.listWindows(sessionName).find((window) => window.index === 0 || window.name === "dashboard");
    if (existing) {
      this.renameWindow(existing.id, "dashboard");
      return {
        sessionName,
        windowId: existing.id,
        windowIndex: existing.index,
        windowName: "dashboard",
      };
    }
    const argv =
      dashboardCommand && dashboardCommand.args.length >= 0
        ? [
            "new-window",
            "-d",
            "-t",
            `${sessionName}:0`,
            "-c",
            dashboardCommand.cwd,
            "-n",
            "dashboard",
            dashboardCommand.command,
            ...dashboardCommand.args,
          ]
        : [
            "new-window",
            "-d",
            "-t",
            `${sessionName}:0`,
            "-c",
            projectRoot,
            "-n",
            "dashboard",
            "sh",
            "-lc",
            "printf ''",
          ];
    this.exec(argv, {
      cwd: projectRoot,
    });
    const created = this.listWindows(sessionName).find((window) => window.index === 0);
    if (!created) {
      throw new Error(`Failed to create dashboard window in tmux session ${sessionName}`);
    }
    return {
      sessionName,
      windowId: created.id,
      windowIndex: created.index,
      windowName: created.name,
    };
  }

  createWindow(sessionName: string, name: string, cwd: string, command: string, args: string[]): TmuxTarget {
    const argv = [
      "new-window",
      "-P",
      "-t",
      sessionName,
      "-c",
      cwd,
      "-n",
      name,
      "-F",
      "#{window_id}\t#{window_index}\t#{window_name}",
      command,
      ...args,
    ];
    const raw = this.exec(argv, { cwd });
    const [windowId, index, windowName] = raw.split("\t");
    return {
      sessionName,
      windowId,
      windowIndex: Number(index),
      windowName,
    };
  }

  killWindow(target: TmuxTarget): void {
    this.exec(["kill-window", "-t", target.windowId]);
  }

  renameWindow(windowTarget: string, name: string): void {
    this.exec(["rename-window", "-t", windowTarget, name]);
  }

  respawnWindow(target: TmuxTarget, spec: TmuxCommandSpec): void {
    this.exec(["respawn-window", "-k", "-t", target.windowId, "-c", spec.cwd, spec.command, ...spec.args], {
      cwd: spec.cwd,
    });
  }

  selectWindow(target: TmuxTarget): void {
    this.exec(["select-window", "-t", target.windowId]);
  }

  captureTarget(target: TmuxTarget, options: CaptureTargetOptions = {}): string {
    const startLine = options.startLine ?? "-";
    return this.exec(["capture-pane", "-p", "-J", "-t", target.windowId, "-S", String(startLine)]);
  }

  sendText(target: TmuxTarget, text: string): void {
    if (!text) return;
    this.exec(["send-keys", "-t", target.windowId, "-l", text]);
  }

  sendEnter(target: TmuxTarget): void {
    this.exec(["send-keys", "-t", target.windowId, "Enter"]);
  }

  attachSession(sessionName: string): void {
    this.exec(["attach-session", "-t", sessionName]);
  }

  switchClient(sessionName: string, windowIndex = 0): void {
    this.exec(["switch-client", "-t", `${sessionName}:${windowIndex}`]);
  }

  isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env.TMUX);
  }

  openTarget(target: TmuxTarget, options: OpenTargetOptions = {}): void {
    if (options.insideTmux) {
      this.switchClient(target.sessionName, target.windowIndex);
      return;
    }
    this.attachSession(target.sessionName);
  }
}
