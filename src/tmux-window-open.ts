import type { TmuxRuntimeManager, TmuxTarget } from "./tmux-runtime-manager.js";

export function selectLinkedOrOpenTarget(tmux: TmuxRuntimeManager, target: TmuxTarget): void {
  const insideTmux = tmux.isInsideTmux();
  if (insideTmux) {
    const currentClientSession = tmux.currentClientSession();
    if (currentClientSession) {
      const linkedTarget = tmux.getTargetByWindowId(currentClientSession, target.windowId);
      if (linkedTarget) {
        tmux.selectWindow(linkedTarget);
        return;
      }
    }
  }
  tmux.openTarget(target, { insideTmux });
}

export function openManagedSessionWindow(
  tmux: TmuxRuntimeManager,
  projectRoot: string,
  entry: { id: string; backendSessionId?: string },
): TmuxTarget | null {
  const tmuxSession = tmux.getProjectSession(projectRoot);
  const match = tmux.findManagedWindow(tmuxSession.sessionName, {
    sessionId: entry.id,
    backendSessionId: entry.backendSessionId,
  });
  if (!match) return null;
  selectLinkedOrOpenTarget(tmux, match.target);
  return match.target;
}

export function openManagedServiceWindow(
  tmux: TmuxRuntimeManager,
  projectRoot: string,
  serviceId: string,
): TmuxTarget | null {
  const tmuxSession = tmux.getProjectSession(projectRoot);
  const match = tmux.findManagedWindow(tmuxSession.sessionName, {
    sessionId: serviceId,
  });
  if (!match || match.metadata.kind !== "service") return null;
  selectLinkedOrOpenTarget(tmux, match.target);
  return match.target;
}
