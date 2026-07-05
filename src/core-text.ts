import type {
  CoreProjectServiceState,
  CoreRelaySnapshot,
  CoreStatusProject,
  CoreTmuxTarget,
} from "./core-command-contract.js";
import type { NotificationRecord, TeamConfig } from "./project-api-contract.js";

export interface CoreDaemonStatusTextPayload {
  daemon: { pid?: number; port?: number; serviceInfo?: unknown } | null;
  projects: Array<{ serviceAlive?: boolean }>;
  relay: CoreRelaySnapshot;
}

export interface CoreHostStatusTextPayload {
  projectRoot: string;
  sessionName: string | null;
  daemon: { serviceInfo?: unknown };
  projectService: unknown | null;
  serviceAlive: boolean;
  metadataEndpoint: unknown;
  expectedServiceManifest: unknown;
}

export interface CoreProjectEnsureTextPayload {
  project: CoreProjectServiceState;
}

export interface CoreProjectServiceMutationTextPayload {
  projectRoot: string;
  project: CoreProjectServiceState | null;
}

export interface CoreProjectRestartTextPayload {
  projectRoot: string;
  project: CoreProjectServiceState;
  dashboardSessionName?: string;
  dashboardTarget?: CoreTmuxTarget;
}

export interface CoreDashboardReloadTextPayload {
  ok: true;
  projectRoot: string;
  dashboardSessionName: string;
  dashboardTarget: CoreTmuxTarget;
}

export interface CoreRuntimeRestartTextPayload extends CoreDashboardReloadTextPayload {
  dashboardSession: string;
  project: CoreProjectServiceState;
  tmuxSessionsKilled: string[];
}

export interface CoreRemoteStatusTextPayload {
  credentials: { relayUrl: string; remoteEnabled: boolean } | null;
  relay: CoreRelaySnapshot;
}

export interface CoreWhoamiTextPayload {
  credentials: { userId: string; relayUrl: string; remoteEnabled: boolean } | null;
}

export type CoreLogoutTextResult = "cleared" | "none" | "failed";

export interface CoreLoginTextPayload {
  userId: string;
  relay: CoreRelaySnapshot;
}

export interface CoreLifecycleSpawnTextPayload {
  ok: true;
  projectRoot: string;
  sessionId: unknown;
  tool: string;
  worktreePath: string;
  opened: boolean;
}

export interface CoreLifecycleStopTextPayload {
  ok: true;
  projectRoot: string;
  sessionId: unknown;
  status: unknown;
}

export interface CoreLifecycleKillTextPayload {
  ok: true;
  projectRoot: string;
  sessionId: unknown;
  status: unknown;
  previousStatus: unknown;
}

export interface CoreLifecycleForkTextPayload extends CoreLifecycleSpawnTextPayload {
  sourceSessionId: string;
  threadId: unknown;
}

export interface CoreAgentSummaryTextPayload {
  agents: Array<{
    id?: unknown;
    tool?: unknown;
    role?: unknown;
    status?: unknown;
    worktreePath?: unknown;
    activity?: unknown;
    attention?: unknown;
    loop?: unknown;
    overseer?: unknown;
    task?: unknown;
  }>;
}

export interface CoreAgentInputTextPayload {
  ok: true;
  projectRoot: string;
  sessionId: string;
}

export interface CoreAgentRenameTextPayload extends CoreAgentInputTextPayload {
  label?: string;
}

export interface CoreAgentMigrateTextPayload extends CoreAgentInputTextPayload {
  worktreePath: string;
}

export interface CoreLoopTextPayload {
  ok: true;
  projectRoot: string;
  sessionId: string;
  active: boolean;
  goal?: string;
  eventWarning?: string;
}

export interface CoreOverseerTextPayload {
  ok: true;
  projectRoot: string;
  sessionId: string;
  tool?: string;
  overseer: boolean;
}

export interface CoreTeamTextPayload {
  ok: true;
  projectRoot: string;
  config: TeamConfig;
  role?: string;
}

export interface CoreNotificationsListTextPayload {
  notifications: NotificationRecord[];
  unreadCount: number;
}

export interface CoreNotificationSendTextPayload {
  title: string;
}

export interface CoreNotificationReadTextPayload {
  ok: true;
  updated: number;
}

export interface CoreNotificationClearTextPayload {
  ok: true;
  cleared: number;
}

export interface CoreWorktreeSummaryTextPayload {
  worktrees: unknown[];
}

export interface CoreWorktreeCreateTextPayload {
  ok: true;
  name: string;
  path: string;
  status: "creating" | "created";
  projectRoot: string;
}

export interface CoreWorktreePathTextPayload {
  ok: true;
  projectRoot: string;
  path: string;
  status: string;
}

export interface CoreGraveyardTextPayload {
  entries: unknown[];
  worktrees: unknown[];
}

export interface CoreGraveyardAgentTextPayload {
  ok: true;
  projectRoot: string;
  sessionId: string;
  status: string;
  previousStatus?: string;
}

export interface CoreGraveyardCleanupTextPayload {
  ok: true;
  projectRoot: string;
  result: unknown;
}

export interface CoreThreadListTextPayload {
  summaries: unknown[];
}

export interface CoreThreadShowTextPayload {
  thread: unknown;
  messages: unknown[];
}

export interface CoreThreadOpenTextPayload {
  thread: unknown;
}

export interface CoreThreadSendTextPayload {
  message: unknown;
}

export interface CoreThreadStatusTextPayload {
  thread: unknown;
}

export interface CoreMessageSendTextPayload {
  thread: unknown;
  message: unknown;
  deliveredTo?: unknown;
}

export type CoreHandoffSendTextPayload = CoreMessageSendTextPayload;

export interface CoreHandoffMutationTextPayload {
  thread: unknown;
  message: unknown;
}

export interface CoreTaskListTextPayload {
  tasks: unknown[];
}

export interface CoreTaskShowTextPayload {
  task: unknown;
  thread?: unknown;
  messages: unknown[];
}

export interface CoreTaskMutationTextPayload {
  task: unknown;
  thread?: unknown;
}

export interface CoreReviewRequestChangesTextPayload extends CoreTaskMutationTextPayload {
  followUpTask?: unknown;
}

function coreProjectServicePid(projectService: unknown): number | null {
  return projectService &&
    typeof projectService === "object" &&
    typeof (projectService as { pid?: unknown }).pid === "number"
    ? (projectService as { pid: number }).pid
    : null;
}

export function renderCoreDaemonStatusLines(payload: CoreDaemonStatusTextPayload): string[] {
  const daemon = payload.daemon;
  if (!daemon) return ["aimux daemon is not running."];
  const lines = [`Daemon pid=${daemon.pid} port=${daemon.port}`];
  lines.push(`Known projects: ${payload.projects.length}`);
  lines.push(`Live project services: ${payload.projects.filter((project) => project.serviceAlive).length}`);
  const relay = payload.relay;
  if (relay.status && relay.status !== "off") {
    lines.push(`Relay: ${relay.status}${relay.relayUrl ? ` (${relay.relayUrl})` : ""}`);
  } else {
    lines.push("Relay: off");
  }
  return lines;
}

export function renderCoreHostStatusLines(payload: CoreHostStatusTextPayload, knownProject: boolean): string[] {
  if (!knownProject) return [`No known control service for ${payload.projectRoot}`];
  const lines = [`Service: ${payload.serviceAlive ? "live" : "idle"}`];
  const pid = coreProjectServicePid(payload.projectService);
  if (pid !== null) lines.push(`Service pid=${pid}`);
  lines.push(`Metadata: ${payload.metadataEndpoint ? JSON.stringify(payload.metadataEndpoint) : "not running"}`);
  lines.push(`Expected manifest: ${JSON.stringify(payload.expectedServiceManifest)}`);
  lines.push(`Tmux session: ${payload.sessionName}`);
  return lines;
}

export function renderCoreProjectEnsureLines(payload: CoreProjectEnsureTextPayload): string[] {
  return [`Ensured project service for ${payload.project.projectRoot} (pid ${payload.project.pid})`];
}

export function renderCoreProjectServeLines(payload: CoreProjectEnsureTextPayload): string[] {
  return [`aimux serve: daemon managing ${payload.project.projectRoot} (service pid ${payload.project.pid})`];
}

export function renderCoreProjectStopLines(payload: CoreProjectServiceMutationTextPayload): string[] {
  if (!payload.project) return ["No live project service to stop."];
  return [`Stopped project service pid ${payload.project.pid}`];
}

export function renderCoreProjectKillLines(payload: CoreProjectServiceMutationTextPayload): string[] {
  if (!payload.project) return ["No live project service to kill."];
  return [`Killed project service pid ${payload.project.pid}`];
}

export function renderCoreProjectRestartLines(payload: CoreProjectRestartTextPayload): string[] {
  if (payload.dashboardSessionName) return [`Restarted project service for ${payload.dashboardSessionName}`];
  return [`Restarted project service for ${payload.projectRoot}`];
}

export function renderCoreDashboardReloadLines(payload: CoreDashboardReloadTextPayload): string[] {
  return [`Reloaded dashboard for ${payload.dashboardSessionName}`];
}

export function renderCoreRuntimeRestartLines(payload: CoreRuntimeRestartTextPayload): string[] {
  return [
    `Restarted project runtime for ${payload.projectRoot}`,
    `Dashboard: ${payload.dashboardSessionName}:${payload.dashboardTarget.windowIndex}`,
  ];
}

export function renderCoreDaemonProjectsLines(projects: CoreStatusProject[]): string[] {
  return projects.map((project) => {
    const badge = project.serviceAlive ? "service" : "idle";
    return `${project.name}  ${badge}  ${project.path}`;
  });
}

export function renderCoreProjectsListLines(projects: CoreStatusProject[]): string[] {
  if (projects.length === 0) return ["No aimux projects found."];
  return projects.map((project) => {
    const liveBadge = project.serviceAlive ? "live" : "idle";
    return `${project.name}  ${liveBadge}  ${project.path}`;
  });
}

function relayLastError(relay: CoreRelaySnapshot): string | null {
  return "lastError" in relay ? relay.lastError : null;
}

export function renderCoreRemoteStatusLines(payload: CoreRemoteStatusTextPayload): string[] {
  const { credentials, relay } = payload;
  if (!credentials) return ["Not logged in. Run `aimux login` to enable remote access."];
  const lines = [
    `Remote access: ${credentials.remoteEnabled ? "enabled" : "disabled"}`,
    `Relay: ${credentials.relayUrl}`,
    `Connection: ${relay.status ?? "unknown"}`,
  ];
  const lastError = relayLastError(relay);
  if (lastError) lines.push(`Last error: ${lastError}`);
  return lines;
}

export function renderCoreRemoteEnableLines(relay: CoreRelaySnapshot): string[] {
  return [`✓ Remote access enabled (connection: ${relay.status ?? "unknown"})`];
}

export function renderCoreRemoteDisableLines(daemonDisconnected: boolean): string[] {
  return [
    daemonDisconnected ? "✓ Remote access disabled. Daemon disconnected from relay." : "✓ Remote access disabled.",
  ];
}

export function renderCoreWhoamiLines(payload: CoreWhoamiTextPayload): string[] {
  const credentials = payload.credentials;
  if (!credentials) return ["Not logged in. Run `aimux login` to enable remote access."];
  return [
    `Logged in as ${credentials.userId}`,
    `Relay: ${credentials.relayUrl}`,
    `Remote access: ${credentials.remoteEnabled ? "enabled" : "disabled"}`,
  ];
}

export function coreWhoamiJson(
  payload: CoreWhoamiTextPayload,
): { loggedIn: true; userId: string; relayUrl: string; remoteEnabled: boolean } | { loggedIn: false } {
  const credentials = payload.credentials;
  return credentials
    ? {
        loggedIn: true,
        userId: credentials.userId,
        relayUrl: credentials.relayUrl,
        remoteEnabled: credentials.remoteEnabled,
      }
    : { loggedIn: false };
}

export function renderCoreLogoutLines(result: CoreLogoutTextResult): string[] {
  if (result === "cleared") return ["✓ Logged out. Remote access disabled."];
  if (result === "none") return ["Not logged in."];
  return ["Failed to remove credentials file — check permissions."];
}

export function renderCoreLoginLines(payload: CoreLoginTextPayload): string[] {
  return ["", `✓ Logged in as ${payload.userId}`, ...renderRelayAuthLines(payload.relay)];
}

export function renderCoreSecurityUnlockLines(payload: CoreLoginTextPayload): string[] {
  return ["", `✓ Security unlocked for ${payload.userId}`, ...renderRelayAuthLines(payload.relay)];
}

export function renderCoreLifecycleSpawnLines(payload: CoreLifecycleSpawnTextPayload): string[] {
  return [`spawned ${String(payload.sessionId)}`];
}

export function renderCoreLifecycleStopLines(payload: CoreLifecycleStopTextPayload): string[] {
  return [`stopped ${String(payload.sessionId)}`];
}

export function renderCoreLifecycleKillLines(payload: CoreLifecycleKillTextPayload): string[] {
  return [`graveyarded ${String(payload.sessionId)}`];
}

export function renderCoreLifecycleForkLines(payload: CoreLifecycleForkTextPayload): string[] {
  return [`forked ${String(payload.sessionId)}`, `thread ${String(payload.threadId)}`];
}

export function renderCoreAgentPsLines(payload: CoreAgentSummaryTextPayload): string[] {
  if (payload.agents.length === 0) return ["no agents"];
  return payload.agents.flatMap((agent) => {
    const id = typeof agent.id === "string" ? agent.id : "?";
    const tool = typeof agent.tool === "string" ? agent.tool : "?";
    const role = typeof agent.role === "string" ? agent.role : "";
    const status = typeof agent.status === "string" ? agent.status : "?";
    const activity = typeof agent.activity === "string" ? agent.activity : "";
    const attention = typeof agent.attention === "string" ? agent.attention : "";
    const loop =
      agent.loop && typeof agent.loop === "object" && !Array.isArray(agent.loop)
        ? (agent.loop as { active?: unknown; goal?: unknown })
        : undefined;
    const task =
      agent.task && typeof agent.task === "object" && !Array.isArray(agent.task)
        ? (agent.task as { description?: unknown; status?: unknown })
        : undefined;
    const tags = [
      agent.overseer === true ? "overseer" : null,
      loop?.active === true ? `loop${typeof loop.goal === "string" ? `:${loop.goal}` : ""}` : null,
    ].filter(Boolean);
    const state = [activity, attention].filter(Boolean).join("/");
    const lines = [
      `${id}  [${tool}${role ? `:${role}` : ""}]  ${status}${state ? `  ${state}` : ""}${
        tags.length ? `  {${tags.join(" ")}}` : ""
      }`,
    ];
    if (typeof agent.worktreePath === "string") lines.push(`    worktree: ${agent.worktreePath}`);
    if (task && typeof task.description === "string" && typeof task.status === "string") {
      lines.push(`    task: ${task.description} (${task.status})`);
    }
    return lines;
  });
}

export function renderCoreAgentInputLines(payload: CoreAgentInputTextPayload): string[] {
  return [`delivered to ${payload.sessionId}`];
}

export function renderCoreAgentRenameLines(payload: CoreAgentRenameTextPayload): string[] {
  return [`renamed ${payload.sessionId} -> ${payload.label ?? ""}`.trim()];
}

export function renderCoreAgentMigrateLines(payload: CoreAgentMigrateTextPayload): string[] {
  return [`migrated ${payload.sessionId} -> ${payload.worktreePath}`];
}

export function renderCoreLoopAddLines(payload: CoreLoopTextPayload): string[] {
  return [`loop on ${payload.sessionId}${payload.goal ? ` — ${payload.goal}` : ""}`];
}

export function renderCoreLoopRemoveLines(payload: CoreLoopTextPayload): string[] {
  return [`loop off ${payload.sessionId}`];
}

export function renderCoreLoopDoneLines(payload: CoreLoopTextPayload): string[] {
  const lines = payload.eventWarning ? [payload.eventWarning] : [];
  lines.push(`loop done ${payload.sessionId}`);
  return lines;
}

export function renderCoreLoopBlockLines(payload: CoreLoopTextPayload): string[] {
  const lines = payload.eventWarning ? [payload.eventWarning] : [];
  lines.push(`loop blocked ${payload.sessionId}`);
  return lines;
}

export function renderCoreOverseerStartLines(payload: CoreOverseerTextPayload): string[] {
  return [`overseer ${payload.sessionId}`];
}

export function renderCoreOverseerClearLines(payload: CoreOverseerTextPayload): string[] {
  return [`overseer cleared ${payload.sessionId}`];
}

export function renderCoreTeamShowLines(payload: CoreTeamTextPayload): string[] {
  const lines = ["Team Roles:"];
  for (const [name, role] of Object.entries(payload.config.roles)) {
    const flags: string[] = [];
    if (role.reviewedBy) flags.push(`reviewed by: ${role.reviewedBy}`);
    if (role.canEdit) flags.push("can edit");
    const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
    lines.push(`  ${name}: ${role.description}${flagStr}`);
  }
  lines.push("", `Default role: ${payload.config.defaultRole}`);
  return lines;
}

export function renderCoreTeamAddLines(payload: CoreTeamTextPayload): string[] {
  const role = requiredCoreTeamRole(payload);
  return role ? [`Role "${role}" saved.`] : ["Error: role is required for this operation."];
}

export function renderCoreTeamRemoveLines(payload: CoreTeamTextPayload): string[] {
  const role = requiredCoreTeamRole(payload);
  return role ? [`Role "${role}" removed.`] : ["Error: role is required for this operation."];
}

export function renderCoreTeamDefaultLines(payload: CoreTeamTextPayload): string[] {
  const role = requiredCoreTeamRole(payload);
  return role ? [`Default role set to "${role}".`] : ["Error: role is required for this operation."];
}

export function renderCoreTeamInitLines(payload: CoreTeamTextPayload): string[] {
  const lines = ["Team config initialized with default roles:"];
  for (const [name, role] of Object.entries(payload.config.roles)) {
    lines.push(`  ${name}: ${role.description}`);
  }
  return lines;
}

export function renderCoreNotificationsListLines(payload: CoreNotificationsListTextPayload): string[] {
  if (payload.notifications.length === 0) return ["No notifications."];
  return payload.notifications.map((notification) => {
    const state = notification.unread ? "unread" : "read";
    const session = notification.sessionId ? ` [${notification.sessionId}]` : "";
    return `${notification.id} ${state}${session} ${notification.title}: ${notification.body}`;
  });
}

export function renderCoreNotificationSendLines(payload: CoreNotificationSendTextPayload): string[] {
  return [`Queued notification "${payload.title}".`];
}

export function renderCoreNotificationReadLines(payload: CoreNotificationReadTextPayload): string[] {
  return [`Marked ${payload.updated} notification${payload.updated === 1 ? "" : "s"} as read.`];
}

export function renderCoreNotificationClearLines(payload: CoreNotificationClearTextPayload): string[] {
  return [`Cleared ${payload.cleared} notification${payload.cleared === 1 ? "" : "s"}.`];
}

function requiredCoreTeamRole(payload: CoreTeamTextPayload): string | undefined {
  return typeof payload.role === "string" && payload.role.trim() ? payload.role.trim() : undefined;
}

export function renderCoreWorktreeListLines(payload: CoreWorktreeSummaryTextPayload): string[] {
  const worktrees = payload.worktrees.filter((entry) => entry && typeof entry === "object") as Array<
    Record<string, unknown>
  >;
  if (worktrees.length === 0) return ["No worktrees found."];
  return renderWorktreeTableLines(worktrees, "");
}

export function renderCoreWorktreeCreateLines(payload: CoreWorktreeCreateTextPayload): string[] {
  if (payload.status === "creating") {
    return [`Creating worktree "${payload.name}"${payload.path ? ` (${payload.path})` : ""}.`];
  }
  return [`Created worktree "${payload.name}" at ${payload.path}`];
}

export function renderCoreWorktreeRemoveLines(payload: CoreWorktreePathTextPayload): string[] {
  return [`${payload.status === "removing" ? "removing" : "removed"} ${payload.path}`];
}

export function renderCoreWorktreeGraveyardLines(payload: CoreWorktreePathTextPayload): string[] {
  return [`graveyarded ${payload.path}`];
}

export function renderCoreWorktreeResurrectLines(payload: CoreWorktreePathTextPayload): string[] {
  return [`resurrected ${payload.path}`];
}

export function renderCoreWorktreeDeleteGraveyardLines(payload: CoreWorktreePathTextPayload): string[] {
  return [`deleted ${payload.path}`];
}

export function renderCoreGraveyardLines(payload: CoreGraveyardTextPayload): string[] {
  const entries = payload.entries.filter((entry) => entry && typeof entry === "object") as Array<
    Record<string, unknown>
  >;
  const worktrees = payload.worktrees.filter((entry) => entry && typeof entry === "object") as Array<
    Record<string, unknown>
  >;
  if (entries.length === 0 && worktrees.length === 0) return ["Graveyard is empty."];
  const lines: string[] = [];
  if (worktrees.length > 0) {
    lines.push("Worktrees", ...renderWorktreeTableLines(worktrees, "?"));
  }
  if (entries.length > 0) {
    if (worktrees.length > 0) lines.push("");
    lines.push("Agents", "ID".padEnd(25) + "Tool".padEnd(15) + "Backend Session ID", "-".repeat(70));
    for (const session of entries) {
      lines.push(
        String(session.id ?? "?").padEnd(25) +
          String(session.command ?? session.tool ?? "?").padEnd(15) +
          String(session.backendSessionId ?? "(none)"),
      );
    }
  }
  return lines;
}

export function renderCoreGraveyardAgentLines(payload: CoreGraveyardAgentTextPayload): string[] {
  const action = payload.status === "graveyard" || payload.status === "graveyarded" ? "graveyarded" : "resurrected";
  return [`${action} ${payload.sessionId}`];
}

function renderWorktreeTableLines(worktrees: Array<Record<string, unknown>>, fallback: string): string[] {
  const lines = ["Name".padEnd(30) + "Branch".padEnd(35) + "Path", "-".repeat(95)];
  for (const worktree of worktrees) {
    lines.push(
      String(worktree.name ?? fallback).padEnd(30) +
        String(worktree.branch ?? "").padEnd(35) +
        String(worktree.path ?? fallback),
    );
  }
  return lines;
}

export function renderCoreGraveyardCleanupLines(payload: CoreGraveyardCleanupTextPayload): string[] {
  const result =
    payload.result && typeof payload.result === "object" ? (payload.result as Record<string, unknown>) : {};
  const plan = result.plan && typeof result.plan === "object" ? (result.plan as Record<string, unknown>) : {};
  if (plan.enabled === false) return ["Graveyard cleanup is disabled."];
  const items = Array.isArray(result.results) ? result.results.filter((item) => item && typeof item === "object") : [];
  const records = items as Array<Record<string, unknown>>;
  const removed = records.filter((item) => item.status === "removed").length;
  const dryRun = records.filter((item) => item.status === "dry-run").length;
  const failed = records.filter((item) => item.status === "failed").length;
  const action = result.dryRun ? "would remove" : "removed";
  const retentionDays = plan.retentionDays ?? "?";
  const lines = [
    `Graveyard cleanup ${action} ${result.dryRun ? dryRun : removed} item(s); ${failed} failed. Retention: ${retentionDays} day(s).`,
  ];
  for (const item of records) {
    const status = item.status === "failed" ? `failed: ${String(item.error ?? "")}` : String(item.status ?? "?");
    lines.push(`${String(item.kind ?? "?")} ${String(item.id ?? "?")}: ${status}`);
  }
  return lines;
}

export function renderCoreThreadListLines(payload: CoreThreadListTextPayload): string[] {
  const summaries = payload.summaries.filter((entry) => entry && typeof entry === "object") as Array<
    Record<string, unknown>
  >;
  if (summaries.length === 0) return ["No threads found."];
  const lines: string[] = [];
  for (const summary of summaries) {
    const thread =
      summary.thread && typeof summary.thread === "object" ? (summary.thread as Record<string, unknown>) : {};
    const latestMessage =
      summary.latestMessage && typeof summary.latestMessage === "object"
        ? (summary.latestMessage as Record<string, unknown>)
        : null;
    const unreadBy = Array.isArray(thread.unreadBy) ? thread.unreadBy : [];
    const waitingOn = Array.isArray(thread.waitingOn) ? thread.waitingOn : [];
    const unread = unreadBy.length ? ` unread=${unreadBy.length}` : "";
    const waiting = waitingOn.length ? ` waiting=${waitingOn.join(",")}` : "";
    lines.push(
      `${String(thread.id ?? "?")}  ${String(thread.kind ?? "?")}  ${String(thread.status ?? "?")}${unread}${waiting}`,
    );
    lines.push(`  ${String(thread.title ?? "")}`);
    if (latestMessage) {
      lines.push(
        `  latest: ${String(latestMessage.from ?? "?")} [${String(latestMessage.kind ?? "?")}] ${String(
          latestMessage.body ?? "",
        )}`,
      );
    }
  }
  return lines;
}

export function renderCoreThreadShowLines(payload: CoreThreadShowTextPayload): string[] {
  const thread =
    payload.thread && typeof payload.thread === "object" ? (payload.thread as Record<string, unknown>) : {};
  const messages = payload.messages.filter((entry) => entry && typeof entry === "object") as Array<
    Record<string, unknown>
  >;
  const participants = Array.isArray(thread.participants) ? thread.participants : [];
  const waitingOn = Array.isArray(thread.waitingOn) ? thread.waitingOn : [];
  const lines = [
    `${String(thread.title ?? "")} (${String(thread.kind ?? "?")})`,
    `id: ${String(thread.id ?? "?")}`,
    `status: ${String(thread.status ?? "?")}`,
    `participants: ${participants.join(", ")}`,
  ];
  if (thread.owner) lines.push(`owner: ${String(thread.owner)}`);
  if (waitingOn.length) lines.push(`waitingOn: ${waitingOn.join(", ")}`);
  lines.push("");
  for (const message of messages) {
    lines.push(`${String(message.ts ?? "?")}  ${String(message.from ?? "?")} [${String(message.kind ?? "?")}]`);
    lines.push(`  ${String(message.body ?? "")}`);
  }
  return lines;
}

export function renderCoreThreadOpenLines(payload: CoreThreadOpenTextPayload): string[] {
  return [String((payload.thread as Record<string, unknown>).id)];
}

export function renderCoreThreadSendLines(payload: CoreThreadSendTextPayload): string[] {
  return [String((payload.message as Record<string, unknown>).id)];
}

export function renderCoreThreadMarkSeenLines(): string[] {
  return ["ok"];
}

export function renderCoreThreadStatusLines(payload: CoreThreadStatusTextPayload): string[] {
  const thread = payload.thread as Record<string, unknown>;
  return [`thread ${String(thread.id)}`, `status ${String(thread.status)}`];
}

export function renderCoreMessageSendLines(payload: CoreMessageSendTextPayload): string[] {
  const thread = payload.thread as Record<string, unknown>;
  const message = payload.message as Record<string, unknown>;
  const lines = [`thread ${String(thread.id)}`, `message ${String(message.id)}`];
  if (Array.isArray(payload.deliveredTo) && payload.deliveredTo.length > 0) {
    lines.push(`delivered ${payload.deliveredTo.join(",")}`);
  }
  return lines;
}

export function renderCoreHandoffSendLines(payload: CoreHandoffSendTextPayload): string[] {
  return renderCoreMessageSendLines(payload);
}

export function renderCoreHandoffMutationLines(payload: CoreHandoffMutationTextPayload): string[] {
  const thread = payload.thread as Record<string, unknown>;
  const message = payload.message as Record<string, unknown>;
  return [`thread ${String(thread.id)}`, `message ${String(message.id)}`];
}

export function renderCoreTaskListLines(payload: CoreTaskListTextPayload): string[] {
  const tasks = payload.tasks.filter((entry) => entry && typeof entry === "object") as Array<Record<string, unknown>>;
  if (tasks.length === 0) return ["No tasks found."];
  const lines: string[] = [];
  for (const task of tasks) {
    const target = task.assignedTo ?? task.assignee ?? task.tool ?? "unassigned";
    const thread = task.threadId ? ` thread=${String(task.threadId)}` : "";
    lines.push(
      `${String(task.id)}  ${String(task.type ?? "task")}  ${String(task.status)}  target=${String(target)}${thread}`,
    );
    lines.push(`  ${String(task.description ?? "")}`);
  }
  return lines;
}

export function renderCoreTaskShowLines(payload: CoreTaskShowTextPayload): string[] {
  const task = payload.task as Record<string, unknown>;
  const lines = [
    `${String(task.description ?? "")} (${String(task.type ?? "task")})`,
    `id: ${String(task.id)}`,
    `status: ${String(task.status)}`,
    `assignedBy: ${String(task.assignedBy)}`,
  ];
  if (task.assignedTo) lines.push(`assignedTo: ${String(task.assignedTo)}`);
  if (task.assignee) lines.push(`assignee: ${String(task.assignee)}`);
  if (task.tool) lines.push(`tool: ${String(task.tool)}`);
  if (task.threadId) lines.push(`thread: ${String(task.threadId)}`);
  if (task.reviewStatus) lines.push(`reviewStatus: ${String(task.reviewStatus)}`);
  if (task.reviewFeedback) lines.push(`reviewFeedback: ${String(task.reviewFeedback)}`);
  if (task.result) lines.push(`result: ${String(task.result)}`);
  if (task.error) lines.push(`error: ${String(task.error)}`);
  lines.push("", String(task.prompt ?? ""));
  return lines;
}

export function renderCoreTaskMutationLines(payload: CoreTaskMutationTextPayload): string[] {
  const task = payload.task as Record<string, unknown>;
  const thread =
    payload.thread && typeof payload.thread === "object" ? (payload.thread as Record<string, unknown>) : null;
  const lines = [`task ${String(task.id)}`];
  if (thread?.id) lines.push(`thread ${String(thread.id)}`);
  return lines;
}

export function renderCoreReviewRequestChangesLines(payload: CoreReviewRequestChangesTextPayload): string[] {
  const lines = renderCoreTaskMutationLines(payload);
  const followUpTask =
    payload.followUpTask && typeof payload.followUpTask === "object"
      ? (payload.followUpTask as Record<string, unknown>)
      : null;
  if (followUpTask?.id) lines.splice(1, 0, `follow-up ${String(followUpTask.id)}`);
  return lines;
}

function renderRelayAuthLines(relay: CoreRelaySnapshot): string[] {
  const status = relay.status ?? "unknown";
  const lines =
    status === "off"
      ? ["Remote access is enabled. The daemon will connect on next start."]
      : status === "connected" || status === "connecting" || status === "reconnecting"
        ? [`Remote access is enabled (connection: ${status}).`]
        : [`Remote access credentials were saved, but relay is ${status}.`];
  const lastError = relayLastError(relay);
  if (lastError) lines.push(`Last error: ${lastError}`);
  return lines;
}
