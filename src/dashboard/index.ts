import type { AgentActivityState, AgentAttentionState, AgentEvent } from "../agent-events.js";
import type { SessionServiceMetadata } from "../metadata-store.js";
import type { PendingDashboardActionKind, PendingWorktreeActionKind } from "../pending-actions.js";
import type { SessionPendingAction, SessionRawStatus, SessionSemanticState } from "../session-semantics.js";
import type { SessionTeamMetadata } from "../team.js";
import type { DashboardOperationFailure } from "./operation-failures.js";
import { sessionDisplayStatusLabel } from "../session-semantics.js";
import { renderDashboardFrame } from "../tui/screens/dashboard-renderers.js";

export type DashboardSessionStatus = SessionRawStatus;

export interface DashboardSession {
  index: number;
  id: string;
  command: string;
  tmuxWindowId?: string;
  tmuxWindowIndex?: number;
  lastUsedAt?: string;
  createdAt?: string;
  backendSessionId?: string;
  restoreState?: "ready" | "blocked";
  restoreBlockedReason?: string;
  team?: SessionTeamMetadata;
  status: DashboardSessionStatus;
  active: boolean;
  worktreePath?: string;
  worktreeName?: string;
  worktreeBranch?: string;
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
  notificationUnreadCount?: number;
  latestNotificationText?: string;
  semantic?: SessionSemanticState;
  pendingAction?: SessionPendingAction;
  pending?: boolean;
  optimistic?: boolean;
}

export interface DashboardService {
  id: string;
  command: string;
  args: string[];
  tmuxWindowId?: string;
  tmuxWindowIndex?: number;
  lastUsedAt?: string;
  createdAt?: string;
  worktreePath?: string;
  worktreeName?: string;
  worktreeBranch?: string;
  status: "running" | "exited" | "offline";
  active: boolean;
  label?: string;
  cwd?: string;
  foregroundCommand?: string;
  shellCommand?: string;
  shellCommandState?: "running" | "prompt";
  pid?: number;
  previewLine?: string;
  pendingAction?: PendingDashboardActionKind;
  pending?: boolean;
  optimistic?: boolean;
}

export type DashboardWorktreeEntry = { kind: "session"; id: string } | { kind: "service"; id: string };

export interface WorktreeGroup {
  name: string;
  branch: string;
  path?: string;
  createdAt?: string;
  status: "active" | "offline";
  pending?: boolean;
  removing?: boolean;
  pendingAction?: PendingWorktreeActionKind;
  operationFailure?: DashboardOperationFailure;
  optimistic?: boolean;
  sessions: DashboardSession[];
  services: DashboardService[];
}

export interface DashboardWorktreeRemovalInfo {
  path: string;
  name: string;
  startedAt: number;
  stderr?: string;
}

export interface MainCheckoutInfo {
  name: string;
  branch: string;
}

export interface DashboardViewModel {
  sessions: DashboardSession[];
  /** Overseer sessions, rendered on a dedicated line above the worktree groups. */
  overseerSessions: DashboardSession[];
  services: DashboardService[];
  worktreeGroups: WorktreeGroup[];
  hasWorktrees: boolean;
  focusedWorktreePath?: string;
  navLevel: "worktrees" | "sessions";
  selectedSessionId?: string;
  selectedServiceId?: string;
  selectedTeammates: DashboardSession[];
  runtimeLabel?: string;
  isDevRuntime?: boolean;
  mainCheckout: MainCheckoutInfo;
  worktreeRemoval?: DashboardWorktreeRemovalInfo;
  operationFailures: DashboardOperationFailure[];
  detailsPaneVisible: boolean;
  scrollOffset: number;
  derivedStatusLabel: typeof derivedStatusLabel;
}

export function derivedStatusLabel(session: DashboardSession): string {
  return sessionDisplayStatusLabel(session);
}

export class Dashboard {
  private viewModel: DashboardViewModel = {
    sessions: [],
    overseerSessions: [],
    services: [],
    worktreeGroups: [],
    hasWorktrees: false,
    focusedWorktreePath: undefined,
    navLevel: "sessions",
    selectedSessionId: undefined,
    selectedServiceId: undefined,
    selectedTeammates: [],
    runtimeLabel: undefined,
    isDevRuntime: false,
    mainCheckout: { name: "Main Checkout", branch: "" },
    worktreeRemoval: undefined,
    operationFailures: [],
    detailsPaneVisible: true,
    scrollOffset: 0,
    derivedStatusLabel,
  };
  private scrollOffset = 0;
  private detailsPaneVisible = true;

  update(viewModel: Omit<DashboardViewModel, "detailsPaneVisible" | "scrollOffset">): void {
    this.viewModel = {
      ...viewModel,
      detailsPaneVisible: this.detailsPaneVisible,
      scrollOffset: this.scrollOffset,
    };
  }

  /** Scroll the viewport (called from multiplexer key handler) */
  scroll(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
  }

  render(cols: number, rows: number): string {
    const { frame, scrollOffset } = renderDashboardFrame(this.viewModel, cols, rows);
    this.scrollOffset = scrollOffset;
    this.viewModel.scrollOffset = scrollOffset;
    return frame;
  }

  toggleDetailsPane(): void {
    this.detailsPaneVisible = !this.detailsPaneVisible;
    this.viewModel.detailsPaneVisible = this.detailsPaneVisible;
  }
}
