import { PtySession, type PtySessionOptions } from "./pty-session.js";
import { HotkeyHandler, type HotkeyAction } from "./hotkeys.js";
import { Dashboard, type DashboardSession } from "./dashboard.js";
import { captureGitContext } from "./context/context-bridge.js";

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

    // Clear screen and reset cursor
    process.stdout.write("\x1b[2J\x1b[H");

    // Trigger resize to make the tool redraw its TUI
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    this.sessions[index].resize(cols, rows);
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
        this.createSession(this.defaultCommand, this.defaultArgs);
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
    const key = data[0];

    // Digits 1-9: focus session
    if (key >= 0x31 && key <= 0x39) {
      const index = key - 0x31;
      if (index < this.sessions.length) {
        this.focusSession(index);
      }
      return;
    }

    switch (key) {
      case 0x63: // 'c' — create
        this.createSession(this.defaultCommand, this.defaultArgs);
        break;
      case 0x78: // 'x' — kill active session
        if (this.sessions.length > 0) {
          this.sessions[this.activeIndex].kill();
        }
        break;
      case 0x71: // 'q' — quit
        this.resolveRun?.(0);
        break;
      case 0x64: // 'd' — back to focused
      case 0x1b: // Escape — back to focused
        if (this.sessions.length > 0) {
          this.focusSession(this.activeIndex);
        }
        break;
      case 0x6e: // 'n' — next
        if (this.sessions.length > 1) {
          this.activeIndex = (this.activeIndex + 1) % this.sessions.length;
          this.renderDashboard();
        }
        break;
      case 0x70: // 'p' — prev
        if (this.sessions.length > 1) {
          this.activeIndex =
            (this.activeIndex - 1 + this.sessions.length) % this.sessions.length;
          this.renderDashboard();
        }
        break;
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
      // Redraw the focused session
      if (this.activeSession) {
        const cols = process.stdout.columns ?? 80;
        const rows = process.stdout.rows ?? 24;
        this.activeSession.resize(cols, rows);
      }
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
