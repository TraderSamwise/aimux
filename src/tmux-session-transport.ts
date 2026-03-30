import { debug } from "./debug.js";
import type { SessionStatus } from "./status-detector.js";
import { TmuxRuntimeManager, type TmuxTarget } from "./tmux-runtime-manager.js";

export class TmuxSessionTransport {
  readonly command: string;
  backendSessionId?: string;
  private _exited = false;
  private _exitCode: number | undefined;
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(code: number) => void> = [];
  private readonly pollInterval: ReturnType<typeof setInterval>;
  private cols: number;
  private rows: number;

  constructor(
    readonly id: string,
    command: string,
    private target: TmuxTarget,
    private manager: TmuxRuntimeManager,
    cols: number,
    rows: number,
  ) {
    this.command = command;
    this.cols = cols;
    this.rows = rows;
    this.pollInterval = setInterval(() => this.pollLiveness(), 1000);
  }

  get exited(): boolean {
    return this._exited;
  }

  get exitCode(): number | undefined {
    return this._exitCode;
  }

  get status(): SessionStatus {
    return this._exited ? "exited" : "running";
  }

  get tmuxTarget(): TmuxTarget {
    return this.target;
  }

  write(data: string): void {
    if (this._exited || !data) return;
    const normalized = data.replace(/\r/g, "\n");
    const chunks = normalized.split("\n");
    chunks.forEach((chunk, index) => {
      if (chunk) this.manager.sendText(this.target, chunk);
      if (index < chunks.length - 1 || normalized.endsWith("\n")) {
        this.manager.sendEnter(this.target);
      }
    });
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  onData(cb: (data: string) => void): void {
    this.dataListeners.push(cb);
  }

  onExit(cb: (code: number) => void): void {
    this.exitListeners.push(cb);
  }

  kill(): void {
    if (this._exited) return;
    try {
      this.manager.killWindow(this.target);
    } catch {}
    this.markExited(0);
  }

  destroy(): void {
    clearInterval(this.pollInterval);
  }

  renameWindow(name: string): void {
    this.manager.renameWindow(this.target.windowId, name);
    this.target = { ...this.target, windowName: name };
  }

  open(): void {
    this.manager.openTarget(this.target, { insideTmux: this.manager.isInsideTmux() });
  }

  private pollLiveness(): void {
    if (this._exited) return;
    try {
      const resolved = this.manager.getTargetByWindowId(this.target.sessionName, this.target.windowId);
      if (!resolved) {
        this.markExited(0);
        return;
      }
      this.target = resolved;
    } catch (error) {
      debug(`tmux poll failed for ${this.id}: ${String(error)}`, "tmux");
    }
  }

  private markExited(code: number): void {
    if (this._exited) return;
    this._exited = true;
    this._exitCode = code;
    clearInterval(this.pollInterval);
    for (const listener of this.exitListeners) listener(code);
  }
}
