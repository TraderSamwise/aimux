import { randomUUID } from "node:crypto";

import { initProject, loadConfig } from "../config.js";
import { buildContextPreamble, captureGitContext } from "../context/context-bridge.js";
import { readHistory } from "../context/history.js";
import { findMainRepo } from "../worktree.js";
import { TmuxSessionTransport } from "../tmux/session-transport.js";
import { injectClaudeHookArgs } from "../claude-hooks.js";
import { wrapCommandWithShellIntegration } from "../shell-hooks.js";
import { loadMetadataState } from "../metadata-store.js";
import { debug } from "../debug.js";
import { parseKeys } from "../key-parser.js";
import { updateNotificationContext } from "../notification-context.js";
import { markNotificationsRead } from "../notifications.js";

type SessionLaunchHost = any;

export async function run(host: SessionLaunchHost, opts: { command: string; args: string[] }): Promise<number> {
  initProject();
  await host.instanceDirectory.registerInstance(host.instanceId, process.cwd());
  host.startHeartbeat();
  host.syncSessionsFromState();
  host.taskDispatcher = host.createTaskDispatcher();
  host.orchestrationDispatcher = host.createOrchestrationDispatcher();
  host.defaultCommand = opts.command;
  host.defaultArgs = opts.args;

  const config = loadConfig();
  const toolEntry = Object.entries(config.tools).find(([, t]) => t.command === opts.command);
  const toolConfig = toolEntry?.[1];
  const toolConfigKey = toolEntry?.[0];

  host.writeInstructionFiles();
  host.createSession(
    opts.command,
    opts.args,
    toolConfig?.preambleFlag,
    toolConfigKey,
    undefined,
    toolConfig?.sessionIdFlag,
  );

  host.focusSession(host.sessions.length - 1);
  return 0;
}

export async function runDashboard(host: SessionLaunchHost): Promise<number> {
  initProject();
  await host.instanceDirectory.registerInstance(host.instanceId, process.cwd());
  host.startHeartbeat();
  host.startedInDashboard = true;
  host.mode = "dashboard";
  host.syncSessionsFromState();

  const config = loadConfig();
  const defaultTool = config.tools[config.defaultTool];
  if (defaultTool) {
    host.defaultCommand = defaultTool.command;
    host.defaultArgs = defaultTool.args;
  }

  host.writeInstructionFiles();
  host.terminalHost.enterRawMode();

  host.onStdinData = (data: Buffer) => {
    if (host.isFocusInReport(data)) {
      host.handleDashboardFocusIn();
      return;
    }
    if (host.handleActiveDashboardOverlayKey(data)) {
      return;
    }
    if (host.isDashboardScreen("activity")) {
      host.handleActivityKey(data);
      return;
    }
    if (host.isDashboardScreen("workflow")) {
      host.handleWorkflowKey(data);
      return;
    }
    if (host.isDashboardScreen("threads")) {
      host.handleThreadsKey(data);
      return;
    }
    if (host.isDashboardScreen("plans")) {
      host.handlePlansKey(data);
      return;
    }
    if (host.isDashboardScreen("help")) {
      host.handleHelpKey(data);
      return;
    }
    if (host.isDashboardScreen("graveyard")) {
      host.handleGraveyardKey(data);
      return;
    }

    if (host.mode === "dashboard") {
      host.handleDashboardKey(data);
    }
  };
  process.stdin.on("data", host.onStdinData);

  host.onResize = () => {
    host.renderCurrentDashboardView();
  };
  process.stdout.on("resize", host.onResize);

  host.mode = "dashboard";
  host.loadDashboardUiState();
  const primed = await host.refreshDashboardModelFromService(true);
  if (!primed) {
    throw new Error("dashboard requires a live project service desktop-state endpoint");
  }
  host.terminalHost.enterAlternateScreen(true);
  host.startStatusRefresh();
  host.renderDashboard();

  const exitCode = await new Promise<number>((resolve) => {
    host.resolveRun = resolve;
  });

  host.teardown();
  return exitCode;
}

export async function runProjectService(host: SessionLaunchHost): Promise<number> {
  initProject();
  host.mode = "project-service";
  host.syncSessionsFromState();
  host.taskDispatcher = host.createTaskDispatcher();
  host.orchestrationDispatcher = host.createOrchestrationDispatcher();
  host.writeInstructionFiles();
  await host.startProjectServices();
  host.refreshDesktopStateSnapshot();
  host.writeStatuslineFile();
  host.startStatusRefresh();
  host.startProjectServiceRefresh();

  const exitCode = await new Promise<number>((resolve) => {
    host.resolveRun = resolve;
  });

  host.teardown();
  return exitCode;
}

export async function resumeSessions(host: SessionLaunchHost, toolFilter?: string): Promise<number> {
  initProject();
  await host.instanceDirectory.registerInstance(host.instanceId, process.cwd());
  host.startHeartbeat();
  const state = host.constructor.loadState();
  if (!state || state.sessions.length === 0) {
    console.error("No saved session state found (or state is stale). Starting fresh.");
    return host.runDashboard();
  }

  const config = loadConfig();
  const sessionsToResume = toolFilter
    ? state.sessions.filter((s: any) => s.tool === toolFilter || s.toolConfigKey === toolFilter)
    : state.sessions;

  if (sessionsToResume.length === 0) {
    console.error(`No saved sessions found for tool "${toolFilter}". Starting fresh.`);
    return host.runDashboard();
  }

  const ownedByOthers = host.getRemoteOwnedSessionKeys();

  for (const saved of sessionsToResume) {
    if (ownedByOthers.has(saved.id) || (saved.backendSessionId && ownedByOthers.has(saved.backendSessionId))) {
      debug(`skipping resume of ${saved.id} — owned by another instance`, "session");
      continue;
    }

    const toolCfg = config.tools[saved.toolConfigKey];
    if (!toolCfg) continue;

    const bsid = saved.backendSessionId;
    let resumeArgs: string[];
    if (host.sessionBootstrap.canResumeWithBackendSessionId(toolCfg, bsid)) {
      resumeArgs = toolCfg.resumeArgs!.map((a: string) => a.replace("{sessionId}", bsid!));
    } else {
      resumeArgs = toolCfg.resumeFallback ?? [];
    }
    const args = host.sessionBootstrap.composeToolArgs(toolCfg, resumeArgs, saved.args);
    debug(`resuming ${saved.command} with backendSessionId=${bsid ?? "none (fallback)"}`, "session");
    host.createSession(
      saved.command,
      args,
      toolCfg.preambleFlag,
      saved.toolConfigKey,
      undefined,
      undefined,
      saved.worktreePath,
      saved.backendSessionId,
    );
  }

  host.openTmuxDashboardTarget();
  return 0;
}

export async function restoreSessions(host: SessionLaunchHost, toolFilter?: string): Promise<number> {
  initProject();
  const state = host.constructor.loadState();
  if (!state || state.sessions.length === 0) {
    console.error("No saved session state found (or state is stale). Starting fresh.");
    return host.runDashboard();
  }

  const config = loadConfig();
  const sessionsToRestore = toolFilter
    ? state.sessions.filter((s: any) => s.tool === toolFilter || s.toolConfigKey === toolFilter)
    : state.sessions;

  if (sessionsToRestore.length === 0) {
    console.error(`No saved sessions found for tool "${toolFilter}". Starting fresh.`);
    return host.runDashboard();
  }

  for (const saved of sessionsToRestore) {
    const toolCfg = config.tools[saved.toolConfigKey];
    if (!toolCfg) continue;

    const turns = readHistory(saved.id, { lastN: 20 });
    let historyContext = "";
    if (turns.length > 0) {
      const formattedTurns = turns.map((t: any) => {
        const time = t.ts.slice(0, 16);
        if (t.type === "prompt") return `[${time}] User: ${t.content}`;
        if (t.type === "response") return `[${time}] Agent: ${t.content}`;
        if (t.type === "git") return `[${time}] Git: ${t.content}${t.files ? ` (${t.files.join(", ")})` : ""}`;
        return `[${time}] ${t.content}`;
      });
      historyContext =
        "\n\n=== Your previous session context ===\n" +
        "You were previously working in this codebase. Here's what happened:\n" +
        formattedTurns.join("\n") +
        "\n=== End previous context ===\n";
    }

    const liveContext = buildContextPreamble(
      sessionsToRestore.filter((s: any) => s.id !== saved.id).map((s: any) => s.id),
    );
    const extraPreamble = historyContext + (liveContext ? "\n" + liveContext : "");

    host.createSession(
      saved.command,
      saved.args,
      toolCfg.preambleFlag,
      saved.toolConfigKey,
      extraPreamble.trim() || undefined,
      undefined,
      saved.worktreePath,
    );
  }

  host.openTmuxDashboardTarget();
  return 0;
}

export function createSession(
  host: SessionLaunchHost,
  command: string,
  args: string[],
  preambleFlag?: string[],
  toolConfigKey?: string,
  extraPreamble?: string,
  sessionIdFlag?: string[],
  worktreePath?: string,
  backendSessionIdOverride?: string,
  sessionIdOverride?: string,
  detachedInTmux = false,
): any {
  const cols = process.stdout.columns ?? 80;
  const sessionId = sessionIdOverride ?? `${command}-${Math.random().toString(36).slice(2, 8)}`;
  const backendSessionId = backendSessionIdOverride ?? (sessionIdFlag ? randomUUID() : undefined);

  const preamble = host.sessionBootstrap.buildSessionPreamble({
    sessionId,
    command,
    worktreePath,
    extraPreamble,
  });

  host.sessionBootstrap.ensurePlanFile(sessionId, command, worktreePath);

  let finalArgs = preambleFlag ? [...args, ...preambleFlag, preamble] : [...args];
  let launchCommand = command;

  if (sessionIdFlag && backendSessionId) {
    const expandedFlag = sessionIdFlag.map((a) => a.replace("{sessionId}", backendSessionId));
    finalArgs = [...finalArgs, ...expandedFlag];
  }

  const toolCfg = toolConfigKey ? loadConfig().tools[toolConfigKey] : undefined;
  let projectRoot = process.cwd();
  try {
    projectRoot = findMainRepo(worktreePath ?? process.cwd());
  } catch {
    projectRoot = process.cwd();
  }

  if (toolCfg && toolConfigKey === "claude" && toolCfg.command === command && toolCfg.wrapperEnabled !== false) {
    finalArgs = injectClaudeHookArgs(finalArgs, {
      sessionId,
      projectRoot,
      backendSessionId,
    });
    launchCommand = toolCfg.command;
  } else if (toolCfg && toolCfg.command === command) {
    const wrapped = wrapCommandWithShellIntegration({
      projectRoot,
      sessionId,
      tool: toolConfigKey ?? command,
      command: launchCommand,
      args: finalArgs,
    });
    launchCommand = wrapped.command;
    finalArgs = wrapped.args;
  }

  if (preambleFlag) {
    host.sessionBootstrap.finalizePreamble(command, preamble);
  }
  debug(
    `creating session: ${command} (configKey=${toolConfigKey ?? "cli"}, backendId=${backendSessionId ?? "none"}, cwd=${worktreePath ?? process.cwd()}, args=${finalArgs.length})`,
    "session",
  );
  debug(
    `spawn args: ${JSON.stringify(finalArgs.map((a) => (a.length > 100 ? a.slice(0, 100) + "..." : a)))}`,
    "session",
  );

  const sessionStartTime = Date.now();
  const tmuxSession = host.tmuxRuntimeManager.ensureProjectSession(process.cwd());
  const target = host.tmuxRuntimeManager.createWindow(
    tmuxSession.sessionName,
    host.getSessionLabel(sessionId) ?? command,
    worktreePath ?? process.cwd(),
    launchCommand,
    finalArgs,
    { detached: detachedInTmux },
  );
  const tmuxTransport = new TmuxSessionTransport(
    sessionId,
    command,
    target,
    host.tmuxRuntimeManager,
    cols,
    process.stdout.rows ?? 24,
  );
  host.sessionTmuxTargets.set(sessionId, target);
  const session = tmuxTransport;
  host.registerManagedSession(tmuxTransport, args, toolConfigKey, worktreePath, undefined, sessionStartTime);

  session.backendSessionId = backendSessionId;
  if (session instanceof TmuxSessionTransport) {
    host.syncTmuxWindowMetadata(sessionId);
  }

  host.activeIndex = host.sessions.length - 1;
  if (host.startedInDashboard && host.mode === "dashboard") {
    host.invalidateDesktopStateSnapshot();
    host.refreshLocalDashboardModel();
    host.updateWorktreeSessions();
    host.preferDashboardEntrySelection("session", sessionId, worktreePath);
    host.renderDashboard();
  }

  host.saveState();
  return session;
}

export async function migrateAgent(
  host: SessionLaunchHost,
  sessionId: string,
  targetWorktreePath: string,
): Promise<void> {
  const session = host.sessions.find((s: any) => s.id === sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found`);
  }

  const sourceWorktree = host.sessionWorktreePaths.get(sessionId);
  const sourceCwd = sourceWorktree ?? process.cwd();
  const toolConfigKey = host.sessionToolKeys.get(sessionId) ?? session.command;
  const config = loadConfig();
  const toolCfg = config.tools[toolConfigKey];
  const originalArgs = host.sessionOriginalArgs.get(sessionId) ?? [];

  const backendSessionId = session.backendSessionId as string | undefined;
  let migrateArgs = originalArgs;
  let historyContext = "";
  const useBackendResume = host.sessionBootstrap.canResumeWithBackendSessionId(toolCfg, backendSessionId);
  await host.contextWatcher.syncNow(sessionId).catch(() => {});
  const sourceSnapshot = host.sessionBootstrap.readForkSourceSnapshot(sessionId);

  if (useBackendResume) {
    migrateArgs = host.sessionBootstrap.composeToolArgs(
      toolCfg,
      toolCfg!.resumeArgs!.map((arg: string) => arg.replace("{sessionId}", backendSessionId!)),
      originalArgs,
    );
  } else if (sourceSnapshot.historyText) {
    historyContext =
      "\n\n=== Your previous session context ===\n" +
      "You were previously working in a different worktree. Here's what happened:\n" +
      sourceSnapshot.historyText +
      "\n=== End previous context ===\n";
  } else if (sourceSnapshot.liveText) {
    historyContext =
      "\n\n=== Your previous session context ===\n" +
      "You were previously working in a different worktree. Here's the most recent terminal context:\n" +
      sourceSnapshot.liveText +
      "\n=== End previous context ===\n";
  }

  debug(`migrating session ${sessionId} from ${sourceCwd} to ${targetWorktreePath}`, "session");
  session.kill();

  const effectiveTarget = targetWorktreePath === process.cwd() ? undefined : targetWorktreePath;
  createSession(
    host,
    session.command,
    migrateArgs,
    useBackendResume ? undefined : toolCfg?.preambleFlag,
    toolConfigKey,
    historyContext.trim() || undefined,
    useBackendResume ? undefined : toolCfg?.sessionIdFlag,
    effectiveTarget,
    backendSessionId,
    sessionId,
  );
}

export function getSessionWorktreePath(host: SessionLaunchHost, sessionId: string): string | undefined {
  return host.sessionWorktreePaths.get(sessionId);
}

export function getSessionsByWorktree(host: SessionLaunchHost): Map<string | undefined, any[]> {
  const groups = new Map<string | undefined, any[]>();
  for (const session of host.sessions) {
    const wtPath = host.sessionWorktreePaths.get(session.id);
    const group = groups.get(wtPath) ?? [];
    group.push(session);
    groups.set(wtPath, group);
  }
  return groups;
}

export function getScopedSessionEntries(host: SessionLaunchHost): Array<{ session: any; index: number }> {
  return host.sessions.map((session: any, index: number) => ({ session, index }));
}

export function focusSession(host: SessionLaunchHost, index: number): void {
  if (index < 0 || index >= host.sessions.length) return;

  host.activeIndex = index;
  const sid = host.sessions[index].id;
  host.sessionMRU = [sid, ...host.sessionMRU.filter((id: string) => id !== sid)];
  host.agentTracker.markSeen(sid);
  updateNotificationContext("tui", {
    focused: true,
    sessionId: sid,
    panelOpen: false,
  });
  host.noteLastUsedItem(sid);
  markNotificationsRead({ sessionId: sid });
  host.syncTuiNotificationContext(false);
  const target = host.sessionTmuxTargets.get(sid);
  if (target) {
    host.saveState();
    host.selectLinkedOrOpenTarget(target);
  }
}

export function handleAction(host: SessionLaunchHost, action: any): void {
  switch (action.type) {
    case "dashboard":
      host.openTmuxDashboardTarget();
      break;
    case "help":
      host.showHelp();
      break;
    case "focus":
      if (action.index < host.getScopedSessionEntries().length) {
        host.focusSession(host.getScopedSessionEntries()[action.index].index);
      }
      break;
    case "next":
      if (host.getScopedSessionEntries().length > 1) {
        const scoped = host.getScopedSessionEntries();
        const currentPos = scoped.findIndex(({ index }: { index: number }) => index === host.activeIndex);
        if (currentPos >= 0) {
          host.focusSession(scoped[(currentPos + 1) % scoped.length].index);
        }
      }
      break;
    case "prev":
      if (host.getScopedSessionEntries().length > 1) {
        const scoped = host.getScopedSessionEntries();
        const currentPos = scoped.findIndex(({ index }: { index: number }) => index === host.activeIndex);
        if (currentPos >= 0) {
          host.focusSession(scoped[(currentPos - 1 + scoped.length) % scoped.length].index);
        }
      }
      break;
    case "create":
      host.showToolPicker();
      break;
    case "kill":
      if (host.sessions.length > 0) {
        host.sessions[host.activeIndex].kill();
      }
      break;
    case "switcher":
      if (host.getScopedSessionEntries().length > 1) {
        host.showSwitcher();
      }
      break;
    case "worktree-create":
      host.showWorktreeCreatePrompt();
      break;
    case "worktree-list":
      host.showWorktreeList();
      break;
    case "review":
      host.handleReviewRequest();
      break;
  }
}
