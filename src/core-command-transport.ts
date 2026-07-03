import { requestDaemonJson } from "./daemon-client.js";
import {
  CORE_API_ROUTES,
  type CoreCommandEnvelope,
  type CoreCommandName,
  type CoreCommandOk,
  type CoreCommandPayloadByName,
  type CoreCommandResponse,
} from "./core-command-contract.js";

export async function sendCoreCommand<TCommand extends CoreCommandName>(
  command: TCommand,
  payload?: CoreCommandPayloadByName[TCommand],
  options: { timeoutMs?: number } = {},
): Promise<CoreCommandOk<TCommand>> {
  const envelope: CoreCommandEnvelope<TCommand> = {
    command,
    payload,
  };
  const response = (await requestDaemonJson(CORE_API_ROUTES.commands, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
    timeoutMs: options.timeoutMs,
  })) as CoreCommandResponse<TCommand>;
  if (!response.ok) {
    throw new Error(response.error);
  }
  if (response.command !== command) {
    throw new Error(`core command response mismatch: expected ${command}, got ${response.command}`);
  }
  return response;
}
