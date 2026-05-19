import { waitForSessionExit } from "../dashboard/session-actions.js";
import { loadConfig } from "../config.js";
import { getSessionBackendSessionId } from "../metadata-store.js";
import { buildRolePreamble, isTeammateSession, loadTeamConfig, type SessionTeamMetadata } from "../team.js";

type SessionActionsHost = any;

function sessionStateFromRuntime(host: SessionActionsHost, runtime: any): any | undefined {
  if (!runtime?.id || !runtime?.command) return undefined;
  return {
    id: runtime.id,
    command: runtime.command,
    tool: runtime.command,
    toolConfigKey: host.sessionToolKeys?.get?.(runtime.id) ?? runtime.toolConfigKey ?? runtime.command,
    args: host.sessionOriginalArgs?.get?.(runtime.id) ?? runtime.args ?? [],
    lifecycle: "offline",
    createdAt: runtime.startTime ? new Date(runtime.startTime).toISOString() : runtime.createdAt,
    backendSessionId: runtime.backendSessionId ?? getSessionBackendSessionId(runtime.id),
    team: runtime.team,
    worktreePath: host.sessionWorktreePaths?.get?.(runtime.id) ?? runtime.worktreePath,
    label: host.getSessionLabel?.(runtime.id) ?? runtime.label,
    headline: host.deriveHeadline?.(runtime.id) ?? runtime.headline,
  };
}

function sessionStateFromActionSeed(seed: any): any | undefined {
  if (!seed?.id || !seed?.command) return undefined;
  const config = loadConfig();
  const toolConfigKey =
    typeof seed.toolConfigKey === "string"
      ? seed.toolConfigKey
      : (Object.entries(config.tools).find(([, tool]: any) => tool.command === seed.command)?.[0] ?? seed.command);
  const toolCfg = config.tools[toolConfigKey];
  if (!toolCfg) return undefined;
  return {
    id: seed.id,
    command: toolCfg.command ?? seed.command,
    tool: seed.command,
    toolConfigKey,
    args: Array.isArray(seed.args) ? seed.args : [...(toolCfg.args ?? [])],
    lifecycle: "offline",
    createdAt: seed.createdAt,
    backendSessionId:
      typeof seed.backendSessionId === "string"
        ? seed.backendSessionId
        : typeof seed.remoteBackendSessionId === "string"
          ? seed.remoteBackendSessionId
          : getSessionBackendSessionId(seed.id),
    team: seed.team,
    worktreePath: typeof seed.worktreePath === "string" ? seed.worktreePath : undefined,
    label: typeof seed.label === "string" ? seed.label : undefined,
    headline: typeof seed.headline === "string" ? seed.headline : undefined,
  };
}

function ensureOfflineSession(host: SessionActionsHost, session: any): void {
  if (!session?.id) return;
  const existingIndex = host.offlineSessions.findIndex((entry: any) => entry.id === session.id);
  if (existingIndex >= 0) {
    host.offlineSessions[existingIndex] = { ...host.offlineSessions[existingIndex], ...session, lifecycle: "offline" };
  } else {
    host.offlineSessions.push({ ...session, lifecycle: "offline" });
  }
}

function isRuntimeLive(host: SessionActionsHost, runtime: any): boolean {
  return typeof host.isSessionRuntimeLive === "function" ? host.isSessionRuntimeLive(runtime) : !runtime.exited;
}

function evictStaleRuntime(host: SessionActionsHost, runtime: any): void {
  if (typeof host.evictZombieSession === "function") {
    host.evictZombieSession(runtime);
    return;
  }
  const idx = host.sessions.indexOf(runtime);
  if (idx >= 0) {
    host.sessions.splice(idx, 1);
  }
  host.stoppingSessionIds?.delete?.(runtime.id);
  host.sessionTmuxTargets?.delete?.(runtime.id);
}

export async function forkAgent(
  host: SessionActionsHost,
  opts: {
    sourceSessionId: string;
    targetToolConfigKey: string;
    targetSessionId?: string;
    instruction?: string;
    targetWorktreePath?: string;
    open?: boolean;
    extraArgs?: string[];
  },
): Promise<{ sessionId: string; threadId: string }> {
  host.syncSessionsFromState();
  const result = await host.forkSessionFromSource(
    opts.sourceSessionId,
    opts.targetToolConfigKey,
    opts.targetSessionId,
    opts.instruction,
    opts.targetWorktreePath,
    opts.extraArgs ?? [],
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
    extraArgs?: string[];
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
  const targetWorktreePath = opts.targetWorktreePath === process.cwd() ? undefined : opts.targetWorktreePath;
  const transport = host.createSession(
    toolCfg.command,
    [...toolCfg.args, ...(opts.extraArgs ?? [])],
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

export async function createTeammateAgent(
  host: SessionActionsHost,
  opts: {
    parentSessionId: string;
    role?: string;
    label?: string;
    toolConfigKey?: string;
    targetSessionId?: string;
    targetWorktreePath?: string;
    open?: boolean;
    extraArgs?: string[];
    initialPrompt?: string;
    order?: number;
  },
): Promise<{ sessionId: string; parentSessionId: string; teamId: string; role?: string; label?: string }> {
  host.syncSessionsFromState();

  const parent = host.sessions.find((session: any) => session.id === opts.parentSessionId && !session.exited);
  if (!parent) {
    throw new Error(`Parent agent "${opts.parentSessionId}" is not running locally`);
  }
  if (isTeammateSession(parent)) {
    throw new Error(`Parent agent "${opts.parentSessionId}" is already a teammate`);
  }

  const config = loadConfig();
  const parentToolConfigKey = host.sessionToolKeys?.get?.(parent.id) ?? parent.toolConfigKey ?? parent.command;
  const toolConfigKey = opts.toolConfigKey ?? parentToolConfigKey ?? config.defaultTool;
  const toolCfg = config.tools[toolConfigKey];
  if (!toolCfg) {
    throw new Error(`Unknown tool config: ${toolConfigKey}`);
  }
  if (!toolCfg.enabled) {
    throw new Error(`Tool "${toolConfigKey}" is disabled`);
  }

  const role = opts.role?.trim() || loadTeamConfig().defaultRole;
  const teamId = `team-${parent.id}`;
  const siblings = [...(host.sessions ?? []), ...(host.offlineSessions ?? [])].filter(
    (session: any) => session.team?.teamId === teamId && session.team?.parentSessionId === parent.id,
  );
  const nextOrder =
    opts.order ??
    siblings.reduce((max: number, session: any) => Math.max(max, Number(session.team?.order ?? -1)), -1) + 1;
  const team: SessionTeamMetadata = {
    teamId,
    parentSessionId: parent.id,
    role,
    label: opts.label?.trim() || undefined,
    order: nextOrder,
  };

  const inheritedWorktreePath = host.sessionWorktreePaths?.get?.(parent.id) ?? parent.worktreePath;
  const targetWorktreePath = opts.targetWorktreePath ?? inheritedWorktreePath;
  const normalizedWorktreePath = targetWorktreePath === process.cwd() ? undefined : targetWorktreePath;
  const rolePreamble = buildRolePreamble(role, loadTeamConfig());
  const teammatePreamble = [
    `You are a teammate for aimux parent agent "${parent.id}".`,
    "Stay focused on delegated work and report findings back to the parent agent.",
    rolePreamble,
  ]
    .filter(Boolean)
    .join("\n\n");

  const transport = host.createSession(
    toolCfg.command,
    [...toolCfg.args, ...(opts.extraArgs ?? [])],
    toolCfg.preambleFlag,
    toolConfigKey,
    teammatePreamble,
    toolCfg.sessionIdFlag,
    normalizedWorktreePath,
    undefined,
    opts.targetSessionId,
    false,
    false,
    team,
  );

  if (team.label && typeof host.updateSessionLabel === "function") {
    await host.updateSessionLabel(transport.id, team.label);
  }

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

  if (opts.initialPrompt?.trim()) {
    if (typeof host.writeAgentInput !== "function") {
      throw new Error("Initial teammate prompt requires agent input support");
    }
    await host.writeAgentInput(transport.id, opts.initialPrompt.trim(), undefined, undefined, true);
  }

  return {
    sessionId: transport.id,
    parentSessionId: parent.id,
    teamId,
    role,
    label: team.label,
  };
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

  if (!isRuntimeLive(host, runningSession)) {
    const offlineSession = sessionStateFromRuntime(host, runningSession);
    evictStaleRuntime(host, runningSession);
    ensureOfflineSession(host, offlineSession);
    host.saveState();
    return { sessionId, status: "offline" };
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
  sessionSeed?: any,
): Promise<{
  sessionId: string;
  status: "graveyard";
  previousStatus: "running" | "offline";
}> {
  host.syncSessionsFromState();

  let previousStatus: "running" | "offline";
  let graveyardSeed: any | undefined;
  const runningSession = host.sessions.find((session: any) => session.id === sessionId);
  if (runningSession) {
    if (!isRuntimeLive(host, runningSession)) {
      const offlineSession = sessionStateFromRuntime(host, runningSession);
      graveyardSeed = offlineSession;
      evictStaleRuntime(host, runningSession);
      ensureOfflineSession(host, offlineSession);
      host.saveState();
      previousStatus = "offline";
    } else {
      previousStatus = "running";
      host.graveyardAfterStopSessionIds.add(sessionId);
      try {
        if (!host.stoppingSessionIds.has(sessionId)) {
          host.stopSessionToOffline(runningSession);
        }
        await waitForSessionExit(runningSession);
        host.saveState();
      } finally {
        host.graveyardAfterStopSessionIds.delete(sessionId);
      }
    }
  } else {
    const offlineSession =
      host.offlineSessions.find((session: any) => session.id === sessionId) ?? sessionStateFromActionSeed(sessionSeed);
    if (!offlineSession) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    graveyardSeed = offlineSession;
    ensureOfflineSession(host, offlineSession);
    previousStatus = "offline";
  }

  host.graveyardAfterStopSessionIds.delete(sessionId);
  host.graveyardSession(sessionId, graveyardSeed);
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
