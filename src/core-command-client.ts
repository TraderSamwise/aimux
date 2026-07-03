import { ensureDaemonRunning } from "./daemon-supervisor.js";
import { type CoreCommandName, type CoreCommandOk, type CoreCommandPayloadByName } from "./core-command-contract.js";
import { sendCoreCommand } from "./core-command-transport.js";

export async function requestCoreCommand<TCommand extends CoreCommandName>(
  command: TCommand,
  payload?: CoreCommandPayloadByName[TCommand],
  options: { timeoutMs?: number; ensureDaemon?: boolean } = {},
): Promise<CoreCommandOk<TCommand>> {
  if (options.ensureDaemon !== false) {
    await ensureDaemonRunning();
  }
  return sendCoreCommand(command, payload, { timeoutMs: options.timeoutMs });
}
