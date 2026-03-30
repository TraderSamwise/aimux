import type { SessionStatus } from "./status-detector.js";
import type { AgentActivityState, AgentAttentionState, AgentEvent } from "./agent-events.js";
import type { SessionServiceMetadata } from "./metadata-store.js";

export type DashboardSessionStatus = SessionStatus;

export interface DashboardSession {
  index: number;
  id: string;
  command: string;
  backendSessionId?: string;
  status: DashboardSessionStatus;
  active: boolean;
  worktreePath?: string;
  worktreeName?: string;
  worktreeBranch?: string;
  /** If set, this session belongs to another aimux instance */
  remoteInstancePid?: number;
  remoteInstanceId?: string;
  remoteBackendSessionId?: string;
  /** Active task description assigned to this session */
  taskDescription?: string;
  /** Auto-derived or user-set label for offline agents */
  label?: string;
  /** Short current-work summary */
  headline?: string;
  /** Whether this session is owned by the headless server */
  isServer?: boolean;
  /** Agent's team role (e.g. "coder", "reviewer") */
  role?: string;
  cwd?: string;
  repoOwner?: string;
  repoName?: string;
  repoRemote?: string;
  prNumber?: number;
  prTitle?: string;
  prUrl?: string;
  activity?: AgentActivityState;
  attention?: AgentAttentionState;
  unseenCount?: number;
  lastEvent?: AgentEvent;
  services?: SessionServiceMetadata[];
  threadId?: string;
  threadName?: string;
}

export interface WorktreeGroup {
  name: string;
  branch: string;
  path: string;
  status: "active" | "offline";
  sessions: DashboardSession[];
}

export interface MainCheckoutInfo {
  name: string;
  branch: string;
}

const STATUS_ICONS: Record<DashboardSessionStatus, string> = {
  running: "\x1b[33m●\x1b[0m", // yellow
  idle: "\x1b[32m●\x1b[0m", // green
  waiting: "\x1b[36m◉\x1b[0m", // cyan
  exited: "\x1b[31m○\x1b[0m", // red
  offline: "\x1b[2m○\x1b[0m", // dim
};

const STATUS_LABELS: Record<DashboardSessionStatus, string> = {
  running: "running",
  idle: "idle",
  waiting: "thinking",
  exited: "exited",
  offline: "offline",
};

function derivedStatusLabel(session: DashboardSession): string {
  if (session.attention === "error") return "error";
  if (session.attention === "needs_input") return "needs input";
  if (session.attention === "blocked") return "blocked";
  if (session.activity === "done") return "done";
  if (session.activity === "waiting") return "waiting";
  if (session.activity === "running") return "working";
  if (session.activity === "interrupted") return "interrupted";
  if (session.activity === "error") return "error";
  return STATUS_LABELS[session.status];
}

export class Dashboard {
  private sessions: DashboardSession[] = [];
  private worktreeGroups: WorktreeGroup[] = [];
  private hasWorktrees = false;
  private focusedWorktreePath: string | undefined = undefined;
  private navLevel: "worktrees" | "sessions" = "sessions";
  private selectedSessionId: string | undefined = undefined;
  private scrollOffset = 0;
  private serverRunning = false;
  private runtimeLabel: string | undefined = undefined;
  private mainCheckout: MainCheckoutInfo = { name: "Main Checkout", branch: "" };
  private renderSessionCounter = 0;
  private detailsPaneVisible = true;

  update(
    sessions: DashboardSession[],
    worktreeGroups?: WorktreeGroup[],
    focusedWorktreePath?: string,
    navLevel?: "worktrees" | "sessions",
    selectedSessionId?: string,
    serverRunning?: boolean,
    runtimeLabel?: string,
    mainCheckout?: MainCheckoutInfo,
  ): void {
    this.sessions = sessions;
    this.worktreeGroups = worktreeGroups ?? [];
    this.hasWorktrees = this.worktreeGroups.length > 0 || sessions.some((s) => s.worktreePath);
    this.focusedWorktreePath = focusedWorktreePath;
    this.navLevel = navLevel ?? "sessions";
    this.selectedSessionId = selectedSessionId;
    this.serverRunning = serverRunning ?? false;
    this.runtimeLabel = runtimeLabel;
    this.mainCheckout = mainCheckout ?? { name: "Main Checkout", branch: "" };
  }

  /** Scroll the viewport (called from multiplexer key handler) */
  scroll(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
  }

  render(cols: number, rows: number): string {
    this.renderSessionCounter = 0;

    // Header (fixed)
    const header: string[] = [];
    header.push("");
    const runtimeTag = this.runtimeLabel
      ? `  \x1b[32m● ${this.runtimeLabel}\x1b[0m`
      : this.serverRunning
        ? "  \x1b[32m● server\x1b[0m"
        : "";
    header.push(center(`\x1b[1maimux\x1b[0m — agent multiplexer${runtimeTag}`, cols));
    header.push(center("─".repeat(Math.min(50, cols - 4)), cols));
    header.push("");

    // Content (scrollable)
    const content: string[] = [];
    if (this.sessions.length === 0 && this.worktreeGroups.length === 0) {
      content.push(center("No sessions. Press [c] to create one.", cols));
    } else if (this.hasWorktrees) {
      this.renderWorktreeGrouped(content);
    } else {
      for (const session of this.sessions) {
        content.push(this.renderSession(session, "  "));
      }
    }

    // Footer (fixed)
    const helpLine = this.buildHelpLine();
    const footer: string[] = [];
    footer.push(center("─".repeat(Math.min(cols - 4, helpLine.length + 4)), cols));
    footer.push(center(helpLine, cols));

    // Viewport: how many content lines fit between header and footer
    const viewportHeight = rows - header.length - footer.length;
    const twoPane = cols >= 110 && this.detailsPaneVisible;

    // Auto-scroll to keep focused worktree or selected session visible
    const focusLine = this.findFocusLine(content);
    const maxScroll = Math.max(0, content.length - viewportHeight);
    if (focusLine >= 0) {
      if (focusLine < this.scrollOffset + 1) {
        this.scrollOffset = Math.max(0, focusLine - 1);
      } else if (focusLine >= this.scrollOffset + viewportHeight - 1) {
        this.scrollOffset = Math.min(maxScroll, focusLine - viewportHeight + 2);
      }
    }
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

    // Slice visible content
    const visibleContent = content.slice(this.scrollOffset, this.scrollOffset + viewportHeight);

    // Scroll indicators
    const canScrollUp = this.scrollOffset > 0;
    const canScrollDown = this.scrollOffset < maxScroll;
    if (canScrollUp) {
      visibleContent[0] = center("\x1b[2m▲ more ▲\x1b[0m", cols);
    }
    if (canScrollDown && visibleContent.length > 0) {
      visibleContent[visibleContent.length - 1] = center("\x1b[2m▼ more ▼\x1b[0m", cols);
    }

    // Pad if content is shorter than viewport
    while (visibleContent.length < viewportHeight) {
      visibleContent.push("");
    }

    let bodyLines = visibleContent;
    if (twoPane) {
      const rightPanel = this.renderSelectedDetailsPanel(
        Math.max(28, cols - Math.floor(cols * 0.56) - 3),
        viewportHeight,
      );
      bodyLines = composeTwoPane(visibleContent, rightPanel, cols);
    }

    const lines = [...header, ...bodyLines, ...footer];
    return "\x1b[2J\x1b[H" + lines.join("\r\n");
  }

  private renderSession(session: DashboardSession, indent: string): string {
    const num = ++this.renderSessionCounter;
    const isSelected = this.navLevel === "sessions" && session.id === this.selectedSessionId;
    const marker = isSelected ? " \x1b[33m◀\x1b[0m" : "";
    const taskBadge = session.taskDescription ? ` \x1b[2;35m⧫ ${truncate(session.taskDescription, 40)}\x1b[0m` : "";
    const attentionBadge =
      session.attention === "error"
        ? " \x1b[31m✗\x1b[0m"
        : session.attention === "needs_input"
          ? " \x1b[33m?\x1b[0m"
          : session.attention === "blocked"
            ? " \x1b[35m!\x1b[0m"
            : "";
    const unseenBadge = session.unseenCount && session.unseenCount > 0 ? ` \x1b[36m${session.unseenCount}\x1b[0m` : "";

    if (session.remoteInstancePid || session.isServer) {
      // Remote session — different icon and dimmed ownership label
      const icon = "\x1b[2;36m◈\x1b[0m"; // dim cyan diamond
      const ownerTag = session.isServer
        ? "\x1b[2;32m[server]\x1b[0m"
        : `\x1b[2mother tab (PID ${session.remoteInstancePid})\x1b[0m`;
      const identity = session.label ?? session.command;
      const headlineText = session.headline ? ` \x1b[2m· ${truncate(session.headline, 40)}\x1b[0m` : "";
      const remoteRoleTag = session.role ? ` \x1b[2;36m(${session.role})\x1b[0m` : "";
      return `${indent}${icon} [${num}] ${identity}${remoteRoleTag}${headlineText}${attentionBadge}${unseenBadge} — ${ownerTag}${marker}`;
    }

    const icon = STATUS_ICONS[session.status];
    const statusLabel = derivedStatusLabel(session);
    const roleTag = session.role ? ` \x1b[36m(${session.role})\x1b[0m` : "";
    const serverTag = session.isServer && !session.remoteInstancePid ? " \x1b[32m⬡\x1b[0m" : "";
    const identity = session.label ?? session.command;
    const headlineText = session.headline ? ` \x1b[2m· ${truncate(session.headline, 50)}\x1b[0m` : "";
    return `${indent}${icon} [${num}] ${identity}${roleTag}${serverTag} — ${statusLabel}${headlineText}${taskBadge}${attentionBadge}${unseenBadge}${marker}`;
  }

  private renderWorktreeGrouped(lines: string[]): void {
    const isFocused = (wtPath: string | undefined) => wtPath === this.focusedWorktreePath;
    const wtCursor = "\x1b[33m▸\x1b[0m";

    // Build session map by worktree path
    const wtSessionMap = new Map<string, DashboardSession[]>();
    const mainSessions: DashboardSession[] = [];
    for (const session of this.sessions) {
      if (!session.worktreePath) {
        mainSessions.push(session);
      } else {
        const group = wtSessionMap.get(session.worktreePath) ?? [];
        group.push(session);
        wtSessionMap.set(session.worktreePath, group);
      }
    }

    // Main repo
    const focused = isFocused(undefined);
    const prefix = focused && this.navLevel === "worktrees" ? ` ${wtCursor}` : "  ";
    const highlight = focused ? "\x1b[1;33m" : "\x1b[1m";
    const mainBranch = this.mainCheckout.branch ? ` \x1b[2m${this.mainCheckout.branch}\x1b[0m` : "";
    const mainLabel = `${this.mainCheckout.name}${mainBranch}`;
    if (mainSessions.length > 0) {
      lines.push(`${prefix} ${highlight}${mainLabel}\x1b[0m`);
      for (const session of mainSessions) {
        lines.push(this.renderSession(session, "    "));
      }
      lines.push("");
    } else {
      lines.push(`${prefix} ${highlight}${mainLabel}\x1b[0m`);
    }

    // Worktree groups — compact for empty, expanded for active
    const renderedPaths = new Set<string>();
    for (const group of this.worktreeGroups) {
      const sessions = wtSessionMap.get(group.path) ?? [];
      const gFocused = isFocused(group.path);
      const gPrefix = gFocused && this.navLevel === "worktrees" ? ` ${wtCursor}` : "  ";
      const gHighlight = gFocused ? "\x1b[1;33m" : "";
      const gReset = gFocused ? "\x1b[0m" : "";

      if (sessions.length > 0) {
        // Expanded: show worktree header + agents
        lines.push(`${gPrefix} ${gHighlight}\x1b[1m${group.name}\x1b[0m${gReset} \x1b[2m${group.branch}\x1b[0m`);
        for (const session of sessions) {
          lines.push(this.renderSession(session, "    "));
        }
        lines.push("");
      } else {
        // Compact: single dim line
        lines.push(`${gPrefix} \x1b[2m${gHighlight}${group.name}\x1b[0m \x1b[2m${group.branch}\x1b[0m`);
      }
      renderedPaths.add(group.path);
    }

    // Any orphan worktree sessions not covered by groups
    for (const [, sessions] of wtSessionMap) {
      if (sessions[0]?.worktreePath && renderedPaths.has(sessions[0].worktreePath)) continue;
      const name = sessions[0]?.worktreeName ?? "unknown";
      const branch = sessions[0]?.worktreeBranch ?? "unknown";
      lines.push(`  \x1b[1m${name}\x1b[0m \x1b[2m${branch}\x1b[0m`);
      for (const session of sessions) {
        lines.push(this.renderSession(session, "    "));
      }
      lines.push("");
    }
  }

  /** Find which content line has the cursor/focus indicator for auto-scroll */
  private findFocusLine(content: string[]): number {
    // Look for the selected session marker (◀) or worktree cursor (▸)
    for (let i = 0; i < content.length; i++) {
      const stripped = content[i].replace(/\x1b\[[0-9;]*m/g, "");
      if (stripped.includes("◀") || stripped.includes("▸")) {
        return i;
      }
    }
    return -1;
  }

  private buildHelpLine(): string {
    // Context-aware [x] label based on selected session
    const selected = this.selectedSessionId ? this.sessions.find((s) => s.id === this.selectedSessionId) : undefined;
    const xLabel =
      selected?.status === "offline" ? "[x] kill" : selected?.remoteInstancePid ? "" : selected ? "[x] stop" : "";
    const rLabel = selected && !selected.remoteInstancePid ? "  [r] name" : "";

    // Context-aware Enter label
    const enterLabel = selected?.remoteInstancePid
      ? "Enter takeover"
      : selected?.status === "offline"
        ? "Enter resume"
        : "Enter focus";

    const tmuxHint = this.runtimeLabel === "tmux" ? "  [d] tmux dashboard" : "";

    if (this.sessions.length === 0 && !this.hasWorktrees) {
      return " [Tab] details  [c] new  [p] plans  [a] all projects  [g] graveyard  [?] help  [q] quit ";
    }
    if (this.hasWorktrees && this.navLevel === "sessions") {
      const xPart = xLabel ? `  ${xLabel}` : "";
      return ` ↑↓ agents  ${enterLabel}  Esc back  [Tab] details  [c] new  [m] migrate${xPart}${rLabel}${tmuxHint}  [p] plans  [g] graveyard  [?] help  [q] quit `;
    }
    if (this.hasWorktrees) {
      return ` ↑↓ worktrees  Enter step in  [Tab] details  [c] new  [w] worktree  [m] migrate${tmuxHint}  [p] plans  [g] graveyard  [?] help  [q] quit `;
    }
    if (this.sessions.length > 0) {
      const xPart = xLabel ? `  ${xLabel}` : "";
      return ` ↑↓ select  ${enterLabel}  [Tab] details  [c] new  [w] worktree${xPart}${rLabel}${tmuxHint}  [p] plans  [a] all  [g] graveyard  [?] help  [q] quit `;
    }
    return " [Tab] details  [c] new  [w] worktree  [p] plans  [a] all projects  [g] graveyard  [?] help  [q] quit ";
  }

  toggleDetailsPane(): void {
    this.detailsPaneVisible = !this.detailsPaneVisible;
  }

  private renderSelectedDetailsPanel(width: number, height: number): string[] {
    const selected = this.selectedSessionId
      ? this.sessions.find((session) => session.id === this.selectedSessionId)
      : undefined;
    if (!selected) return new Array(height).fill("");

    const lines: string[] = [];
    lines.push("\x1b[1mDetails\x1b[0m");
    lines.push(...wrapKeyValue("Agent", `${selected.label ?? selected.command} (${selected.id})`, width));
    lines.push(...wrapKeyValue("Tool", selected.command, width));
    if (selected.worktreeName || selected.worktreeBranch) {
      lines.push(
        ...wrapKeyValue(
          "Worktree",
          `${selected.worktreeName ?? "main"}${selected.worktreeBranch ? ` · ${selected.worktreeBranch}` : ""}`,
          width,
        ),
      );
    }
    if (selected.cwd) {
      lines.push(...wrapKeyValue("CWD", selected.cwd, width));
    }
    if (selected.prNumber || selected.prTitle || selected.prUrl) {
      const prHeader = [`PR${selected.prNumber ? ` #${selected.prNumber}` : ""}`];
      if (selected.prTitle) prHeader.push(selected.prTitle);
      lines.push(...wrapKeyValue("PR", prHeader.join(": "), width));
      if (selected.prUrl) lines.push(...wrapKeyValue("URL", selected.prUrl, width));
    }
    if (selected.repoOwner || selected.repoName) {
      lines.push(...wrapKeyValue("Repo", `${selected.repoOwner ?? "?"}/${selected.repoName ?? "?"}`, width));
    }
    if (selected.repoRemote) {
      lines.push(...wrapKeyValue("Remote", selected.repoRemote, width));
    }
    if (selected.activity) {
      lines.push(...wrapKeyValue("Activity", selected.activity, width));
    }
    if (selected.attention && selected.attention !== "normal") {
      lines.push(...wrapKeyValue("Attention", selected.attention, width));
    }
    if (selected.unseenCount && selected.unseenCount > 0) {
      lines.push(...wrapKeyValue("Unseen", String(selected.unseenCount), width));
    }
    if (selected.lastEvent?.message) {
      lines.push(...wrapKeyValue("Last", selected.lastEvent.message, width));
    }
    if (selected.threadName || selected.threadId) {
      lines.push(...wrapKeyValue("Thread", selected.threadName ?? selected.threadId ?? "", width));
    }
    if ((selected.services?.length ?? 0) > 0) {
      lines.push(...wrapKeyValue("Services", selected.services!.map((s) => s.url ?? `:${s.port}`).join(", "), width));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }
}

function center(text: string, width: number): string {
  // Strip ANSI codes for length calculation
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, Math.floor((width - stripped.length) / 2));
  return " ".repeat(pad) + text;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

function truncateAnsi(text: string, max: number): string {
  if (max <= 0) return "";
  const plainLength = stripAnsi(text).length;
  const needsEllipsis = plainLength > max;
  const limit = needsEllipsis && max > 1 ? max - 1 : max;
  let visible = 0;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\x1b") {
      const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        out += match[0];
        i += match[0].length - 1;
        continue;
      }
    }
    if (visible >= limit) break;
    out += text[i];
    visible += 1;
  }
  if (needsEllipsis) out += "…";
  if (out.includes("\x1b[")) out += "\x1b[0m";
  return out;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function wrapText(text: string, width: number): string[] {
  const plain = text.trim();
  if (!plain) return [""];
  if (width <= 8) return [truncate(plain, width)];
  const words = plain.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word.length > width ? truncate(word, width) : word;
  }
  if (current) lines.push(current);
  return lines;
}

function wrapKeyValue(key: string, value: string, width: number): string[] {
  const prefix = `${key}: `;
  const wrapped = wrapText(value, Math.max(8, width - prefix.length));
  return wrapped.map((line, idx) => (idx === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`));
}

function composeTwoPane(left: string[], right: string[], cols: number): string[] {
  const leftWidth = Math.max(40, Math.floor(cols * 0.56));
  const rightWidth = Math.max(24, cols - leftWidth - 4);
  const height = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    const leftLine = truncateAnsi(left[i] ?? "", leftWidth);
    const rightLine = truncateAnsi(right[i] ?? "", rightWidth);
    const leftPad = Math.max(0, leftWidth - stripAnsi(leftLine).length);
    out.push(`${leftLine}${" ".repeat(leftPad)} │ ${rightLine}`);
  }
  return out;
}
