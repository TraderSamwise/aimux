export const CORE_API_ROUTES = {
  commands: "/core/commands",
} as const;

export const CORE_COMMAND_NAMES = {
  ping: "core.ping",
  status: "core.status",
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

export interface CoreStatusResult {
  daemon: {
    pid: number;
    port: number;
    serviceInfo: unknown;
  };
  projects: unknown[];
  updatedAt: string;
}

export interface CoreCommandPayloadByName {
  [CORE_COMMAND_NAMES.ping]: undefined;
  [CORE_COMMAND_NAMES.status]: undefined;
}

export interface CoreCommandResultByName {
  [CORE_COMMAND_NAMES.ping]: CorePingResult;
  [CORE_COMMAND_NAMES.status]: CoreStatusResult;
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
