import type { TmuxRuntimeManager, TmuxTarget } from "./tmux-runtime-manager.js";

export function resolveLiveClientTty(
  tmux: TmuxRuntimeManager,
  currentClientSession?: string,
  preferredClientTty?: string,
): string | undefined {
  const normalizedTty = preferredClientTty?.trim();
  if (normalizedTty && tmux.findClientByTty(normalizedTty)) {
    return normalizedTty;
  }
  const normalizedSession = currentClientSession?.trim();
  if (!normalizedSession) return undefined;
  const liveClient = tmux.listClients().find((client) => client.sessionName === normalizedSession);
  return liveClient?.tty || undefined;
}

export function openTargetForClient(
  tmux: TmuxRuntimeManager,
  target: TmuxTarget,
  currentClientSession?: string,
  clientTty?: string,
): void {
  const liveClientTty =
    resolveLiveClientTty(tmux, currentClientSession, clientTty) ?? tmux.getAttachedClientForTarget(target)?.tty;
  if (liveClientTty) {
    tmux.switchClientToTarget(liveClientTty, target);
    tmux.refreshStatus();
    if (target.windowName.startsWith("dashboard")) {
      tmux.sendFocusIn(target);
    }
    return;
  }
  if (currentClientSession) {
    const linkedTarget = tmux.getTargetByWindowId(currentClientSession, target.windowId);
    if (linkedTarget) {
      tmux.switchClient(currentClientSession, linkedTarget.windowIndex);
      tmux.refreshStatus();
      if (linkedTarget.windowName.startsWith("dashboard")) {
        tmux.sendFocusIn(linkedTarget);
      }
      return;
    }
  }
  tmux.openTarget(target, { insideTmux: Boolean(currentClientSession) });
  tmux.refreshStatus();
}

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
