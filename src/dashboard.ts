import type { SessionStatus } from "./status-detector.js";
import type { AgentActivityState, AgentAttentionState, AgentEvent } from "./agent-events.js";
import type { SessionServiceMetadata } from "./metadata-store.js";
import type { SessionSemanticState } from "./session-semantics.js";
import { sessionSemanticStatusLabel } from "./session-semantics.js";
import { renderDashboardFrame } from "./tui/screens/dashboard-renderers.js";

export type DashboardSessionStatus = SessionStatus;

export interface DashboardSession {
  index: number;
  id: string;
  command: string;
  tmuxWindowId?: string;
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
  foregroundCommand?: string;
  pid?: number;
  previewLine?: string;
  threadId?: string;
  threadName?: string;
  threadUnreadCount?: number;
  threadWaitingCount?: number;
  threadWaitingOnMeCount?: number;
  threadWaitingOnThemCount?: number;
  threadPendingCount?: number;
  workflowOnMeCount?: number;
  workflowBlockedCount?: number;
  workflowFamilyCount?: number;
  workflowTopLabel?: string;
  workflowNextAction?: string;
  semantic?: SessionSemanticState;
  pendingAction?: "starting" | "stopping" | "graveyarding";
  optimistic?: boolean;
}

export interface DashboardService {
  id: string;
  command: string;
  args: string[];
  tmuxWindowId?: string;
  worktreePath?: string;
  worktreeName?: string;
  worktreeBranch?: string;
  status: "running" | "exited";
  active: boolean;
  label?: string;
  cwd?: string;
  foregroundCommand?: string;
  pid?: number;
  previewLine?: string;
}

export type DashboardWorktreeEntry = { kind: "session"; id: string } | { kind: "service"; id: string };

export interface WorktreeGroup {
  name: string;
  branch: string;
  path: string;
  status: "active" | "offline";
  sessions: DashboardSession[];
  services: DashboardService[];
}

export interface MainCheckoutInfo {
  name: string;
  branch: string;
}

const STATUS_LABELS: Record<DashboardSessionStatus, string> = {
  running: "running",
  idle: "idle",
  waiting: "thinking",
  exited: "exited",
  offline: "offline",
};

export function derivedStatusLabel(session: DashboardSession): string {
  if (session.pendingAction === "starting") return "starting";
  if (session.pendingAction === "stopping") return "stopping";
  if (session.pendingAction === "graveyarding") return "graveyarding";
  if (session.semantic) {
    return sessionSemanticStatusLabel(session.semantic, session.status);
  }
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
  private services: DashboardService[] = [];
  private worktreeGroups: WorktreeGroup[] = [];
  private hasWorktrees = false;
  private focusedWorktreePath: string | undefined = undefined;
  private navLevel: "worktrees" | "sessions" = "sessions";
  private selectedSessionId: string | undefined = undefined;
  private selectedServiceId: string | undefined = undefined;
  private scrollOffset = 0;
  private runtimeLabel: string | undefined = undefined;
  private mainCheckout: MainCheckoutInfo = { name: "Main Checkout", branch: "" };
  private detailsPaneVisible = true;

  update(
    sessions: DashboardSession[],
    services: DashboardService[],
    worktreeGroups?: WorktreeGroup[],
    focusedWorktreePath?: string,
    navLevel?: "worktrees" | "sessions",
    selectedSessionId?: string,
    selectedServiceId?: string,
    runtimeLabel?: string,
    mainCheckout?: MainCheckoutInfo,
  ): void {
    this.sessions = sessions;
    this.services = services;
    this.worktreeGroups = worktreeGroups ?? [];
    this.hasWorktrees =
      this.worktreeGroups.length > 0 || sessions.some((s) => s.worktreePath) || services.some((s) => s.worktreePath);
    this.focusedWorktreePath = focusedWorktreePath;
    this.navLevel = navLevel ?? "sessions";
    this.selectedSessionId = selectedSessionId;
    this.selectedServiceId = selectedServiceId;
    this.runtimeLabel = runtimeLabel;
    this.mainCheckout = mainCheckout ?? { name: "Main Checkout", branch: "" };
  }

  /** Scroll the viewport (called from multiplexer key handler) */
  scroll(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
  }

  render(cols: number, rows: number): string {
    const { frame, scrollOffset } = renderDashboardFrame(
      {
        sessions: this.sessions,
        services: this.services,
        worktreeGroups: this.worktreeGroups,
        hasWorktrees: this.hasWorktrees,
        focusedWorktreePath: this.focusedWorktreePath,
        navLevel: this.navLevel,
        selectedSessionId: this.selectedSessionId,
        selectedServiceId: this.selectedServiceId,
        runtimeLabel: this.runtimeLabel,
        mainCheckout: this.mainCheckout,
        detailsPaneVisible: this.detailsPaneVisible,
        scrollOffset: this.scrollOffset,
        derivedStatusLabel,
      },
      cols,
      rows,
    );
    this.scrollOffset = scrollOffset;
    return frame;
  }

  toggleDetailsPane(): void {
    this.detailsPaneVisible = !this.detailsPaneVisible;
  }
}
