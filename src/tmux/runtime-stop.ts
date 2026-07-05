import { persistProjectRuntimeSnapshotsBeforeTmuxStop } from "../multiplexer/service-state-snapshot.js";
import { TmuxRuntimeManager } from "./runtime-manager.js";
import { isTmuxClientSessionForHost } from "./session-names.js";

export function listManagedProjectSessionNames(tmux: TmuxRuntimeManager, projectRoot: string): string[] {
  const hostSession = tmux.getProjectSession(projectRoot).sessionName;
  return tmux
    .listSessionNames()
    .filter((sessionName) => sessionName === hostSession || isTmuxClientSessionForHost(sessionName, hostSession))
    .sort((a, b) => {
      const aIsHost = a === hostSession ? 1 : 0;
      const bIsHost = b === hostSession ? 1 : 0;
      return aIsHost - bIsHost;
    });
}

export function stopProjectTmuxRuntime(tmux: TmuxRuntimeManager, projectRoot: string): string[] {
  if (!tmux.isAvailable()) return [];
  persistProjectRuntimeSnapshotsBeforeTmuxStop(projectRoot, tmux);
  const killed: string[] = [];
  for (const sessionName of listManagedProjectSessionNames(tmux, projectRoot)) {
    if (!tmux.hasSession(sessionName)) continue;
    tmux.killSession(sessionName);
    killed.push(sessionName);
  }
  return killed;
}
