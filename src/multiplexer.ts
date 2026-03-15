import { PtySession, type PtySessionOptions } from "./pty-session.js";
import { HotkeyHandler, type HotkeyAction } from "./hotkeys.js";
import { Dashboard, type DashboardSession } from "./dashboard.js";
import { captureGitContext } from "./context/context-bridge.js";
import { parseKeys } from "./key-parser.js";
import { loadConfig } from "./config.js";

export type MuxMode = "focused" | "dashboard";

export class Multiplexer {
  private sessions: PtySession[] = [];
  private activeIndex = 0;
  private mode: MuxMode = "focused";
  private rawModeWas: boolean | undefined;
  private hotkeys: HotkeyHandler;
  private dashboard: Dashboard;
  private onStdinData: ((data: Buffer) => void) | null = null;
  private onResize: (() => void) | null = null;
  private resolveRun: ((code: number) => void) | null = null;
  private defaultCommand: string = "claude";
  private defaultArgs: string[] = [];
  private startedInDashboard = false;
  private pickerActive = false;

  constructor() {
    this.hotkeys = new HotkeyHandler((action) => this.handleAction(action));
    this.dashboard = new Dashboard();
  }

  get activeSession(): PtySession | null {
    return this.sessions[this.activeIndex] ?? null;
  }

  get sessionCount(): number {
    return this.sessions.length;
  }

  async run(opts: Omit<PtySessionOptions, "cols" | "rows">): Promise<number> {
    this.defaultCommand = opts.command;
    this.defaultArgs = opts.args;

    // Create initial session
    this.createSession(opts.command, opts.args);

    // Enter raw mode
    this.enterRawMode();

    // Forward stdin through hotkey handler → active PTY
    this.onStdinData = (data: Buffer) => {
      if (this.pickerActive) {
        this.handleToolPickerKey(data);
        return;
      }

      if (this.mode === "dashboard") {
        this.handleDashboardKey(data);
        return;
      }

      const passthrough = this.hotkeys.feed(data);
      if (passthrough !== null) {
        this.activeSession?.write(passthrough);
      }
    };
    process.stdin.on("data", this.onStdinData);

    // Forward terminal resize → all PTYs + redraw dashboard
    this.onResize = () => {
      const cols = process.stdout.columns ?? 80;
      const rows = process.stdout.rows ?? 24;
      for (const session of this.sessions) {
        session.resize(cols, rows);
      }
      if (this.mode === "dashboard") {
        this.renderDashboard();
      }
    };
    process.stdout.on("resize", this.onResize);

    // Wait until all sessions exit or explicit quit
    const exitCode = await new Promise<number>((resolve) => {
      this.resolveRun = resolve;
    });

    // Cleanup
    this.teardown();
    return exitCode;
  }

  async runDashboard(): Promise<number> {
    this.startedInDashboard = true;

    // Load config to set default tool for session creation
    const config = loadConfig();
    const defaultTool = config.tools[config.defaultTool];
    if (defaultTool) {
      this.defaultCommand = defaultTool.command;
      this.defaultArgs = defaultTool.args;
    }

    this.enterRawMode();

    // Forward stdin
    this.onStdinData = (data: Buffer) => {
      if (this.pickerActive) {
        this.handleToolPickerKey(data);
        return;
      }

      if (this.mode === "dashboard") {
        this.handleDashboardKey(data);
        return;
      }

      const passthrough = this.hotkeys.feed(data);
      if (passthrough !== null) {
        this.activeSession?.write(passthrough);
      }
    };
    process.stdin.on("data", this.onStdinData);

    // Forward terminal resize
    this.onResize = () => {
      const cols = process.stdout.columns ?? 80;
      const rows = process.stdout.rows ?? 24;
      for (const session of this.sessions) {
        session.resize(cols, rows);
      }
      if (this.mode === "dashboard") {
        this.renderDashboard();
      }
    };
    process.stdout.on("resize", this.onResize);

    // Enter dashboard mode directly
    this.mode = "dashboard";
    process.stdout.write("\x1b[?1049h");
    this.renderDashboard();

    const exitCode = await new Promise<number>((resolve) => {
      this.resolveRun = resolve;
    });

    this.teardown();
    return exitCode;
  }

  createSession(command: string, args: string[]): PtySession {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    const session = new PtySession({ command, args, cols, rows });

    // Forward output to stdout only when this session is active and focused
    session.onData((data) => {
      if (this.mode === "focused" && this.sessions[this.activeIndex] === session) {
        process.stdout.write(data);
      }
    });

    // Handle session exit
    session.onExit((_code) => {
      // Capture git context on session exit (fire-and-forget)
      captureGitContext(session.id, session.command).catch(() => {});

      const idx = this.sessions.indexOf(session);
      if (idx === -1) return;

      this.sessions.splice(idx, 1);

      if (this.sessions.length === 0) {
        if (this.startedInDashboard) {
          // Stay in dashboard with no sessions
          this.setMode("dashboard");
          return;
        }
        this.resolveRun?.(_code);
        return;
      }

      // Adjust active index
      if (this.activeIndex >= this.sessions.length) {
        this.activeIndex = this.sessions.length - 1;
      }

      // Refresh view
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.focusSession(this.activeIndex);
      }
    });

    this.sessions.push(session);

    // Focus the new session
    this.activeIndex = this.sessions.length - 1;
    if (this.mode === "dashboard") {
      // Stay in dashboard but update it
      this.renderDashboard();
    } else if (this.sessions.length > 1) {
      this.focusSession(this.activeIndex);
    }

    return session;
  }

  private focusSession(index: number): void {
    if (index < 0 || index >= this.sessions.length) return;

    this.activeIndex = index;
    this.setMode("focused");

    // Restore the session's screen from its virtual terminal buffer
    process.stdout.write(this.sessions[index].getScreenState());
  }

  private handleAction(action: HotkeyAction): void {
    switch (action.type) {
      case "dashboard":
        this.setMode("dashboard");
        break;

      case "focus":
        if (action.index < this.sessions.length) {
          this.focusSession(action.index);
        }
        break;

      case "next":
        if (this.sessions.length > 1) {
          this.focusSession((this.activeIndex + 1) % this.sessions.length);
        }
        break;

      case "prev":
        if (this.sessions.length > 1) {
          this.focusSession(
            (this.activeIndex - 1 + this.sessions.length) % this.sessions.length
          );
        }
        break;

      case "create":
        this.showToolPicker();
        break;

      case "kill":
        if (this.sessions.length > 0) {
          const session = this.sessions[this.activeIndex];
          session.kill();
        }
        break;

      case "passthrough":
        this.activeSession?.write(action.data);
        break;
    }
  }

  private handleDashboardKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;

    // Digits 1-9: focus session
    if (key >= "1" && key <= "9") {
      const index = parseInt(key) - 1;
      if (index < this.sessions.length) {
        this.focusSession(index);
      }
      return;
    }

    switch (key) {
      case "c":
        this.showToolPicker();
        break;
      case "x":
        if (this.sessions.length > 0) {
          this.sessions[this.activeIndex].kill();
        }
        break;
      case "q":
        this.resolveRun?.(0);
        break;
      case "d":
      case "escape":
        if (this.sessions.length > 0) {
          this.focusSession(this.activeIndex);
        }
        break;
      case "n":
        if (this.sessions.length > 1) {
          this.activeIndex = (this.activeIndex + 1) % this.sessions.length;
          this.renderDashboard();
        }
        break;
      case "p":
        if (this.sessions.length > 1) {
          this.activeIndex =
            (this.activeIndex - 1 + this.sessions.length) % this.sessions.length;
          this.renderDashboard();
        }
        break;
    }
  }

  private showToolPicker(): void {
    const config = loadConfig();
    const tools = Object.entries(config.tools).filter(([, t]) => t.enabled);

    if (tools.length === 1) {
      // Only one tool — skip picker, spawn directly
      const [, tool] = tools[0];
      this.createSession(tool.command, tool.args);
      return;
    }

    this.pickerActive = true;

    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    const lines = ["Select tool:"];
    for (let i = 0; i < tools.length; i++) {
      lines.push(`  [${i + 1}] ${tools[i][0]}`);
    }
    lines.push("");
    lines.push("  [Esc] Cancel");

    const boxWidth = Math.max(...lines.map((l) => l.length)) + 4;
    const startRow = Math.floor((rows - lines.length - 2) / 2);
    const startCol = Math.floor((cols - boxWidth) / 2);

    let output = "\x1b7"; // save cursor
    for (let i = 0; i < lines.length + 2; i++) {
      const row = startRow + i;
      output += `\x1b[${row};${startCol}H`;
      if (i === 0 || i === lines.length + 1) {
        output += `\x1b[44;97m${"─".repeat(boxWidth)}\x1b[0m`;
      } else {
        const line = lines[i - 1];
        output += `\x1b[44;97m  ${line.padEnd(boxWidth - 2)}\x1b[0m`;
      }
    }
    output += "\x1b8"; // restore cursor
    process.stdout.write(output);
  }

  private handleToolPickerKey(data: Buffer): void {
    const events = parseKeys(data);
    if (events.length === 0) return;

    const event = events[0];
    const key = event.name || event.char;

    this.pickerActive = false;

    if (key === "escape") {
      if (this.mode === "dashboard") {
        this.renderDashboard();
      } else {
        this.focusSession(this.activeIndex);
      }
      return;
    }

    if (key >= "1" && key <= "9") {
      const config = loadConfig();
      const tools = Object.entries(config.tools).filter(([, t]) => t.enabled);
      const idx = parseInt(key) - 1;
      if (idx < tools.length) {
        const [, tool] = tools[idx];
        this.createSession(tool.command, tool.args);
        return;
      }
    }

    // Invalid key — redraw current view
    if (this.mode === "dashboard") {
      this.renderDashboard();
    } else {
      this.focusSession(this.activeIndex);
    }
  }

  private renderDashboard(): void {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    const dashSessions: DashboardSession[] = this.sessions.map((s, i) => ({
      index: i,
      id: s.id,
      command: s.command,
      status: s.status,
      active: i === this.activeIndex,
    }));

    this.dashboard.update(dashSessions);
    process.stdout.write(this.dashboard.render(cols, rows));
  }

  private setMode(mode: MuxMode): void {
    const prev = this.mode;
    this.mode = mode;

    if (mode === "dashboard" && prev !== "dashboard") {
      // Enter alternate screen buffer
      process.stdout.write("\x1b[?1049h");
      this.renderDashboard();
    } else if (mode === "focused" && prev === "dashboard") {
      // Leave alternate screen buffer
      process.stdout.write("\x1b[?1049l");
    }
  }

  private enterRawMode(): void {
    if (process.stdin.isTTY) {
      this.rawModeWas = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
  }

  private exitRawMode(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(this.rawModeWas ?? false);
      process.stdin.pause();
    }
  }

  private teardown(): void {
    if (this.onStdinData) {
      process.stdin.removeListener("data", this.onStdinData);
    }
    if (this.onResize) {
      process.stdout.removeListener("resize", this.onResize);
    }
    this.hotkeys.destroy();
    this.exitRawMode();
    // Ensure we leave alternate screen and restore cursor
    process.stdout.write("\x1b[?1049l\x1b[?25h");
  }

  cleanup(): void {
    for (const session of this.sessions) {
      session.destroy();
    }
    this.teardown();
  }
}
