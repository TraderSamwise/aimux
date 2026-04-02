import type { AgentActivityState, AgentAttentionState } from "./agent-events.js";
import type { DashboardSessionStatus } from "./dashboard.js";

export type SessionAvailability = "available" | "busy" | "needs_input" | "blocked" | "offline";
export type SessionWorkflowState = "none" | "waiting_on_me" | "waiting_on_them" | "blocked";

export interface SessionSemanticState {
  activity?: AgentActivityState;
  attention: AgentAttentionState;
  availability: SessionAvailability;
  workflowState: SessionWorkflowState;
  unreadCount: number;
  pendingDeliveryCount: number;
  waitingOnMeCount: number;
  waitingOnThemCount: number;
  blockedCount: number;
  familyCount: number;
  hasActiveTask: boolean;
}

export interface DeriveSessionSemanticsInput {
  status: DashboardSessionStatus;
  activity?: AgentActivityState;
  attention?: AgentAttentionState;
  unseenCount?: number;
  threadUnreadCount?: number;
  threadPendingCount?: number;
  threadWaitingOnMeCount?: number;
  threadWaitingOnThemCount?: number;
  workflowOnMeCount?: number;
  workflowBlockedCount?: number;
  workflowFamilyCount?: number;
  hasActiveTask?: boolean;
}

export function deriveSessionSemantics(input: DeriveSessionSemanticsInput): SessionSemanticState {
  const attention = input.attention ?? "normal";
  const unreadCount = Math.max(0, input.unseenCount ?? 0, input.threadUnreadCount ?? 0);
  const pendingDeliveryCount = Math.max(0, input.threadPendingCount ?? 0);
  const waitingOnMeCount = Math.max(0, input.threadWaitingOnMeCount ?? 0, input.workflowOnMeCount ?? 0);
  const waitingOnThemCount = Math.max(0, input.threadWaitingOnThemCount ?? 0);
  const blockedCount = Math.max(0, input.workflowBlockedCount ?? 0);
  const familyCount = Math.max(0, input.workflowFamilyCount ?? 0);
  const hasActiveTask = Boolean(input.hasActiveTask);

  let workflowState: SessionWorkflowState = "none";
  if (blockedCount > 0 || attention === "blocked") {
    workflowState = "blocked";
  } else if (waitingOnMeCount > 0) {
    workflowState = "waiting_on_me";
  } else if (waitingOnThemCount > 0) {
    workflowState = "waiting_on_them";
  }

  let availability: SessionAvailability;
  if (input.status === "offline" || input.status === "exited") {
    availability = "offline";
  } else if (attention === "error" || attention === "blocked" || workflowState === "blocked") {
    availability = "blocked";
  } else if (attention === "needs_input" || workflowState === "waiting_on_me") {
    availability = "needs_input";
  } else if (
    input.status === "running" ||
    input.status === "waiting" ||
    input.activity === "running" ||
    input.activity === "waiting" ||
    hasActiveTask ||
    waitingOnThemCount > 0
  ) {
    availability = "busy";
  } else {
    availability = "available";
  }

  return {
    activity: input.activity,
    attention,
    availability,
    workflowState,
    unreadCount,
    pendingDeliveryCount,
    waitingOnMeCount,
    waitingOnThemCount,
    blockedCount,
    familyCount,
    hasActiveTask,
  };
}

export function sessionSemanticStatusLabel(
  semantic: SessionSemanticState,
  fallbackStatus: DashboardSessionStatus,
): string {
  if (semantic.attention === "error") return "error";
  if (semantic.workflowState === "blocked" || semantic.attention === "blocked") return "blocked";
  if (semantic.availability === "needs_input") return "needs input";
  if (semantic.activity === "done") return "done";
  if (semantic.activity === "waiting") return "waiting";
  if (semantic.activity === "running") return "working";
  if (semantic.activity === "interrupted") return "interrupted";
  if (semantic.availability === "busy") {
    if (fallbackStatus === "waiting") return "thinking";
    if (fallbackStatus === "running") return "working";
  }
  if (fallbackStatus === "waiting") return "thinking";
  return fallbackStatus;
}

export function sessionSemanticAttentionScore(semantic: SessionSemanticState): number {
  if (semantic.attention === "error") return 5;
  if (semantic.availability === "needs_input") return 4;
  if (semantic.workflowState === "blocked" || semantic.attention === "blocked") return 3;
  if (semantic.unreadCount > 0 || semantic.pendingDeliveryCount > 0) return 2;
  if (semantic.activity === "done") return 1;
  return 0;
}

export function sessionSemanticCompactHint(semantic: SessionSemanticState): string | null {
  if (semantic.attention === "error") return "error";
  if (semantic.workflowState === "blocked" || semantic.attention === "blocked") return "blocked";
  if (semantic.workflowState === "waiting_on_me" || semantic.availability === "needs_input") return "on you";
  if (semantic.workflowState === "waiting_on_them") return "on them";
  if (semantic.unreadCount > 0) return `${Math.min(semantic.unreadCount, 99)} unread`;
  if (semantic.pendingDeliveryCount > 0) return `${Math.min(semantic.pendingDeliveryCount, 99)} pending`;
  if (semantic.hasActiveTask && semantic.availability === "available") return "task";
  return null;
}
