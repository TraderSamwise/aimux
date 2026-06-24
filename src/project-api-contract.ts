export const PROJECT_API_ROUTES = {
  events: "/events",
  health: "/health",
  diagnostics: "/diagnostics",
  state: "/state",
  desktopState: "/desktop-state",
  coordinationWorklist: "/coordination-worklist",
  projectObservability: "/project-observability",
  topology: "/topology",
  library: "/library",
  inbox: "/inbox",
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
  livePane: {
    attach: "/live-pane/attach",
    output: "/live-pane/output",
    input: "/live-pane/input",
    interrupt: "/live-pane/interrupt",
    resize: "/live-pane/resize",
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
  orchestration: {
    routes: "/orchestration/routes",
  },
  attachments: "/attachments",
  controls: {
    switchableAgents: "/control/switchable-agents",
    openDashboard: "/control/open-dashboard",
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

export const PROJECT_API_EVENT_NAMES = {
  ready: "ready",
  alert: "alert",
  agentOutput: "agent_output",
  projectUpdate: "project_update",
  error: "error",
} as const;

export const PROJECT_API_VIEWS = [
  "agents",
  "coordination-worklist",
  "desktop-state",
  "graveyard",
  "inbox",
  "library",
  "notifications",
  "plans",
  "project-observability",
  "services",
  "tasks",
  "threads",
  "topology",
  "worktrees",
] as const;

export type ProjectApiEventName = (typeof PROJECT_API_EVENT_NAMES)[keyof typeof PROJECT_API_EVENT_NAMES];
export type ProjectApiView = (typeof PROJECT_API_VIEWS)[number];

export interface ProjectUpdateEvent {
  type: typeof PROJECT_API_EVENT_NAMES.projectUpdate;
  projectId: string;
  ts: string;
  views: ProjectApiView[];
  reason?: string;
  sessionId?: string;
  worktreePath?: string;
}

export interface ProjectApiOk {
  ok: boolean;
}

export interface LivePaneSessionInput {
  sessionId: string;
}

export interface LivePaneOutputInput extends LivePaneSessionInput {
  startLine?: number;
}

export interface LivePaneOutputResponse extends ProjectApiOk {
  sessionId: string;
  output: string;
  startLine?: number;
  parsed?: unknown;
}

export interface LivePaneInputRequest extends LivePaneSessionInput {
  text: string;
  attachmentIds?: string[];
}

export interface LivePaneInputResponse extends ProjectApiOk {
  sessionId: string;
  accepted: true;
}

export interface LivePaneInterruptResponse extends ProjectApiOk {
  sessionId: string;
}

export interface LivePaneResizeRequest extends LivePaneSessionInput {
  cols: number;
  rows: number;
}

export interface LivePaneResizeResponse extends ProjectApiOk {
  sessionId: string;
  cols: number;
  rows: number;
}

interface LivePaneAttachBaseRequest extends LivePaneSessionInput {
  startLine?: number;
}

export type LivePaneAttachRequest =
  | (LivePaneAttachBaseRequest & {
      cols?: never;
      rows?: never;
    })
  | (LivePaneAttachBaseRequest & {
      cols: number;
      rows: number;
    });

export interface LivePaneAttachResponse extends LivePaneOutputResponse {
  stream: {
    route: typeof PROJECT_API_ROUTES.events;
    sessionId: string;
    startLine: number;
  };
  resize?: {
    cols: number;
    rows: number;
  };
}

export interface ControlClientBaseContext {
  currentClientSession?: string;
  currentWindow?: string;
  currentWindowId?: string;
  currentPath?: string;
}

export type ControlClientContext =
  | (ControlClientBaseContext & {
      focus?: false;
      clientTty?: string;
    })
  | (ControlClientBaseContext & {
      focus: true;
      clientTty: string;
    });

export interface ControlTargetRef {
  sessionName: string;
  windowId: string;
  windowIndex: number;
  windowName: string;
}

export interface ControlActionResponse extends ProjectApiOk {
  action: string;
  focused: boolean;
  focusMode?: "client-tty" | "linked-client-session" | "open-target";
  target?: ControlTargetRef;
  itemId?: string;
}

export type DashboardControlScreen = "dashboard" | "coordination" | "project" | "library" | "topology" | "graveyard";

export type OpenDashboardRequest = ControlClientContext & {
  screen?: DashboardControlScreen;
};

export type OpenNotificationTargetRequest = ControlClientContext & {
  sessionId: string;
};

export type FocusWindowRequest = ControlClientContext & {
  windowId: string;
};

export interface ActiveWindowRequest {
  currentClientSession: string;
  currentWindow?: string;
  currentWindowId: string;
  clientTty: string;
}
export type SwitchAgentRequest = ControlClientContext;

export interface ProjectServiceInfoResponse extends ProjectApiOk {
  serviceInfo?: unknown;
}

export type NotificationInteractionType = "permission" | "exit_plan" | "question" | "input";

export interface NotificationInteractionRecord {
  id: string;
  type: NotificationInteractionType;
  summary?: string;
  telemetry?: boolean;
  toolName?: string;
  toolInputJSON?: string;
}

export interface NotificationRecord {
  id: string;
  title: string;
  subtitle?: string;
  body: string;
  sessionId?: string;
  targetKey?: string;
  targetKind?: "session" | "generic";
  kind?: string;
  projectName?: string;
  projectRoot?: string;
  worktreePath?: string;
  worktreeName?: string;
  branch?: string;
  categoryLabel?: string;
  reasonLabel?: string;
  unread: boolean;
  cleared: boolean;
  createdAt: string;
  updatedAt: string;
  dedupeKey?: string;
  interaction?: NotificationInteractionRecord;
}

export type LibraryEntryKind = "doc" | "plan";

export interface LibraryEntry {
  id: string;
  kind: LibraryEntryKind;
  title: string;
  path: string;
  updatedAt: string;
  sessionId?: string;
  label?: string;
  preview: string;
}

export type CoordinationReachability = "live" | "offline" | "missing" | "none";
export type CoordinationBucket = "awake" | "asleep" | "handled" | "unreachable";
export type CoordinationWorklistType = "msg" | "note" | "task" | "review" | "handoff" | "conversation";

export interface CoordinationWorklistItem {
  key: string;
  kind: "notification" | "thread";
  sessionId?: string;
  type: CoordinationWorklistType;
  bucket: CoordinationBucket;
  title: string;
  urgency: number;
  reachability: CoordinationReachability;
  actionable: boolean;
  stale: boolean;
  when?: string;
  notification?: Record<string, unknown>;
  thread?: Record<string, unknown>;
}

export interface CoordinationWorklistResponse extends ProjectApiOk {
  worklist: {
    items: CoordinationWorklistItem[];
    needsYou: CoordinationWorklistItem[];
    tail: CoordinationWorklistItem[];
  };
  model: {
    items: Array<Record<string, unknown>>;
    actionable: Array<Record<string, unknown>>;
    unreachable: Array<Record<string, unknown>>;
  };
  threads: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface ProjectObservabilityResponse extends ProjectApiOk {
  project: {
    summary: {
      agentsRunning: number;
      agentsWaiting: number;
      agentsOffline: number;
      services: number;
      worktrees: number;
      openTasks: number;
      doneTasks: number;
      unreadNotifications: number;
    };
    progress: {
      pending: number;
      assigned: number;
      in_progress: number;
      blocked: number;
      done: number;
      failed: number;
      total: number;
    };
    story: Array<{
      id: string;
      kind: "task" | "review" | "notification";
      title: string;
      meta: string;
      body?: string;
      createdAt: string;
      status?: string;
    }>;
  };
}

export interface ProjectTopologyResponse extends ProjectApiOk {
  topology: {
    projectName: string;
    health: "active" | "attention" | "idle" | "offline";
    counts: { worktrees: number; agents: number; services: number };
    worktrees: Array<{
      name: string;
      branch: string;
      path?: string;
      health: "active" | "attention" | "idle" | "offline";
      agents: number;
      services: number;
    }>;
    rows: Array<{
      kind: "worktree" | "agent" | "service";
      depth: number;
      label: string;
      detail?: string;
      health: "active" | "attention" | "idle" | "offline";
      status?: string;
      sessionId?: string;
      serviceId?: string;
      worktreePath?: string;
    }>;
  };
}

export interface LibraryDocument {
  id: string;
  title: string;
  path: string;
  kind: string;
  size: number;
  updatedAt: string;
  content: string;
  truncated?: boolean;
}

export interface LibraryResponse extends ProjectApiOk {
  documents: LibraryDocument[];
  entries: LibraryEntry[];
}

export type OrchestrationRouteMode = "message" | "handoff" | "task";

export interface OrchestrationRouteOption {
  label: string;
  sessionId?: string;
  assignee?: string;
  tool?: string;
  worktreePath?: string;
  recipientIds?: string[];
}

export interface OrchestrationRouteOptionsResponse extends ProjectApiOk {
  options: OrchestrationRouteOption[];
}

export interface NotificationMutationInput {
  id?: string;
  ids?: string[];
  sessionId?: string;
}

export interface NotificationsResponse extends ProjectApiOk {
  notifications: NotificationRecord[];
  unreadCount: number;
}

export interface NotificationReadResponse extends ProjectApiOk {
  updated: number;
}

export interface NotificationClearResponse extends ProjectApiOk {
  cleared: number;
}

export interface ThreadMarkSeenInput {
  threadId: string;
  session: string;
}

export interface ThreadMarkSeenResponse extends ProjectApiOk {
  thread?: unknown;
}

export type ProjectThreadKind = "conversation" | "task" | "review" | "handoff" | "user";
export type ProjectThreadStatus = "open" | "waiting" | "blocked" | "done" | "abandoned";
export type ProjectThreadMessageKind = "request" | "reply" | "status" | "decision" | "handoff" | "note";

export interface ThreadOpenInput {
  title: string;
  from: string;
  participants: string[];
  kind?: ProjectThreadKind;
  worktreePath?: string;
}

export interface ThreadOpenResponse extends ProjectApiOk {
  thread: unknown;
}

export interface ThreadSendInput {
  threadId?: string;
  from?: string;
  to?: string[];
  assignee?: string;
  tool?: string;
  worktreePath?: string;
  kind?: ProjectThreadMessageKind;
  body: string;
  title?: string;
}

export interface ThreadSendResponse extends ProjectApiOk {
  thread?: unknown;
  message?: unknown;
}

export interface ThreadStatusInput {
  threadId: string;
  status: ProjectThreadStatus;
  owner?: string;
  waitingOn?: string[];
}

export interface ThreadStatusResponse extends ProjectApiOk {
  thread: unknown;
}

export interface HandoffSendInput {
  from?: string;
  to?: string[];
  assignee?: string;
  tool?: string;
  body: string;
  title?: string;
  worktreePath?: string;
}

export interface ThreadLifecycleInput {
  threadId: string;
  from?: string;
  body?: string;
}

export interface TaskAssignInput {
  from?: string;
  to?: string;
  assignee?: string;
  tool?: string;
  description: string;
  prompt?: string;
  type?: "task" | "review";
  diff?: string;
  worktreePath?: string;
  assigner?: string;
  reviewOf?: string;
  iteration?: number;
}

export interface TaskLifecycleInput {
  taskId: string;
  from?: string;
  body?: string;
}

export interface ThreadSummaryResponse {
  thread: { id: string; title?: string; status?: string; kind?: string };
  latestMessage?: { body?: string; ts?: string; from?: string; kind?: string };
  [k: string]: unknown;
}

export interface TaskSummaryResponse {
  id: string;
  description?: string;
  status?: string;
  assignedTo?: string;
  assignedBy?: string;
  assignee?: string;
  tool?: string;
  threadId?: string;
  [k: string]: unknown;
}

export interface TaskListResponse extends ProjectApiOk {
  tasks: TaskSummaryResponse[];
  [k: string]: unknown;
}

export interface TaskDetailResponse extends ProjectApiOk {
  task: TaskSummaryResponse;
  thread?: ThreadSummaryResponse["thread"];
  messages?: Array<{ id?: string; body?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface WorkflowMutationResponse extends ProjectApiOk {
  thread?: unknown;
  message?: unknown;
  task?: unknown;
  followUpTask?: unknown;
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

export interface ProjectWorktreeSummary {
  name: string;
  path: string;
  branch: string;
  isBare?: boolean;
  pending?: boolean;
  removing?: boolean;
  [k: string]: unknown;
}

export interface WorktreesResponse extends ProjectApiOk {
  worktrees: ProjectWorktreeSummary[];
  [k: string]: unknown;
}

export interface WorktreePathInput {
  path: string;
}

export interface WorktreePathResponse extends ProjectApiOk {
  path: string;
}

export interface CreateWorktreeResponse extends WorktreePathResponse {
  status?: "creating" | "created";
}

export interface RemoveWorktreeResponse extends WorktreePathResponse {
  status?: "removing" | "removed";
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

export interface GraveyardEntryResponse {
  id: string;
  tool?: string;
  label?: string;
  diedAt?: string;
  [k: string]: unknown;
}

export interface WorktreeGraveyardEntryResponse {
  name: string;
  path: string;
  branch?: string;
  createdAt?: string;
  graveyardedAt?: string;
  agents?: GraveyardEntryResponse[];
  services?: Array<{ id: string; command?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface GraveyardResponse extends ProjectApiOk {
  entries: GraveyardEntryResponse[];
  worktrees?: WorktreeGraveyardEntryResponse[];
  [k: string]: unknown;
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
