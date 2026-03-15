import * as pty from "node-pty";
import pkg from "@xterm/headless";
const { Terminal } = pkg;
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
  id?: string;
}

export class PtySession {
  readonly id: string;
  readonly command: string;
  private process: pty.IPty;
  private _exited = false;
  private _exitCode: number | undefined;
  private statusDetector: StatusDetector;
  private recorder: Recorder | null = null;
  private vt: InstanceType<typeof Terminal>;

  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(code: number) => void> = [];

  constructor(opts: PtySessionOptions) {
    this.id = opts.id ?? `${opts.command}-${randomId()}`;
    this.command = opts.command;
    this.statusDetector = new StatusDetector(opts.command);
    this.vt = new Terminal({ cols: opts.cols, rows: opts.rows, allowProposedApi: true });

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
      this.vt.write(data);
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
    this.vt.resize(cols, rows);
  }

  /**
   * Get the current screen content from the virtual terminal buffer.
   * Returns ANSI escape sequences that reproduce the visible screen.
   */
  getScreenState(): string {
    const buffer = this.vt.buffer.active;
    const cols = this.vt.cols;
    const rows = this.vt.rows;
    let output = "\x1b[2J\x1b[H\x1b[0m"; // clear screen + home + reset attrs

    for (let y = 0; y < rows; y++) {
      const line = buffer.getLine(y);
      if (!line) {
        output += "\r\n";
        continue;
      }

      let prevFg = -1;
      let prevBg = -1;
      let prevBold = false;
      let prevItalic = false;
      let prevUnderline = false;
      let prevDim = false;
      let prevInverse = false;

      for (let x = 0; x < cols; x++) {
        const cell = line.getCell(x);
        if (!cell) break;

        // Extract cell attributes
        const fg = cell.getFgColor();
        const bg = cell.getBgColor();
        const bold = cell.isBold() !== 0;
        const italic = cell.isItalic() !== 0;
        const underline = cell.isUnderline() !== 0;
        const dim = cell.isDim() !== 0;
        const inverse = cell.isInverse() !== 0;
        const fgColorMode = cell.isFgRGB() ? "rgb" : cell.isFgPalette() ? "palette" : cell.isFgDefault() ? "default" : "default";
        const bgColorMode = cell.isBgRGB() ? "rgb" : cell.isBgPalette() ? "palette" : cell.isBgDefault() ? "default" : "default";

        // Check if attributes changed
        if (fg !== prevFg || bg !== prevBg || bold !== prevBold ||
            italic !== prevItalic || underline !== prevUnderline ||
            dim !== prevDim || inverse !== prevInverse) {
          const sgr: number[] = [0]; // reset first

          if (bold) sgr.push(1);
          if (dim) sgr.push(2);
          if (italic) sgr.push(3);
          if (underline) sgr.push(4);
          if (inverse) sgr.push(7);

          if (fgColorMode === "palette") {
            if (fg < 8) sgr.push(30 + fg);
            else if (fg < 16) sgr.push(90 + fg - 8);
            else sgr.push(38, 5, fg);
          } else if (fgColorMode === "rgb") {
            sgr.push(38, 2, (fg >> 16) & 0xff, (fg >> 8) & 0xff, fg & 0xff);
          }

          if (bgColorMode === "palette") {
            if (bg < 8) sgr.push(40 + bg);
            else if (bg < 16) sgr.push(100 + bg - 8);
            else sgr.push(48, 5, bg);
          } else if (bgColorMode === "rgb") {
            sgr.push(48, 2, (bg >> 16) & 0xff, (bg >> 8) & 0xff, bg & 0xff);
          }

          output += `\x1b[${sgr.join(";")}m`;

          prevFg = fg;
          prevBg = bg;
          prevBold = bold;
          prevItalic = italic;
          prevUnderline = underline;
          prevDim = dim;
          prevInverse = inverse;
        }

        output += cell.getChars() || " ";
      }

      output += "\x1b[0m"; // reset at end of line
      prevFg = -1; prevBg = -1; // force re-emit on next line
      if (y < rows - 1) output += "\r\n";
    }

    // Restore cursor position
    const cursorY = buffer.cursorY + 1;
    const cursorX = buffer.cursorX + 1;
    output += `\x1b[${cursorY};${cursorX}H`;

    return output;
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
    this.vt.dispose();
    this.kill();
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8);
}
