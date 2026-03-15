import type { SessionStatus } from "./status-detector.js";

export interface DashboardSession {
  index: number;
  id: string;
  command: string;
  status: SessionStatus;
  active: boolean;
  worktreePath?: string;
  worktreeName?: string;
  worktreeBranch?: string;
}

export interface WorktreeGroup {
  name: string;
  branch: string;
  path: string;
  status: "active" | "offline";
  sessions: DashboardSession[];
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
  private worktreeGroups: WorktreeGroup[] = [];
  private hasWorktrees = false;

  update(sessions: DashboardSession[], worktreeGroups?: WorktreeGroup[]): void {
    this.sessions = sessions;
    this.worktreeGroups = worktreeGroups ?? [];
    this.hasWorktrees = this.worktreeGroups.length > 0 ||
      sessions.some(s => s.worktreePath);
  }

  render(cols: number, rows: number): string {
    const lines: string[] = [];

    // Title
    lines.push("");
    lines.push(center("\x1b[1maimux\x1b[0m — agent multiplexer", cols));
    lines.push(center("─".repeat(Math.min(50, cols - 4)), cols));
    lines.push("");

    if (this.sessions.length === 0 && this.worktreeGroups.length === 0) {
      lines.push(center("No sessions. Press [c] to create one.", cols));
    } else if (this.hasWorktrees) {
      // Group sessions by worktree
      this.renderWorktreeGrouped(lines);
    } else {
      // Simple flat list (no worktrees)
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
    const helpLine = this.buildHelpLine();
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

  private renderWorktreeGrouped(lines: string[]): void {
    // Sessions in the main repo (no worktreePath)
    const mainSessions = this.sessions.filter(s => !s.worktreePath);
    if (mainSessions.length > 0 || this.worktreeGroups.length > 0) {
      // Show main repo header
      lines.push(`  \x1b[1m(main)\x1b[0m — active`);
      if (mainSessions.length === 0) {
        lines.push("    (no agents)");
      } else {
        for (const session of mainSessions) {
          const num = session.index + 1;
          const icon = STATUS_ICONS[session.status];
          const label = STATUS_LABELS[session.status];
          const marker = session.active ? " \x1b[1m←\x1b[0m" : "";
          lines.push(`    ${icon} [${num}] ${session.command} — ${label}${marker}`);
        }
      }
      lines.push("");
    }

    // Group worktree sessions
    const wtSessionMap = new Map<string, DashboardSession[]>();
    for (const session of this.sessions) {
      if (!session.worktreePath) continue;
      const group = wtSessionMap.get(session.worktreePath) ?? [];
      group.push(session);
      wtSessionMap.set(session.worktreePath, group);
    }

    // Render worktree groups (from registry and active sessions)
    const renderedPaths = new Set<string>();
    for (const group of this.worktreeGroups) {
      const sessions = wtSessionMap.get(group.path) ?? [];
      const status = sessions.length > 0 ? "active" : group.status;
      lines.push(`  \x1b[1m${group.name}\x1b[0m (${group.branch}) — ${status}`);
      if (sessions.length === 0) {
        lines.push("    (no agents)");
      } else {
        for (const session of sessions) {
          const num = session.index + 1;
          const icon = STATUS_ICONS[session.status];
          const label = STATUS_LABELS[session.status];
          const marker = session.active ? " \x1b[1m←\x1b[0m" : "";
          lines.push(`    ${icon} [${num}] ${session.command} — ${label}${marker}`);
        }
      }
      lines.push("");
      renderedPaths.add(group.path);
    }

    // Render any worktree sessions not covered by groups
    for (const [path, sessions] of wtSessionMap) {
      if (renderedPaths.has(path)) continue;
      const name = sessions[0]?.worktreeName ?? path.split("/").pop() ?? "unknown";
      const branch = sessions[0]?.worktreeBranch ?? "unknown";
      lines.push(`  \x1b[1m${name}\x1b[0m (${branch}) — active`);
      for (const session of sessions) {
        const num = session.index + 1;
        const icon = STATUS_ICONS[session.status];
        const label = STATUS_LABELS[session.status];
        const marker = session.active ? " \x1b[1m←\x1b[0m" : "";
        lines.push(`    ${icon} [${num}] ${session.command} — ${label}${marker}`);
      }
      lines.push("");
    }
  }

  private buildHelpLine(): string {
    if (this.sessions.length === 0 && !this.hasWorktrees) {
      return " [c] new  [q] quit ";
    }
    if (this.hasWorktrees) {
      return " [1-9] focus  [c] new  [w] worktree  [m] migrate  [x] kill  [q] quit ";
    }
    return " [1-9] focus  [c] new  [w] worktree  [x] kill  [q] quit  [d/Esc] back ";
  }
}

function center(text: string, width: number): string {
  // Strip ANSI codes for length calculation
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, Math.floor((width - stripped.length) / 2));
  return " ".repeat(pad) + text;
}
