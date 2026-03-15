import type { SessionStatus } from "./status-detector.js";

export interface DashboardSession {
  index: number;
  id: string;
  command: string;
  status: SessionStatus;
  active: boolean;
}

const STATUS_ICONS: Record<SessionStatus, string> = {
  running: "\x1b[33m●\x1b[0m",  // yellow
  idle: "\x1b[32m●\x1b[0m",     // green
  waiting: "\x1b[36m◉\x1b[0m",  // cyan
  exited: "\x1b[31m○\x1b[0m",   // red
};

const STATUS_LABELS: Record<SessionStatus, string> = {
  running: "running",
  idle: "idle",
  waiting: "thinking",
  exited: "exited",
};

export class Dashboard {
  private sessions: DashboardSession[] = [];

  update(sessions: DashboardSession[]): void {
    this.sessions = sessions;
  }

  render(cols: number, rows: number): string {
    const lines: string[] = [];

    // Title
    lines.push("");
    lines.push(center("\x1b[1maimux\x1b[0m — agent multiplexer", cols));
    lines.push(center("─".repeat(Math.min(50, cols - 4)), cols));
    lines.push("");

    if (this.sessions.length === 0) {
      lines.push(center("No sessions. Press [c] to create one.", cols));
    } else {
      // Session list
      for (const session of this.sessions) {
        const num = session.index + 1;
        const icon = STATUS_ICONS[session.status];
        const label = STATUS_LABELS[session.status];
        const marker = session.active ? " \x1b[1m←\x1b[0m" : "";
        const line = `  ${icon} [${num}] ${session.command} — ${label}${marker}`;
        lines.push(line);
      }
    }

    // Fill remaining space
    const helpLine = " [1-9] focus  [c] new  [x] kill  [q] quit  [d/Esc] back ";
    const usedLines = lines.length + 2; // +2 for separator and help
    const remaining = Math.max(0, rows - usedLines);
    for (let i = 0; i < remaining; i++) {
      lines.push("");
    }

    // Bottom help bar
    lines.push(center("─".repeat(Math.min(cols - 4, helpLine.length + 4)), cols));
    lines.push(center(helpLine, cols));

    // Build full screen: clear + position cursor at top
    const screen = "\x1b[2J\x1b[H" + lines.join("\r\n");
    return screen;
  }
}

function center(text: string, width: number): string {
  // Strip ANSI codes for length calculation
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, Math.floor((width - stripped.length) / 2));
  return " ".repeat(pad) + text;
}
