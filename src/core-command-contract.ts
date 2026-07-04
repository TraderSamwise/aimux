import type { RelayStatusSnapshot } from "./relay-client.js";
import type { RuntimeRestartResult } from "./runtime-restart.js";

export const CORE_API_ROUTES = {
  commands: "/core/commands",
  restartText: "/core/restart-text",
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
