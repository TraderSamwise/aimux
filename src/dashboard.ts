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
  /** If set, this session belongs to another aimux instance */
  remoteInstancePid?: number;
  remoteInstanceId?: string;
  remoteBackendSessionId?: string;
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
  offline: "\x1b[2m○\x1b[0m",   // dim
};

const STATUS_LABELS: Record<SessionStatus, string> = {
  running: "running",
  idle: "idle",
  waiting: "thinking",
  exited: "exited",
  offline: "offline",
};

export class Dashboard {
  private sessions: DashboardSession[] = [];
  private worktreeGroups: WorktreeGroup[] = [];
  private hasWorktrees = false;
  private focusedWorktreePath: string | undefined = undefined;
  private navLevel: "worktrees" | "sessions" = "sessions";
  private selectedSessionId: string | undefined = undefined;

  update(
    sessions: DashboardSession[],
    worktreeGroups?: WorktreeGroup[],
    focusedWorktreePath?: string,
    navLevel?: "worktrees" | "sessions",
    selectedSessionId?: string,
  ): void {
    this.sessions = sessions;
    this.worktreeGroups = worktreeGroups ?? [];
    this.hasWorktrees = this.worktreeGroups.length > 0 ||
      sessions.some(s => s.worktreePath);
    this.focusedWorktreePath = focusedWorktreePath;
    this.navLevel = navLevel ?? "sessions";
    this.selectedSessionId = selectedSessionId;
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
        lines.push(this.renderSession(session, "  "));
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

  private renderSession(session: DashboardSession, indent: string): string {
    const num = session.index + 1;
    const isSelected = this.navLevel === "sessions" && session.id === this.selectedSessionId;
    const marker = isSelected ? " \x1b[33m◀\x1b[0m" : "";

    if (session.remoteInstancePid) {
      // Remote session — different icon and dimmed label
      const icon = "\x1b[2;36m◈\x1b[0m";  // dim cyan diamond
      const label = `\x1b[2mother tab (PID ${session.remoteInstancePid})\x1b[0m`;
      return `${indent}${icon} [${num}] ${session.command} — ${label}${marker}`;
    }

    const icon = STATUS_ICONS[session.status];
    const label = STATUS_LABELS[session.status];
    return `${indent}${icon} [${num}] ${session.command} — ${label}${marker}`;
  }

  private renderWorktreeGrouped(lines: string[]): void {
    const isFocused = (wtPath: string | undefined) => wtPath === this.focusedWorktreePath;
    const wtCursor = "\x1b[33m▸\x1b[0m"; // yellow arrow for worktree level

    // Sessions in the main repo (no worktreePath)
    const mainSessions = this.sessions.filter(s => !s.worktreePath);
    if (mainSessions.length > 0 || this.worktreeGroups.length > 0) {
      const focused = isFocused(undefined);
      const prefix = focused && this.navLevel === "worktrees" ? ` ${wtCursor}` : "  ";
      const highlight = focused ? "\x1b[1;33m" : "\x1b[1m";
      lines.push(`${prefix} ${highlight}(main)\x1b[0m — active`);
      if (mainSessions.length === 0) {
        lines.push("    (no agents)");
      } else {
        for (const session of mainSessions) {
          lines.push(this.renderSession(session, "    "));
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
      const focused = isFocused(group.path);
      const prefix = focused && this.navLevel === "worktrees" ? ` ${wtCursor}` : "  ";
      const highlight = focused ? "\x1b[1;33m" : "\x1b[1m";
      lines.push(`${prefix} ${highlight}${group.name}\x1b[0m (${group.branch}) — ${status}`);
      if (sessions.length === 0) {
        lines.push("    (no agents)");
      } else {
        for (const session of sessions) {
          lines.push(this.renderSession(session, "    "));
        }
      }
      lines.push("");
      renderedPaths.add(group.path);
    }

    // Render any worktree sessions not covered by groups
    for (const [, sessions] of wtSessionMap) {
      if (sessions[0]?.worktreePath && renderedPaths.has(sessions[0].worktreePath)) continue;
      const name = sessions[0]?.worktreeName ?? "unknown";
      const branch = sessions[0]?.worktreeBranch ?? "unknown";
      lines.push(`  \x1b[1m${name}\x1b[0m (${branch}) — active`);
      for (const session of sessions) {
        lines.push(this.renderSession(session, "    "));
      }
      lines.push("");
    }
  }

  private buildHelpLine(): string {
    // Context-aware [x] label based on selected session
    const selected = this.selectedSessionId
      ? this.sessions.find(s => s.id === this.selectedSessionId)
      : undefined;
    const xLabel = selected?.status === "offline" ? "[x] kill"
      : selected?.remoteInstancePid ? ""
      : selected ? "[x] stop"
      : "";

    // Context-aware Enter label
    const enterLabel = selected?.remoteInstancePid ? "Enter takeover"
      : selected?.status === "offline" ? "Enter resume"
      : "Enter focus";

    if (this.sessions.length === 0 && !this.hasWorktrees) {
      return " [c] new  [g] graveyard  [q] quit ";
    }
    if (this.hasWorktrees && this.navLevel === "sessions") {
      const xPart = xLabel ? `  ${xLabel}` : "";
      return ` ↑↓ agents  ${enterLabel}  Esc back  [c] new  [m] migrate${xPart}  [g] graveyard  [q] quit `;
    }
    if (this.hasWorktrees) {
      return " ↑↓ worktrees  Enter step in  [c] new  [w] worktree  [m] migrate  [g] graveyard  [q] quit ";
    }
    if (this.sessions.length > 0) {
      const xPart = xLabel ? `  ${xLabel}` : "";
      return ` ↑↓ select  ${enterLabel}  [c] new  [w] worktree${xPart}  [g] graveyard  [q] quit `;
    }
    return " [c] new  [w] worktree  [g] graveyard  [q] quit ";
  }
}

function center(text: string, width: number): string {
  // Strip ANSI codes for length calculation
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, Math.floor((width - stripped.length) / 2));
  return " ".repeat(pad) + text;
}
