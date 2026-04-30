import { waitForSessionExit } from "../dashboard/session-actions.js";
import { loadConfig } from "../config.js";
import { isToolAvailable } from "./tool-picker.js";

type SessionActionsHost = any;

export async function forkAgent(
  host: SessionActionsHost,
  opts: {
    sourceSessionId: string;
    targetToolConfigKey: string;
    targetSessionId?: string;
    instruction?: string;
    targetWorktreePath?: string;
    open?: boolean;
  },
): Promise<{ sessionId: string; threadId: string }> {
  host.syncSessionsFromState();
  const result = await host.forkSessionFromSource(
    opts.sourceSessionId,
    opts.targetToolConfigKey,
    opts.targetSessionId,
    opts.instruction,
    opts.targetWorktreePath,
  );
  if (!result) {
    throw new Error(`Unable to fork session ${opts.sourceSessionId}`);
  }
  if (opts.open !== false && result.target) {
    const openResult =
      typeof host.waitAndOpenLiveTmuxWindowForEntry === "function"
        ? await host.waitAndOpenLiveTmuxWindowForEntry({ id: result.sessionId })
        : host.openLiveTmuxWindowForEntry({ id: result.sessionId });
    if (openResult === "missing") {
      host.tmuxRuntimeManager.openTarget(result.target, { insideTmux: host.tmuxRuntimeManager.isInsideTmux() });
    }
  }
  return {
    sessionId: result.sessionId,
    threadId: result.threadId,
  };
}

export async function spawnAgent(
  host: SessionActionsHost,
  opts: {
    toolConfigKey: string;
    targetSessionId?: string;
    targetWorktreePath?: string;
    open?: boolean;
  },
): Promise<{ sessionId: string }> {
  host.syncSessionsFromState();

  const config = loadConfig();
  const toolCfg = config.tools[opts.toolConfigKey];
  if (!toolCfg) {
    throw new Error(`Unknown tool config: ${opts.toolConfigKey}`);
  }
  if (!toolCfg.enabled) {
    throw new Error(`Tool "${opts.toolConfigKey}" is disabled`);
  }
  if (!isToolAvailable(toolCfg.command)) {
    throw new Error(`Tool "${toolCfg.command}" is not installed or not on PATH`);
  }

  const targetWorktreePath = opts.targetWorktreePath === process.cwd() ? undefined : opts.targetWorktreePath;
  const transport = host.createSession(
    toolCfg.command,
    toolCfg.args,
    toolCfg.preambleFlag,
    opts.toolConfigKey,
    undefined,
    toolCfg.sessionIdFlag,
    targetWorktreePath,
    undefined,
    opts.targetSessionId,
  );

  const target = host.sessionTmuxTargets.get(transport.id);
  if (opts.open !== false && target) {
    const openResult =
      typeof host.waitAndOpenLiveTmuxWindowForEntry === "function"
        ? await host.waitAndOpenLiveTmuxWindowForEntry({ id: transport.id })
        : host.openLiveTmuxWindowForEntry({ id: transport.id });
    if (openResult === "missing") {
      host.tmuxRuntimeManager.openTarget(target, { insideTmux: host.tmuxRuntimeManager.isInsideTmux() });
    }
  }

  return { sessionId: transport.id };
}

export async function renameAgent(
  host: SessionActionsHost,
  sessionId: string,
  label?: string,
): Promise<{ sessionId: string; label?: string }> {
  host.syncSessionsFromState();

  const runningSession = host.sessions.find((session: any) => session.id === sessionId);
  const offlineSession = host.offlineSessions.find((session: any) => session.id === sessionId);
  if (!runningSession && !offlineSession) {
    throw new Error(`Session "${sessionId}" not found`);
  }

  await host.updateSessionLabel(sessionId, label);
  return { sessionId, label: host.getSessionLabel(sessionId) };
}

export async function stopAgent(
  host: SessionActionsHost,
  sessionId: string,
): Promise<{ sessionId: string; status: "offline" }> {
  host.syncSessionsFromState();

  const runningSession = host.sessions.find((session: any) => session.id === sessionId);
  if (!runningSession) {
    const offlineSession = host.offlineSessions.find((session: any) => session.id === sessionId);
    if (offlineSession) {
      return { sessionId, status: "offline" };
    }
    throw new Error(`Session "${sessionId}" not found`);
  }

  if (!host.stoppingSessionIds.has(sessionId)) {
    host.stopSessionToOffline(runningSession);
  }
  await waitForSessionExit(runningSession);
  host.saveState();

  return { sessionId, status: "offline" };
}

export async function sendAgentToGraveyard(
  host: SessionActionsHost,
  sessionId: string,
): Promise<{
  sessionId: string;
  status: "graveyard";
  previousStatus: "running" | "offline";
}> {
  host.syncSessionsFromState();

  let previousStatus: "running" | "offline";
  const runningSession = host.sessions.find((session: any) => session.id === sessionId);
  if (runningSession) {
    previousStatus = "running";
    host.graveyardAfterStopSessionIds.add(sessionId);
    if (!host.stoppingSessionIds.has(sessionId)) {
      host.stopSessionToOffline(runningSession);
    }
    await waitForSessionExit(runningSession);
    host.saveState();
  } else {
    const offlineSession = host.offlineSessions.find((session: any) => session.id === sessionId);
    if (!offlineSession) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    previousStatus = "offline";
  }

  host.graveyardAfterStopSessionIds.delete(sessionId);
  host.graveyardSession(sessionId);
  return { sessionId, status: "graveyard", previousStatus };
}

export async function migrateAgentSession(
  host: SessionActionsHost,
  sessionId: string,
  targetWorktreePath: string,
): Promise<{ sessionId: string; worktreePath?: string }> {
  host.syncSessionsFromState();

  const runningSession = host.sessions.find((session: any) => session.id === sessionId);
  if (!runningSession) {
    const offlineSession = host.offlineSessions.find((session: any) => session.id === sessionId);
    if (offlineSession) {
      throw new Error(`Session "${sessionId}" is offline and cannot be migrated`);
    }
    throw new Error(`Session "${sessionId}" not found`);
  }

  await host.migrateAgent(sessionId, targetWorktreePath);
  await waitForSessionExit(runningSession);
  return { sessionId, worktreePath: host.getSessionWorktreePath(sessionId) };
}
