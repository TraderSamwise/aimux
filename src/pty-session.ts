import * as pty from "node-pty";
import { StatusDetector, type SessionStatus } from "./status-detector.js";
import { Recorder } from "./recorder.js";
import stripAnsi from "strip-ansi";
import { SessionTerminalState, type SessionTerminalSnapshot } from "./session-terminal-state.js";

export { type SessionStatus } from "./status-detector.js";

export interface PtySessionOptions {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
  record?: boolean;
  id?: string;
  /** Regex patterns for idle/prompt detection */
  promptPatterns?: RegExp[];
}

export class PtySession {
  readonly id: string;
  readonly command: string;
  /** Backend tool's native session ID (e.g. claude --session-id value) */
  backendSessionId?: string;
  private process: pty.IPty;
  private _exited = false;
  private _exitCode: number | undefined;
  private statusDetector: StatusDetector;
  private recorder: Recorder | null = null;
  private terminalState: SessionTerminalState;

  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(code: number) => void> = [];

  constructor(opts: PtySessionOptions) {
    this.id = opts.id ?? `${opts.command}-${randomId()}`;
    this.command = opts.command;
    this.statusDetector = new StatusDetector(opts.promptPatterns);
    this.terminalState = new SessionTerminalState(opts.cols, opts.rows);

    if (opts.record !== false) {
      this.recorder = new Recorder(this.id);
    }

    // Spawn via shell to handle wrapper scripts and ensure PATH resolution
    const shell = process.env.SHELL || "/bin/zsh";
    // Shell-escape args: wrap in single quotes, escaping any embedded single quotes
    const shellEscape = (s: string) => {
      if (!s.includes(" ") && !s.includes("'") && !s.includes('"') && !s.includes("`")) return s;
      return "'" + s.replace(/'/g, "'\\''") + "'";
    };
    const cmdStr = [opts.command, ...opts.args].map(shellEscape).join(" ");
    this.process = pty.spawn(shell, ["-ilc", cmdStr], {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...opts.env,
        AIMUX: "1",
        AIMUX_SESSION_ID: this.id,
        AIMUX_CONTEXT_DIR: ".aimux/context",
        AIMUX_RECORDINGS_DIR: ".aimux/recordings",
      } as Record<string, string>,
    });

    this.process.onData((data) => {
      // Feed into virtual terminal for screen capture
      this.terminalState.write(data);
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
    this.terminalState.resize(cols, rows);
  }

  /**
   * Get the current screen content from the virtual terminal buffer.
   * Returns ANSI escape sequences that reproduce the visible screen.
   */
  getScreenState(): string {
    return this.terminalState.getScreenState();
  }

  getTerminalSnapshot(): SessionTerminalSnapshot {
    return this.terminalState.exportSnapshot();
  }

  getCursorPosition(): { row: number; col: number } {
    return this.terminalState.getCursorPosition();
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
    this.terminalState.dispose();
    this.kill();
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8);
}
