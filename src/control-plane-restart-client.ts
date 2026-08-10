import { loadDaemonInfo, loadDaemonState } from "./daemon-state.js";
import { assertNotStoppingNewerDaemon, ensureDaemonRunning, stopDaemonInfo } from "./daemon-supervisor.js";
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
    reason: "cli",
    projectRoot,
    // Guarded like stopDaemon itself. Supplying a stopDaemon of our own skipped
    // the stale-build check entirely, which is the one bypass that let an older
    // client keep replacing a newer daemon.
    stopDaemon: daemonBeforeRequest
      ? async () => {
          await assertNotStoppingNewerDaemon();
          return stopDaemonInfo(daemonBeforeRequest, daemonStateBeforeRequest);
        }
      : undefined,
    ensureDaemonRunning: () => ensureDaemonRunning({ adoptExisting: false }),
  });
  return {
    restart,
    text: renderRuntimeRestartResult(restart),
    source: "local-bootstrap",
  };
}
