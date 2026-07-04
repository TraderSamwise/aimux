import { requestCoreCommand } from "./core-command-client.js";
import { CORE_COMMAND_NAMES } from "./core-command-contract.js";
import { renderRuntimeRestartResult, restartAimuxControlPlane, type RuntimeRestartResult } from "./runtime-restart.js";

export interface CliControlPlaneRestartResult {
  restart: RuntimeRestartResult;
  text: string;
  source: "daemon" | "local-bootstrap";
}

function needsLocalBootstrap(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /different local build|does not match this Aimux build/i.test(message);
}

export async function restartControlPlaneFromCli(projectRoot?: string): Promise<CliControlPlaneRestartResult> {
  try {
    const response = await requestCoreCommand(CORE_COMMAND_NAMES.restart, projectRoot ? { projectRoot } : undefined);
    return {
      restart: response.result.restart,
      text: response.result.text,
      source: "daemon",
    };
  } catch (error) {
    if (!needsLocalBootstrap(error)) throw error;
    const restart = await restartAimuxControlPlane({ projectRoot });
    return {
      restart,
      text: renderRuntimeRestartResult(restart),
      source: "local-bootstrap",
    };
  }
}
