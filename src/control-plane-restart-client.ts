import { loadDaemonInfo, loadDaemonState } from "./daemon-state.js";
import { ensureDaemonRunning, stopDaemonInfo } from "./daemon-supervisor.js";
import { renderRuntimeRestartResult, restartAimuxControlPlane, type RuntimeRestartResult } from "./runtime-restart.js";

export interface CliControlPlaneRestartResult {
  restart: RuntimeRestartResult;
  text: string;
  source: "local-bootstrap";
}

export async function restartControlPlaneFromCli(projectRoot?: string): Promise<CliControlPlaneRestartResult> {
  const daemonBeforeRequest = loadDaemonInfo();
  const daemonStateBeforeRequest = loadDaemonState();
  const restart = await restartAimuxControlPlane({
    projectRoot,
    stopDaemon: daemonBeforeRequest ? () => stopDaemonInfo(daemonBeforeRequest, daemonStateBeforeRequest) : undefined,
    ensureDaemonRunning: () => ensureDaemonRunning({ adoptExisting: false }),
  });
  return {
    restart,
    text: renderRuntimeRestartResult(restart),
    source: "local-bootstrap",
  };
}
