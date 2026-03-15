import * as pty from "node-pty";
import { StatusDetector, type SessionStatus } from "./status-detector.js";
import { Recorder } from "./recorder.js";
import stripAnsi from "strip-ansi";

export { type SessionStatus } from "./status-detector.js";

export interface PtySessionOptions {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
  record?: boolean;
}

export class PtySession {
  readonly id: string;
  readonly command: string;
  private process: pty.IPty;
  private _exited = false;
  private _exitCode: number | undefined;
  private statusDetector: StatusDetector;
  private recorder: Recorder | null = null;

  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(code: number) => void> = [];

  constructor(opts: PtySessionOptions) {
    this.id = `${opts.command}-${randomId()}`;
    this.command = opts.command;
    this.statusDetector = new StatusDetector(opts.command);

    if (opts.record !== false) {
      this.recorder = new Recorder(this.id, opts.cwd);
    }

    // Spawn via shell to handle wrapper scripts and ensure PATH resolution
    const shell = process.env.SHELL || "/bin/zsh";
    const cmdStr = [opts.command, ...opts.args].map(a => a.includes(" ") ? `'${a}'` : a).join(" ");
    this.process = pty.spawn(shell, ["-ilc", cmdStr], {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env } as Record<string, string>,
    });

    this.process.onData((data) => {
      // Feed stripped output to status detector
      this.statusDetector.feed(stripAnsi(data));
      // Record output
      this.recorder?.write(data);
      for (const cb of this.dataListeners) cb(data);
    });

    this.process.onExit(({ exitCode }) => {
      this._exited = true;
      this._exitCode = exitCode;
      this.statusDetector.markExited();
      this.recorder?.close();
      for (const cb of this.exitListeners) cb(exitCode);
    });
  }

  get exited(): boolean {
    return this._exited;
  }

  get exitCode(): number | undefined {
    return this._exitCode;
  }

  write(data: string): void {
    if (!this._exited) {
      this.process.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (!this._exited) {
      this.process.resize(cols, rows);
    }
  }

  onData(cb: (data: string) => void): void {
    this.dataListeners.push(cb);
  }

  onExit(cb: (code: number) => void): void {
    this.exitListeners.push(cb);
  }

  get status(): SessionStatus {
    return this.statusDetector.status;
  }

  kill(): void {
    if (!this._exited) {
      this.process.kill();
    }
  }

  destroy(): void {
    this.statusDetector.destroy();
    this.kill();
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8);
}
