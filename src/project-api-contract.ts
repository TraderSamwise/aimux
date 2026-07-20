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
  worktrees: "/worktrees",
  graveyard: "/graveyard",
  team: {
    config: "/team/config",
    init: "/team/init",
    addRole: "/team/roles/add",
    removeRole: "/team/roles/remove",
    defaultRole: "/team/default-role",
  },
  plans: "/plans",
  statuslineRefresh: "/statusline/refresh",
  operationFailuresClear: "/operation-failures/clear",
  notifications: {
    list: "/notifications",
    read: "/notifications/read",
    clear: "/notifications/clear",
  },
  hooks: {
    claude: "/hooks/claude",
    codex: "/hooks/codex",
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
  "library",
  "notifications",
  "plans",
  "project-observability",
  "services",
  "team",
  "tasks",
  "threads",
  "topology",
  "worktrees",
] as const;

export type ProjectApiEventName = (typeof PROJECT_API_EVENT_NAMES)[keyof typeof PROJECT_API_EVENT_NAMES];
export type ProjectApiView = (typeof PROJECT_API_VIEWS)[number];

function projectViews(...views: ProjectApiView[]): readonly ProjectApiView[] {
  return views;
}

export const PROJECT_API_VIEW_INVALIDATIONS = {
  all: PROJECT_API_VIEWS,
  agentLifecycle: projectViews(
    "agents",
    "coordination-worklist",
    "desktop-state",
    "graveyard",
    "project-observability",
    "team",
    "topology",
    "worktrees",
  ),
  serviceLifecycle: projectViews("desktop-state", "project-observability", "services", "topology", "worktrees"),
  worktreeLifecycle: projectViews(
    "agents",
    "desktop-state",
    "graveyard",
    "library",
    "project-observability",
    "topology",
    "worktrees",
  ),
  workflow: projectViews("coordination-worklist", "project-observability", "tasks", "threads"),
  notifications: projectViews("coordination-worklist", "notifications", "project-observability"),
  team: projectViews("coordination-worklist", "project-observability", "tasks", "team", "threads"),
  library: projectViews("library"),
  plans: projectViews("plans"),
  runtime: projectViews(
    "agents",
    "coordination-worklist",
    "desktop-state",
    "project-observability",
    "topology",
    "worktrees",
  ),
  operationFailures: projectViews("desktop-state", "project-observability"),
  repair: PROJECT_API_VIEWS,
} as const satisfies Record<string, readonly ProjectApiView[]>;

export type ProjectApiInvalidationGroup = keyof typeof PROJECT_API_VIEW_INVALIDATIONS;

export function projectApiMutationReasonForRoute(method: string, pathname: string): string {
  return `${method.toUpperCase() || "REQUEST"} ${pathname || "/"}`;
}

export function projectApiViewsForMutationRoute(method: string, pathname: string): ProjectApiView[] | null {
  const normalizedMethod = method.toUpperCase();
  if (
    normalizedMethod === "GET" &&
    (
      [
        PROJECT_API_ROUTES.controls.openNotificationTarget,
        PROJECT_API_ROUTES.controls.focusWindow,
        PROJECT_API_ROUTES.controls.activeWindow,
        PROJECT_API_ROUTES.controls.switchNext,
        PROJECT_API_ROUTES.controls.switchPrev,
        PROJECT_API_ROUTES.controls.switchAttention,
      ] as readonly string[]
    ).includes(pathname)
  ) {
    return [...PROJECT_API_VIEW_INVALIDATIONS.runtime];
  }
  if (normalizedMethod !== "POST" && normalizedMethod !== "PUT") return null;
  if (normalizedMethod === "PUT" && pathname.startsWith(`${PROJECT_API_ROUTES.plans}/`)) {
    return [...PROJECT_API_VIEW_INVALIDATIONS.plans];
  }

  switch (pathname) {
    case PROJECT_API_ROUTES.notifications.read:
    case PROJECT_API_ROUTES.notifications.clear:
    case PROJECT_API_ROUTES.runtime.notify:
      return [...PROJECT_API_VIEW_INVALIDATIONS.notifications];

    case PROJECT_API_ROUTES.team.init:
    case PROJECT_API_ROUTES.team.addRole:
    case PROJECT_API_ROUTES.team.removeRole:
    case PROJECT_API_ROUTES.team.defaultRole:
      return [...PROJECT_API_VIEW_INVALIDATIONS.team];

    case PROJECT_API_ROUTES.threads.open:
    case PROJECT_API_ROUTES.threads.send:
    case PROJECT_API_ROUTES.threads.markSeen:
    case PROJECT_API_ROUTES.threads.status:
    case PROJECT_API_ROUTES.handoff.send:
    case PROJECT_API_ROUTES.handoff.accept:
    case PROJECT_API_ROUTES.handoff.complete:
    case PROJECT_API_ROUTES.tasks.assign:
    case PROJECT_API_ROUTES.tasks.accept:
    case PROJECT_API_ROUTES.tasks.block:
    case PROJECT_API_ROUTES.tasks.complete:
    case PROJECT_API_ROUTES.tasks.reopen:
    case PROJECT_API_ROUTES.reviews.approve:
    case PROJECT_API_ROUTES.reviews.requestChanges:
    case PROJECT_API_ROUTES.agents.createTeammateTask:
      return [...PROJECT_API_VIEW_INVALIDATIONS.workflow];

    case PROJECT_API_ROUTES.agents.spawn:
    case PROJECT_API_ROUTES.agents.fork:
    case PROJECT_API_ROUTES.agents.stop:
    case PROJECT_API_ROUTES.agents.resume:
    case PROJECT_API_ROUTES.agents.kill:
    case PROJECT_API_ROUTES.agents.interrupt:
    case PROJECT_API_ROUTES.agents.rename:
    case PROJECT_API_ROUTES.agents.migrate:
    case PROJECT_API_ROUTES.agents.recordBackendSession:
    case PROJECT_API_ROUTES.agents.loop:
    case PROJECT_API_ROUTES.agents.overseer:
    case PROJECT_API_ROUTES.livePane.interrupt:
    case PROJECT_API_ROUTES.agents.createTeammate:
    case PROJECT_API_ROUTES.agents.stopTeammate:
    case PROJECT_API_ROUTES.agents.resumeTeammate:
    case PROJECT_API_ROUTES.agents.killTeammate:
    case PROJECT_API_ROUTES.agents.resurrectTeammate:
    case PROJECT_API_ROUTES.graveyardActions.resurrectAgent:
      return [...PROJECT_API_VIEW_INVALIDATIONS.agentLifecycle];

    case PROJECT_API_ROUTES.services.create:
    case PROJECT_API_ROUTES.services.stop:
    case PROJECT_API_ROUTES.services.resume:
    case PROJECT_API_ROUTES.services.remove:
      return [...PROJECT_API_VIEW_INVALIDATIONS.serviceLifecycle];

    case PROJECT_API_ROUTES.worktreeActions.create:
    case PROJECT_API_ROUTES.worktreeActions.remove:
    case PROJECT_API_ROUTES.worktreeActions.graveyard:
    case PROJECT_API_ROUTES.graveyardActions.resurrectWorktree:
    case PROJECT_API_ROUTES.graveyardActions.deleteWorktree:
    case PROJECT_API_ROUTES.graveyardActions.cleanup:
      return [...PROJECT_API_VIEW_INVALIDATIONS.worktreeLifecycle];

    case PROJECT_API_ROUTES.runtime.usageMark:
    case PROJECT_API_ROUTES.runtime.setStatus:
    case PROJECT_API_ROUTES.runtime.setProgress:
    case PROJECT_API_ROUTES.runtime.setContext:
    case PROJECT_API_ROUTES.runtime.setServices:
    case PROJECT_API_ROUTES.runtime.log:
    case PROJECT_API_ROUTES.runtime.event:
    case PROJECT_API_ROUTES.runtime.markSeen:
    case PROJECT_API_ROUTES.runtime.setActivity:
    case PROJECT_API_ROUTES.runtime.setAttention:
    case PROJECT_API_ROUTES.runtime.clearLog:
    case PROJECT_API_ROUTES.runtime.shellState:
    case PROJECT_API_ROUTES.agents.interactionRegister:
    case PROJECT_API_ROUTES.agents.interactionNotify:
    case PROJECT_API_ROUTES.agents.interactionRequest:
    case PROJECT_API_ROUTES.agents.interactionRespond:
    case PROJECT_API_ROUTES.agents.input:
    case PROJECT_API_ROUTES.livePane.input:
      return [...PROJECT_API_VIEW_INVALIDATIONS.runtime];

    case PROJECT_API_ROUTES.statuslineRefresh:
      return [...PROJECT_API_VIEW_INVALIDATIONS.runtime];

    case PROJECT_API_ROUTES.operationFailuresClear:
      return [...PROJECT_API_VIEW_INVALIDATIONS.operationFailures];

    default:
      return [...PROJECT_API_VIEW_INVALIDATIONS.all];
  }
}

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

export interface TeamRoleConfig {
  description: string;
  reviewedBy?: string;
  canEdit?: boolean;
}

export interface TeamConfig {
  roles: Record<string, TeamRoleConfig>;
  defaultRole: string;
}

export interface TeamConfigResponse extends ProjectApiOk {
  config: TeamConfig;
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

export interface AgentOutputStreamInput extends LivePaneOutputInput {
  intervalMs?: number;
}

export type AgentOutputStreamEventName = "ready" | "output" | "error";

export interface AgentOutputStreamReadyData {
  sessionId: string;
  startLine: number;
  intervalMs: number;
}

export interface AgentOutputStreamOutputData {
  sessionId: string;
  output: string;
  startLine: number;
  parsed?: unknown;
}

export interface AgentOutputStreamErrorData {
  sessionId: string;
  error: string;
}

export type AgentOutputStreamEvent =
  | { event: "ready"; data: AgentOutputStreamReadyData }
  | { event: "output"; data: AgentOutputStreamOutputData }
  | { event: "error"; data: AgentOutputStreamErrorData };

export interface LivePaneInputRequest extends LivePaneSessionInput {
  text: string;
  attachmentIds?: string[];
}

export interface LivePaneInputResponse extends ProjectApiOk {
  sessionId: string;
  accepted: true;
}

export interface LivePaneInterruptResponse extends ProjectLifecycleTransitionResponse {
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

export interface ProjectHealthResponse extends ProjectApiOk {
  serviceInfo?: unknown;
  [k: string]: unknown;
}

export interface ProjectDiagnosticsResponse extends ProjectApiOk {
  serviceInfo?: unknown;
  [k: string]: unknown;
}

export interface StatuslineRefreshInput {
  sessionId?: string;
  force?: boolean;
}

export interface StatuslineRefreshResponse extends ProjectApiOk {
  [k: string]: unknown;
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

export type ProjectLifecycleTransitionTargetKind = "agent" | "service" | "worktree";

export type ProjectLifecycleTransitionPhase = "queued" | "started" | "settling" | "succeeded" | "failed";

export type ProjectLifecycleTransitionOperation =
  | "agent.spawn"
  | "agent.fork"
  | "agent.stop"
  | "agent.resume"
  | "agent.kill"
  | "agent.rename"
  | "agent.migrate"
  | "agent.interrupt"
  | "service.create"
  | "service.stop"
  | "service.resume"
  | "service.remove"
  | "worktree.create"
  | "worktree.remove"
  | "worktree.graveyard"
  | "graveyard.agent.resurrect"
  | "graveyard.worktree.resurrect"
  | "graveyard.worktree.delete";

export interface ProjectLifecycleTransition {
  operationId: string;
  operation: ProjectLifecycleTransitionOperation;
  targetKind: ProjectLifecycleTransitionTargetKind;
  phase: ProjectLifecycleTransitionPhase;
  startedAt: string;
  updatedAt: string;
  targetId?: string;
  targetPath?: string;
  error?: string;
}

export interface ProjectLifecycleTransitionEnvelope {
  transition?: ProjectLifecycleTransition;
}

export interface ProjectLifecycleTransitionErrorResponse extends ProjectLifecycleTransitionEnvelope {
  ok: false;
  error: string;
}

export interface ProjectLifecycleTransitionResponse extends ProjectApiOk, ProjectLifecycleTransitionEnvelope {}

export interface CreateServiceInput {
  command?: string;
  worktreePath?: string;
  serviceId?: string;
}

export interface ServiceActionInput {
  serviceId: string;
}

export interface CreateServiceResponse extends ProjectLifecycleTransitionResponse {
  serviceId: string;
}

export interface StopServiceResponse extends ProjectLifecycleTransitionResponse {
  serviceId: string;
  status: "stopped";
}

export interface ResumeServiceResponse extends ProjectLifecycleTransitionResponse {
  serviceId: string;
  status: "running";
}

export interface RemoveServiceResponse extends ProjectLifecycleTransitionResponse {
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

export interface WorktreePathResponse extends ProjectLifecycleTransitionResponse {
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

export interface StopAgentResponse extends ProjectLifecycleTransitionResponse {
  sessionId: string;
  status: "offline";
}

export interface ResumeAgentResponse extends ProjectLifecycleTransitionResponse {
  sessionId: string;
  status: "running" | "offline";
  warning?: string;
  teammateFailures?: Array<{ sessionId?: string; error?: string; message?: string }>;
}

export interface KillAgentResponse extends ProjectLifecycleTransitionResponse {
  sessionId: string;
  status: "graveyard";
  previousStatus: "running" | "offline";
}

export interface ResurrectAgentResponse extends ProjectLifecycleTransitionResponse {
  sessionId: string;
  status: "offline";
}

export interface AgentListItem {
  id: string;
  tool?: string;
  role?: string;
  status?: string;
  restoreState?: string;
  restoreBlockedReason?: string;
  worktreePath?: string;
  label?: string;
  activity?: string;
  attention?: string;
  loop?: unknown;
  overseer?: boolean;
  task?: { id: string; description?: string; status?: string };
  [k: string]: unknown;
}

export interface AgentListResponse extends ProjectApiOk {
  agents: AgentListItem[];
}

export interface SpawnAgentInput {
  tool: string;
  sessionId?: string;
  worktreePath?: string;
  open?: boolean;
  launchOverride?: unknown;
  overseer?: boolean;
}

export interface SpawnAgentResponse extends ProjectLifecycleTransitionResponse {
  sessionId?: string;
  [k: string]: unknown;
}

export interface ForkAgentInput {
  sourceSessionId: string;
  tool: string;
  targetSessionId?: string;
  instruction?: string;
  worktreePath?: string;
  open?: boolean;
  launchOverride?: unknown;
}

export interface ForkAgentResponse extends ProjectLifecycleTransitionResponse {
  sessionId?: string;
  sourceSessionId?: string;
  [k: string]: unknown;
}

export interface RenameAgentInput extends AgentSessionInput {
  label?: string;
}

export interface RenameAgentResponse extends ProjectLifecycleTransitionResponse {
  sessionId: string;
  label?: string;
  [k: string]: unknown;
}

export interface MigrateAgentInput extends AgentSessionInput {
  worktreePath: string;
}

export interface MigrateAgentResponse extends ProjectLifecycleTransitionResponse {
  sessionId: string;
  worktreePath?: string;
  [k: string]: unknown;
}

export interface AgentLoopInput extends AgentSessionInput {
  active: boolean;
  goal?: string;
}

export interface AgentLoopResponse extends ProjectApiOk {
  sessionId: string;
  loop: unknown | null;
}

export interface AgentOverseerInput extends AgentSessionInput {
  active: boolean;
}

export interface AgentOverseerResponse extends ProjectApiOk {
  sessionId: string;
  overseer: boolean;
}

export interface TeammateTaskBody {
  title?: string;
  description?: string;
  body?: string;
  prompt?: string;
  worktreePath?: string;
}

export interface CreateTeammateInput {
  parentSessionId: string;
  role?: string;
  label?: string;
  tool?: string;
  sessionId?: string;
  worktreePath?: string;
  open?: boolean;
  extraArgs?: string[];
  initialTask?: TeammateTaskBody;
  order?: number;
}

export interface CreateTeammateResponse extends ProjectLifecycleTransitionResponse {
  parentSessionId?: string;
  sessionId?: string;
  task?: unknown;
  thread?: unknown;
  [k: string]: unknown;
}

export interface CreateTeammateTaskInput extends TeammateTaskBody {
  parentSessionId: string;
  teammateSessionId: string;
}

export interface CreateTeammateTaskResponse extends WorkflowMutationResponse {
  parentSessionId: string;
  teammateSessionId: string;
}

export interface TeammateLifecycleInput {
  parentSessionId: string;
  teammateSessionId: string;
}

export interface TeammateLifecycleResponse extends ProjectLifecycleTransitionResponse {
  parentSessionId: string;
  teammateSessionId: string;
  [k: string]: unknown;
}

export interface TeammateListResponse extends ProjectApiOk {
  parentSessionId: string;
  teammates: AgentListItem[];
}

export interface SwitchableAgentsInput {
  currentClientSession?: string;
  currentWindow?: string;
  currentWindowId?: string;
  currentPath?: string;
  scope?: "all" | "worktree";
  includePreview?: "1";
}

export type ExposePreviewSnapshotSource = "capture" | "tap";

export interface ExposePreviewSnapshot {
  output: string;
  capturedAt: string;
  source: ExposePreviewSnapshotSource;
  windowId?: string;
  startLine?: number;
  lineCount?: number;
}

export interface SwitchableAgentItem extends Record<string, unknown> {
  previewSnapshot?: ExposePreviewSnapshot;
}

export interface SwitchableAgentsResponse extends ProjectApiOk {
  items: SwitchableAgentItem[];
}

export interface InteractionPendingResponse extends ProjectApiOk {
  requests: Array<Record<string, unknown>>;
}

export interface InteractionRespondInput {
  id: string;
  response?: Record<string, unknown>;
}

export interface InteractionRespondResponse extends ProjectApiOk {
  request?: unknown;
}

export type InteractionStreamEventName = "ready" | "interaction";

export interface InteractionStreamReadyData {
  pending: Array<Record<string, unknown>>;
}

export type InteractionStreamInteractionData = Record<string, unknown> & {
  type?: string;
  kind?: string;
  interaction?: unknown;
};

export type InteractionStreamEvent =
  | { event: "ready"; data: InteractionStreamReadyData }
  | { event: "interaction"; data: InteractionStreamInteractionData };

export interface OperationFailuresClearInput {
  targetKind?: "worktree" | "agent" | "service" | "dashboard";
  operation?: string;
  targetId?: string;
  worktreePath?: string;
}

export interface OperationFailuresClearResponse extends ProjectApiOk {
  cleared: number;
}

export interface GraveyardCleanupInput {
  dryRun?: boolean;
}

export interface GraveyardCleanupResponse extends ProjectApiOk {
  dryRun?: boolean;
  [k: string]: unknown;
}
