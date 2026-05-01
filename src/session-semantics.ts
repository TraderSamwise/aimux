import type { AgentActivityState, AgentAttentionState } from "./agent-events.js";
import type { DashboardSessionStatus } from "./dashboard/index.js";
import type { NotificationRecord } from "./notifications.js";

export type SessionLifecycleState =
  | "creating"
  | "starting"
  | "running"
  | "idle"
  | "offline"
  | "stopping"
  | "graveyarding"
  | "error";
export type SessionUserLabel =
  | "working"
  | "needs_input"
  | "blocked"
  | "error"
  | "idle"
  | "offline"
  | "starting"
  | "stopping"
  | "graveyarding"
  | "done"
  | "interrupted";
export type SessionUserAttention = "none" | "needs_input" | "blocked" | "error";
export type SessionWorkflowPressure = "none" | "pending" | "waiting_on_user" | "waiting_on_them" | "blocked";

export interface SessionRuntimeState {
  lifecycle: SessionLifecycleState;
  isAlive: boolean;
  canEnter: boolean;
  canReceiveInput: boolean;
  canInterrupt: boolean;
}

export interface SessionUserState {
  label: SessionUserLabel;
  attention: SessionUserAttention;
  source: "runtime" | "tool" | "notification";
  reason?: string;
}

export interface SessionNotificationState {
  unreadCount: number;
  latestUnread?: NotificationRecord;
  latestText?: string;
}

export interface SessionOrchestrationState {
  pressure: SessionWorkflowPressure;
  assignedTask: boolean;
  canBeAssignedWork: boolean;
}

export interface SessionPresentationState {
  statusLabel: string;
  compactHint: string | null;
  attentionScore: number;
}

export interface SessionSemanticState {
  runtime: SessionRuntimeState;
  user: SessionUserState;
  notifications: SessionNotificationState;
  orchestration: SessionOrchestrationState;
  presentation: SessionPresentationState;
  activity?: AgentActivityState;
  attention: AgentAttentionState;
  activityNewCount: number;
  threadUnreadCount: number;
  pendingDeliveryCount: number;
  waitingOnMeCount: number;
  waitingOnThemCount: number;
  blockedCount: number;
  familyCount: number;
}

export interface DeriveSessionSemanticsInput {
  status: DashboardSessionStatus;
  pendingAction?: "creating" | "forking" | "migrating" | "starting" | "stopping" | "graveyarding" | "renaming";
  activity?: AgentActivityState;
  attention?: AgentAttentionState;
  unseenCount?: number;
  notificationUnreadCount?: number;
  latestNotification?: NotificationRecord;
  threadUnreadCount?: number;
  threadPendingCount?: number;
  threadWaitingOnMeCount?: number;
  threadWaitingOnThemCount?: number;
  workflowOnMeCount?: number;
  workflowBlockedCount?: number;
  workflowFamilyCount?: number;
  hasActiveTask?: boolean;
}

function runtimeLifecycle(input: DeriveSessionSemanticsInput): SessionLifecycleState {
  if (input.pendingAction === "creating" || input.pendingAction === "forking" || input.pendingAction === "migrating") {
    return "creating";
  }
  if (input.pendingAction === "starting") return "starting";
  if (input.pendingAction === "stopping") return "stopping";
  if (input.pendingAction === "graveyarding") return "graveyarding";
  if (input.attention === "error" || input.activity === "error") return "error";
  if (input.status === "offline" || input.status === "exited") return "offline";
  if (
    input.status === "idle" ||
    input.activity === "idle" ||
    input.activity === "done" ||
    input.activity === "interrupted"
  ) {
    return "idle";
  }
  return "running";
}

function deriveWorkflowPressure(input: {
  pendingDeliveryCount: number;
  waitingOnMeCount: number;
  waitingOnThemCount: number;
  blockedCount: number;
}): SessionWorkflowPressure {
  if (input.blockedCount > 0) return "blocked";
  if (input.waitingOnMeCount > 0) return "waiting_on_user";
  if (input.pendingDeliveryCount > 0) return "pending";
  if (input.waitingOnThemCount > 0) return "waiting_on_them";
  return "none";
}

function statusLabelFor(label: SessionUserLabel): string {
  if (label === "needs_input") return "needs input";
  if (label === "working") return "working";
  return label;
}

export function deriveSessionSemantics(input: DeriveSessionSemanticsInput): SessionSemanticState {
  const attention = input.attention ?? "normal";
  const activityNewCount = Math.max(0, input.unseenCount ?? 0);
  const threadUnreadCount = Math.max(0, input.threadUnreadCount ?? 0);
  const pendingDeliveryCount = Math.max(0, input.threadPendingCount ?? 0);
  const waitingOnMeCount = Math.max(0, input.threadWaitingOnMeCount ?? 0, input.workflowOnMeCount ?? 0);
  const waitingOnThemCount = Math.max(0, input.threadWaitingOnThemCount ?? 0);
  const blockedCount = Math.max(0, input.workflowBlockedCount ?? 0);
  const familyCount = Math.max(0, input.workflowFamilyCount ?? 0);
  const hasActiveTask = Boolean(input.hasActiveTask);
  const lifecycle = runtimeLifecycle(input);
  const isAlive = lifecycle !== "offline" && lifecycle !== "stopping" && lifecycle !== "graveyarding";
  const canReceiveInput =
    isAlive &&
    lifecycle !== "creating" &&
    lifecycle !== "starting" &&
    lifecycle !== "error" &&
    attention !== "error" &&
    attention !== "blocked";
  const runtime: SessionRuntimeState = {
    lifecycle,
    isAlive,
    canEnter: lifecycle !== "creating" && lifecycle !== "stopping" && lifecycle !== "graveyarding",
    canReceiveInput,
    canInterrupt: isAlive && lifecycle !== "creating" && lifecycle !== "starting",
  };
  const notifications: SessionNotificationState = {
    unreadCount: Math.max(0, input.notificationUnreadCount ?? 0),
    latestUnread: input.latestNotification,
    latestText: input.latestNotification?.body || input.latestNotification?.title,
  };
  const pressure = deriveWorkflowPressure({
    pendingDeliveryCount,
    waitingOnMeCount,
    waitingOnThemCount,
    blockedCount,
  });
  let user: SessionUserState;
  if (lifecycle === "creating" || lifecycle === "starting") {
    user = { label: "starting", attention: "none", source: "runtime" };
  } else if (lifecycle === "stopping") {
    user = { label: "stopping", attention: "none", source: "runtime" };
  } else if (lifecycle === "graveyarding") {
    user = { label: "graveyarding", attention: "none", source: "runtime" };
  } else if (lifecycle === "offline") {
    user = { label: "offline", attention: "none", source: "runtime" };
  } else if (attention === "error" || input.activity === "error") {
    user = { label: "error", attention: "error", source: "tool" };
  } else if (attention === "blocked") {
    user = { label: "blocked", attention: "blocked", source: "tool" };
  } else if (attention === "needs_input") {
    user = { label: "needs_input", attention: "needs_input", source: "tool" };
  } else if (input.activity === "done") {
    user = { label: "done", attention: "none", source: "tool" };
  } else if (input.activity === "interrupted") {
    user = { label: "interrupted", attention: "none", source: "tool" };
  } else if (
    input.activity === "running" ||
    input.activity === "waiting" ||
    input.status === "running" ||
    input.status === "waiting"
  ) {
    user = {
      label: input.status === "waiting" || input.activity === "waiting" ? "working" : "working",
      attention: "none",
      source: "runtime",
    };
  } else {
    user = { label: "idle", attention: "none", source: "runtime" };
  }
  const orchestration: SessionOrchestrationState = {
    pressure,
    assignedTask: hasActiveTask,
    canBeAssignedWork: runtime.canReceiveInput && !hasActiveTask,
  };
  const compactHint = sessionSemanticCompactHintFromParts({
    user,
    notifications,
    threadUnreadCount,
    activityNewCount,
    pendingDeliveryCount,
    waitingOnMeCount,
    waitingOnThemCount,
    blockedCount,
    hasActiveTask,
  });
  const presentation: SessionPresentationState = {
    statusLabel: statusLabelFor(user.label),
    compactHint,
    attentionScore: sessionSemanticAttentionScoreFromParts({
      user,
      notifications,
      activityNewCount,
      pendingDeliveryCount,
    }),
  };

  return {
    runtime,
    user,
    notifications,
    orchestration,
    presentation,
    activity: input.activity,
    attention,
    activityNewCount,
    threadUnreadCount,
    pendingDeliveryCount,
    waitingOnMeCount,
    waitingOnThemCount,
    blockedCount,
    familyCount,
  };
}

function sessionSemanticAttentionScoreFromParts(input: {
  user: SessionUserState;
  notifications: SessionNotificationState;
  activityNewCount: number;
  pendingDeliveryCount: number;
}): number {
  if (input.user.attention === "error") return 5;
  if (input.user.attention === "needs_input") return 4;
  if (input.user.attention === "blocked") return 3;
  if (input.notifications.unreadCount > 0 || input.pendingDeliveryCount > 0) return 2;
  if (input.activityNewCount > 0 || input.user.label === "done") return 1;
  return 0;
}

function sessionSemanticCompactHintFromParts(input: {
  user: SessionUserState;
  notifications: SessionNotificationState;
  threadUnreadCount: number;
  activityNewCount: number;
  pendingDeliveryCount: number;
  waitingOnMeCount: number;
  waitingOnThemCount: number;
  blockedCount: number;
  hasActiveTask: boolean;
}): string | null {
  if (input.user.attention === "error") return "error";
  if (input.user.attention === "blocked") return "blocked";
  if (input.user.attention === "needs_input") return "on you";
  if (input.notifications.unreadCount > 0) return `${Math.min(input.notifications.unreadCount, 99)} unread`;
  if (input.waitingOnMeCount > 0) return "on you";
  if (input.blockedCount > 0) return "blocked task";
  if (input.waitingOnThemCount > 0) return "on them";
  if (input.threadUnreadCount > 0) return `${Math.min(input.threadUnreadCount, 99)} thread`;
  if (input.activityNewCount > 0) return `${Math.min(input.activityNewCount, 99)} new`;
  if (input.pendingDeliveryCount > 0) return `${Math.min(input.pendingDeliveryCount, 99)} pending`;
  if (input.hasActiveTask) return "task";
  return null;
}

export function sessionSemanticStatusLabel(
  semantic: SessionSemanticState,
  _fallbackStatus: DashboardSessionStatus,
): string {
  return semantic.presentation.statusLabel;
}

export function sessionSemanticAttentionScore(semantic: SessionSemanticState): number {
  return semantic.presentation.attentionScore;
}

export function sessionSemanticCompactHint(semantic: SessionSemanticState): string | null {
  return semantic.presentation.compactHint;
}
