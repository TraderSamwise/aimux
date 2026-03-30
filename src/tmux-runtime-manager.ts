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

  ensureProjectSession(projectRoot: string): TmuxSessionRef {
    const session = this.getProjectSession(projectRoot);
    if (!this.hasSession(session.sessionName)) {
      this.exec(
        [
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
        ],
        { cwd: projectRoot },
      );
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

  ensureDashboardWindow(sessionName: string, projectRoot: string): TmuxTarget {
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
    this.exec(
      ["new-window", "-d", "-t", `${sessionName}:0`, "-c", projectRoot, "-n", "dashboard", "sh", "-lc", "printf ''"],
      {
        cwd: projectRoot,
      },
    );
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

  selectWindow(target: TmuxTarget): void {
    this.exec(["select-window", "-t", target.windowId]);
  }

  attachSession(sessionName: string): void {
    this.exec(["attach-session", "-t", sessionName]);
  }

  switchClient(sessionName: string, windowIndex = 0): void {
    this.exec(["switch-client", "-t", `${sessionName}:${windowIndex}`]);
  }

  openTarget(target: TmuxTarget, options: OpenTargetOptions = {}): void {
    if (options.insideTmux) {
      this.switchClient(target.sessionName, target.windowIndex);
      return;
    }
    this.attachSession(target.sessionName);
  }
}
