export const PROJECT_API_ROUTES = {
  events: "/events",
  health: "/health",
  state: "/state",
  desktopState: "/desktop-state",
  coordinationWorklist: "/coordination-worklist",
  projectObservability: "/project-observability",
  topology: "/topology",
  library: "/library",
  inbox: "/inbox",
  workflow: "/workflow",
  worktrees: "/worktrees",
  graveyard: "/graveyard",
  plans: "/plans",
  statuslineRefresh: "/statusline/refresh",
  operationFailuresClear: "/operation-failures/clear",
  notifications: {
    list: "/notifications",
    read: "/notifications/read",
    clear: "/notifications/clear",
  },
  agents: {
    list: "/agents",
    output: "/agents/output",
    outputStream: "/agents/output/stream",
    history: "/agents/history",
    input: "/agents/input",
    spawn: "/agents/spawn",
    fork: "/agents/fork",
    stop: "/agents/stop",
    resume: "/agents/resume",
    kill: "/agents/kill",
    interrupt: "/agents/interrupt",
    rename: "/agents/rename",
    migrate: "/agents/migrate",
    recordBackendSession: "/agents/record-backend-session",
    loop: "/agents/loop",
    overseer: "/agents/overseer",
    teammates: "/agents/teammates",
    createTeammate: "/agents/teammates/create",
    createTeammateTask: "/agents/teammates/tasks",
    rawTeammateSend: "/agents/teammates/send",
    stopTeammate: "/agents/teammates/stop",
    resumeTeammate: "/agents/teammates/resume",
    killTeammate: "/agents/teammates/kill",
    resurrectTeammate: "/agents/teammates/resurrect",
    interactionRegister: "/agents/interaction/register",
    interactionNotify: "/agents/interaction/notify",
    interactionRequest: "/agents/interaction/request",
    interactionWait: "/agents/interaction/wait",
    interactionRespond: "/agents/interaction/respond",
    interactionPending: "/agents/interaction/pending",
    interactionStream: "/agents/interaction/stream",
  },
  services: {
    create: "/services/create",
    stop: "/services/stop",
    resume: "/services/resume",
    remove: "/services/remove",
  },
  worktreeActions: {
    create: "/worktrees/create",
    remove: "/worktrees/remove",
    graveyard: "/worktrees/graveyard",
  },
  graveyardActions: {
    resurrectAgent: "/graveyard/resurrect",
    resurrectWorktree: "/graveyard/worktrees/resurrect",
    deleteWorktree: "/graveyard/worktrees/delete",
    cleanup: "/graveyard/cleanup",
  },
  threads: {
    list: "/threads",
    open: "/threads/open",
    send: "/threads/send",
    markSeen: "/threads/mark-seen",
    status: "/threads/status",
  },
  tasks: {
    list: "/tasks",
    assign: "/tasks/assign",
    accept: "/tasks/accept",
    block: "/tasks/block",
    complete: "/tasks/complete",
    reopen: "/tasks/reopen",
  },
  handoff: {
    send: "/handoff",
    accept: "/handoff/accept",
    complete: "/handoff/complete",
  },
  reviews: {
    approve: "/reviews/approve",
    requestChanges: "/reviews/request-changes",
  },
  attachments: "/attachments",
  controls: {
    switchableAgents: "/control/switchable-agents",
    openDashboard: "/control/open-dashboard",
    openInbox: "/control/open-inbox",
    openNotificationTarget: "/control/open-notification-target",
    focusWindow: "/control/focus-window",
    activeWindow: "/control/active-window",
    switchNext: "/control/switch-next",
    switchPrev: "/control/switch-prev",
    switchAttention: "/control/switch-attention",
  },
  runtime: {
    usageMark: "/usage/mark",
    setStatus: "/set-status",
    setProgress: "/set-progress",
    setContext: "/set-context",
    setServices: "/set-services",
    log: "/log",
    event: "/event",
    markSeen: "/mark-seen",
    setActivity: "/set-activity",
    setAttention: "/set-attention",
    clearLog: "/clear-log",
    notify: "/notify",
    notificationContext: "/notification-context",
    inboxRead: "/inbox/read",
    inboxClear: "/inbox/clear",
    shellState: "/shell-state",
  },
} as const;

export type ProjectApiRoute = `/${string}`;

export interface ProjectApiOk {
  ok: boolean;
}

export interface ProjectServiceInfoResponse extends ProjectApiOk {
  serviceInfo?: unknown;
}

export interface NotificationMutationInput {
  id?: string;
  sessionId?: string;
}

export interface NotificationReadResponse extends ProjectApiOk {
  updated: number;
}

export interface NotificationClearResponse extends ProjectApiOk {
  cleared: number;
}

export interface CreateServiceInput {
  command?: string;
  worktreePath?: string;
  serviceId?: string;
}

export interface ServiceActionInput {
  serviceId: string;
}

export interface CreateServiceResponse extends ProjectApiOk {
  serviceId: string;
}

export interface StopServiceResponse extends ProjectApiOk {
  serviceId: string;
  status: "stopped";
}

export interface ResumeServiceResponse extends ProjectApiOk {
  serviceId: string;
  status: "running";
}

export interface RemoveServiceResponse extends ProjectApiOk {
  serviceId: string;
  status: "removed";
}

export interface CreateWorktreeInput {
  name: string;
}

export interface WorktreePathInput {
  path: string;
}

export interface WorktreePathResponse extends ProjectApiOk {
  path: string;
}

export interface GraveyardWorktreeResponse extends WorktreePathResponse {
  status: "graveyarded";
}

export interface ResurrectWorktreeResponse extends WorktreePathResponse {
  status: "active";
}

export interface DeleteWorktreeResponse extends WorktreePathResponse {
  status: "removed";
}

export interface AgentSessionInput {
  sessionId: string;
}

export interface StopAgentResponse extends ProjectApiOk {
  sessionId: string;
  status: "offline";
}

export interface ResumeAgentResponse extends ProjectApiOk {
  sessionId: string;
  status: "running" | "offline";
  warning?: string;
  teammateFailures?: Array<{ sessionId?: string; error?: string; message?: string }>;
}

export interface KillAgentResponse extends ProjectApiOk {
  sessionId: string;
  status: "graveyarded";
}

export interface ResurrectAgentResponse extends ProjectApiOk {
  sessionId: string;
  status: "offline";
}

export interface OperationFailuresClearInput {
  targetKind?: "worktree" | "agent" | "service" | "dashboard";
  operation?: string;
  targetId?: string;
  worktreePath?: string;
}

export interface OperationFailuresClearResponse extends ProjectApiOk {
  cleared: number;
}
