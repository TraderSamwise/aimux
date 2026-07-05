import type { RelayStatusSnapshot } from "./relay-client.js";
import type { RuntimeRestartResult } from "./runtime-restart.js";

export const CORE_API_ROUTES = {
  commands: "/core/commands",
  daemonEnsureText: "/core/daemon-ensure-text",
  daemonProjectsText: "/core/daemon-projects-text",
  daemonStatusText: "/core/daemon-status-text",
  doctorTmuxText: "/core/doctor/tmux-text",
  doctorVersionsText: "/core/doctor/versions-text",
  hostAgentReadText: "/core/host-agent-read-text",
  hostAgentStreamText: "/core/host-agent-stream-text",
  hostStatusText: "/core/host-status-text",
  agentInputText: "/core/agents/input-text",
  agentMigrateText: "/core/agents/migrate-text",
  agentPsText: "/core/agents/ps-text",
  agentRenameText: "/core/agents/rename-text",
  lifecycleForkText: "/core/lifecycle/fork-text",
  lifecycleKillText: "/core/lifecycle/kill-text",
  lifecycleSpawnText: "/core/lifecycle/spawn-text",
  lifecycleStopText: "/core/lifecycle/stop-text",
  loopAddText: "/core/loop/add-text",
  loopBlockText: "/core/loop/block-text",
  loopDoneText: "/core/loop/done-text",
  loopRemoveText: "/core/loop/remove-text",
  handoffAcceptText: "/core/handoff/accept-text",
  handoffCompleteText: "/core/handoff/complete-text",
  handoffSendText: "/core/handoff/send-text",
  messageSendText: "/core/message/send-text",
  notificationClearText: "/core/notifications/clear-text",
  notificationListText: "/core/notifications/list-text",
  notificationReadText: "/core/notifications/read-text",
  notificationSendText: "/core/notifications/send-text",
  overseerClearText: "/core/overseer/clear-text",
  overseerStartText: "/core/overseer/start-text",
  teamAddText: "/core/team/add-text",
  teamDefaultText: "/core/team/default-text",
  teamInitText: "/core/team/init-text",
  teamRemoveText: "/core/team/remove-text",
  teamShowText: "/core/team/show-text",
  loginStartText: "/core/login-start-text",
  loginText: "/core/login-text",
  loginWaitText: "/core/login-wait-text",
  logsClearText: "/core/logs/clear-text",
  logsPathText: "/core/logs/path-text",
  logsTailText: "/core/logs/tail-text",
  metadataText: "/core/metadata-text",
  logoutText: "/core/logout-text",
  projectEnsureText: "/core/project-ensure-text",
  projectKillText: "/core/project-kill-text",
  projectRestartText: "/core/project-restart-text",
  projectServeText: "/core/project-serve-text",
  projectStopText: "/core/project-stop-text",
  projectsListText: "/core/projects-list-text",
  remoteDisableText: "/core/remote-disable-text",
  remoteEnableText: "/core/remote-enable-text",
  remoteStatusText: "/core/remote-status-text",
  repairText: "/core/repair-text",
  restartText: "/core/restart-text",
  securityUnlockStartText: "/core/security-unlock-start-text",
  securityUnlockText: "/core/security-unlock-text",
  securityUnlockWaitText: "/core/security-unlock-wait-text",
  reviewApproveText: "/core/review/approve-text",
  reviewRequestChangesText: "/core/review/request-changes-text",
  taskAcceptText: "/core/task/accept-text",
  taskAssignText: "/core/task/assign-text",
  taskBlockText: "/core/task/block-text",
  taskCompleteText: "/core/task/complete-text",
  taskListText: "/core/task/list-text",
  taskReopenText: "/core/task/reopen-text",
  taskShowText: "/core/task/show-text",
  whoamiText: "/core/whoami-text",
  graveyardCleanupText: "/core/graveyard/cleanup-text",
  graveyardListText: "/core/graveyard/list-text",
  graveyardResurrectText: "/core/graveyard/resurrect-text",
  graveyardSendText: "/core/graveyard/send-text",
  threadListText: "/core/thread/list-text",
  threadMarkSeenText: "/core/thread/mark-seen-text",
  threadOpenText: "/core/thread/open-text",
  threadSendText: "/core/thread/send-text",
  threadShowText: "/core/thread/show-text",
  threadStatusText: "/core/thread/status-text",
  threadsListText: "/core/threads/list-text",
  worktreeCreateText: "/core/worktree/create-text",
  worktreeDeleteGraveyardText: "/core/worktree/delete-graveyard-text",
  worktreeGraveyardText: "/core/worktree/graveyard-text",
  worktreeListText: "/core/worktree/list-text",
  worktreeRemoveText: "/core/worktree/remove-text",
  worktreeResurrectText: "/core/worktree/resurrect-text",
} as const;

export const CORE_COMMAND_NAMES = {
  ping: "core.ping",
  status: "core.status",
  projectsList: "core.projects.list",
  projectEnsure: "core.project.ensure",
  projectStop: "core.project.stop",
  projectKill: "core.project.kill",
  restart: "core.restart",
  relayStatus: "core.relay.status",
  relayEnable: "core.relay.enable",
  relayDisable: "core.relay.disable",
} as const;

export type CoreCommandName = (typeof CORE_COMMAND_NAMES)[keyof typeof CORE_COMMAND_NAMES];

export interface CoreCommandEnvelope<TCommand extends CoreCommandName = CoreCommandName> {
  id?: string;
  command: TCommand;
  payload?: CoreCommandPayloadByName[TCommand];
}

export interface CorePingResult {
  pong: true;
}

export interface CoreStatusProject {
  id: string;
  name: string;
  path: string;
  dashboardSessionName: string;
  service: unknown | null;
  serviceAlive: boolean;
  serviceEndpoint: unknown;
}

export type CoreRelaySnapshot = RelayStatusSnapshot | { status: "off" };

export interface CoreStatusResult {
  daemon: {
    pid: number;
    port: number;
    startedAt: string;
    updatedAt: string;
    serviceInfo: unknown;
  };
  projects: CoreStatusProject[];
  relay: CoreRelaySnapshot;
  updatedAt: string;
}

export interface CoreProjectPayload {
  projectRoot: string;
}

export interface CoreRestartPayload {
  projectRoot?: string;
}

export interface CoreProjectServiceState {
  projectId: string;
  projectRoot: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
}

export interface CoreProjectsListResult {
  projects: CoreStatusProject[];
}

export interface CoreProjectEnsureResult {
  project: CoreProjectServiceState;
}

export interface CoreProjectStopResult {
  project: CoreProjectServiceState | null;
}

export type CoreProjectKillResult = CoreProjectStopResult;

export interface CoreRelayResult {
  relay: CoreRelaySnapshot;
}

export interface CoreRestartResult {
  restart: RuntimeRestartResult;
  text: string;
}

export interface CoreCommandPayloadByName {
  [CORE_COMMAND_NAMES.ping]: undefined;
  [CORE_COMMAND_NAMES.status]: undefined;
  [CORE_COMMAND_NAMES.projectsList]: undefined;
  [CORE_COMMAND_NAMES.projectEnsure]: CoreProjectPayload;
  [CORE_COMMAND_NAMES.projectStop]: CoreProjectPayload;
  [CORE_COMMAND_NAMES.projectKill]: CoreProjectPayload;
  [CORE_COMMAND_NAMES.restart]: CoreRestartPayload | undefined;
  [CORE_COMMAND_NAMES.relayStatus]: undefined;
  [CORE_COMMAND_NAMES.relayEnable]: undefined;
  [CORE_COMMAND_NAMES.relayDisable]: undefined;
}

export interface CoreCommandResultByName {
  [CORE_COMMAND_NAMES.ping]: CorePingResult;
  [CORE_COMMAND_NAMES.status]: CoreStatusResult;
  [CORE_COMMAND_NAMES.projectsList]: CoreProjectsListResult;
  [CORE_COMMAND_NAMES.projectEnsure]: CoreProjectEnsureResult;
  [CORE_COMMAND_NAMES.projectStop]: CoreProjectStopResult;
  [CORE_COMMAND_NAMES.projectKill]: CoreProjectKillResult;
  [CORE_COMMAND_NAMES.restart]: CoreRestartResult;
  [CORE_COMMAND_NAMES.relayStatus]: CoreRelayResult;
  [CORE_COMMAND_NAMES.relayEnable]: CoreRelayResult;
  [CORE_COMMAND_NAMES.relayDisable]: CoreRelayResult;
}

export type CoreCommandOk<TCommand extends CoreCommandName = CoreCommandName> = {
  ok: true;
  id: string;
  command: TCommand;
  issuedAt: string;
  result: CoreCommandResultByName[TCommand];
};

export interface CoreCommandError {
  ok: false;
  id?: string;
  command?: string;
  error: string;
}

export type CoreCommandResponse<TCommand extends CoreCommandName = CoreCommandName> =
  | CoreCommandOk<TCommand>
  | CoreCommandError;

export function isCoreCommandName(value: unknown): value is CoreCommandName {
  return typeof value === "string" && Object.values(CORE_COMMAND_NAMES).includes(value as CoreCommandName);
}

export function assertNeverCoreCommand(command: never): never {
  throw new Error(`unhandled core command: ${command}`);
}
