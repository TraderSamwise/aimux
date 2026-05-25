import { randomUUID } from "node:crypto";

import { initProject, loadConfig, type SessionCaptureConfig } from "../config.js";
import { buildContextPreamble } from "../context/context-bridge.js";
import { readHistory } from "../context/history.js";
import { findMainRepo } from "../worktree.js";
import { TmuxSessionTransport } from "../tmux/session-transport.js";
import {
  extractClaudeBackendSessionIdFromArgs,
  injectClaudeHookArgs,
  shouldSkipClaudeSessionIdInjection,
} from "../claude-hooks.js";
import { wrapCommandWithManagedLaunchEnv } from "../managed-launch-env.js";
import { wrapCommandWithShellIntegration } from "../shell-hooks.js";
import { debug, log } from "../debug.js";
import { updateNotificationContext } from "../notification-context.js";
import { markNotificationsRead } from "../notifications.js";
import {
  clearSessionTranscriptPath,
  loadMetadataState,
  recordSessionBackendSessionIdMetadata,
} from "../metadata-store.js";
import type { SessionTeamMetadata } from "../team.js";
import { captureBackendSessionIdFromSessionFiles, extractCodexBackendSessionIdFromArgs } from "./session-capture.js";
import { listTopologySessionStates } from "../runtime-core/topology-sessions.js";
export { captureBackendSessionIdFromSessionFiles } from "./session-capture.js";

type SessionLaunchHost = any;

function listLaunchableTopologySessions(toolFilter?: string): any[] {
  const sessions = listTopologySessionStates({ statuses: ["running", "idle", "offline"] });
  return toolFilter ? sessions.filter((s: any) => s.tool === toolFilter || s.toolConfigKey === toolFilter) : sessions;
}

const CODEX_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "--add-dir",
  "--ask-for-approval",
  "-c",
  "--cd",
  "--config",
  "-i",
  "--image",
  "--local-provider",
  "-m",
  "--model",
  "-p",
  "--profile",
  "--remote",
  "--remote-auth-token-env",
  "-s",
  "--sandbox",
]);

const SENSITIVE_ENV_ARG_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL|AUTH)[A-Za-z0-9_]*=/i;
const SENSITIVE_OPTION_ARG_PATTERN =
  /^--?[A-Za-z0-9-]*(?:token|secret|password|pass|key|credential|auth)[A-Za-z0-9-]*(?:=.*)?$/i;
const SENSITIVE_OPTION_ASSIGNMENT_PATTERN =
  /^(--?[A-Za-z0-9-]*(?:token|secret|password|pass|key|credential|auth)[A-Za-z0-9-]*=).+/i;

function summarizeLaunchArg(arg: string): string {
  const sensitiveOptionAssignment = arg.match(SENSITIVE_OPTION_ASSIGNMENT_PATTERN);
  if (sensitiveOptionAssignment) {
    return `${sensitiveOptionAssignment[1]}<redacted>`;
  }
  if (SENSITIVE_ENV_ARG_PATTERN.test(arg)) {
    return `${arg.slice(0, arg.indexOf("=") + 1)}<redacted>`;
  }
  return arg.length > 100 ? `${arg.slice(0, 100)}...` : arg;
}

export function summarizeLaunchArgs(args: string[]): string[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    const summarized = summarizeLaunchArg(arg);
    redactNext = SENSITIVE_OPTION_ARG_PATTERN.test(arg) && !arg.includes("=");
    return summarized;
  });
}

function scheduleBackendSessionCapture(input: {
  host: SessionLaunchHost;
  sessionId: string;
  projectRoot: string;
  capture?: SessionCaptureConfig;
  startedAtMs: number;
}): void {
  if (!input.capture) return;
  const delayMs = Math.max(0, input.capture.delayMs ?? 0);
  const maxWaitMs = Math.max(delayMs, 60_000);
  const deadlineMs = input.startedAtMs + maxWaitMs;
  const attempt = () => {
    const backendSessionId = captureBackendSessionIdFromSessionFiles(input.capture!, input.sessionId, {
      startedAtMs: input.startedAtMs,
    });
    if (!backendSessionId) {
      if (Date.now() < deadlineMs) {
        const retry = setTimeout(attempt, 1000);
        retry.unref?.();
        return;
      }
      log.warn("session capture did not find exact backend id", "session", { sessionId: input.sessionId });
      return;
    }

    try {
      if (typeof input.host.recordSessionBackendSessionId === "function") {
        input.host.recordSessionBackendSessionId(input.sessionId, backendSessionId);
      } else {
        recordSessionBackendSessionIdMetadata(input.sessionId, backendSessionId, input.projectRoot);
      }
      log.info("captured backend id", "session", {
        sessionId: input.sessionId,
        backendSessionId,
      });
    } catch (error) {
      log.warn("failed to record captured backend id", "session", {
        sessionId: input.sessionId,
        backendSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const timer = setTimeout(attempt, delayMs);
  timer.unref?.();
}

function firstCodexPositionalArg(args: string[]): string | undefined {
  let skipNext = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "--") {
      return args.slice(i + 1).find((candidate) => candidate.trim().length > 0);
    }
    if (arg.startsWith("--")) {
      const [name, value] = arg.split("=", 2);
      if (CODEX_OPTIONS_WITH_VALUE.has(name) && value === undefined) {
        skipNext = true;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      if (CODEX_OPTIONS_WITH_VALUE.has(arg)) {
        skipNext = true;
      }
      continue;
    }
    return arg;
  }
  return undefined;
}

function canUseCodexInitialPrompt(args: string[], command: string, toolConfigKey?: string): boolean {
  return toolConfigKey === "codex" && command === "codex" && !firstCodexPositionalArg(args);
}

export async function run(host: SessionLaunchHost, opts: { command: string; args: string[] }): Promise<number> {
  initProject();
  await host.instanceDirectory.registerInstance(host.instanceId, process.cwd());
  host.startHeartbeat();
  host.syncSessionsFromTopology();
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
  host.syncSessionsFromTopology();

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
    if (host.isDashboardScreen("notifications")) {
      host.handleNotificationsKey(data);
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
    host.dashboardLastViewportKey = host.getViewportKey();
    host.invalidateDashboardFrame();
    host.renderCurrentDashboardView();
  };
  process.stdout.on("resize", host.onResize);
  host.dashboardLastViewportKey = host.getViewportKey();
  host.dashboardViewportPollInterval = setInterval(() => {
    if (host.mode !== "dashboard") return;
    const viewportKey = host.getViewportKey();
    if (viewportKey === host.dashboardLastViewportKey) return;
    host.dashboardLastViewportKey = viewportKey;
    host.invalidateDashboardFrame();
    host.renderCurrentDashboardView();
  }, 40);

  host.mode = "dashboard";
  host.loadDashboardUiState();
  host.hydrateDashboardScreenState?.();
  host.writeDashboardClientStatuslineFile?.();
  const primed = await host.refreshDashboardModelFromService(true);
  if (!primed) {
    host.refreshLocalDashboardModel();
    void host
      .ensureDashboardControlPlane()
      .then(async () => {
        const refreshed = await host.refreshDashboardModelFromService(true);
        if (refreshed && host.mode === "dashboard") {
          host.renderCurrentDashboardView();
        }
      })
      .catch(() => {});
  }
  host.terminalHost.enterAlternateScreen(true);
  host.startStatusRefresh();
  host.renderCurrentDashboardView();

  const exitCode = await new Promise<number>((resolve) => {
    host.resolveRun = resolve;
  });

  host.teardown();
  return exitCode;
}

export async function runProjectService(host: SessionLaunchHost): Promise<number> {
  initProject();
  host.mode = "project-service";
  host.syncSessionsFromTopology();
  host.writeInstructionFiles();
  await host.startProjectServices();
  host.startStatusRefresh();
  host.refreshDesktopStateSnapshot();
  host.writeStatuslineFile();

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
  const sessionsToResume = listLaunchableTopologySessions(toolFilter);
  if (sessionsToResume.length === 0) {
    console.error("No saved session state found (or state is stale). Starting fresh.");
    return host.runDashboard();
  }

  const config = loadConfig();
  log.info("resuming saved sessions", "session", {
    requestedTool: toolFilter,
    count: sessionsToResume.length,
  });

  const ownedByOthers = host.getRemoteOwnedSessionKeys();
  const metadata = loadMetadataState().sessions;

  for (const saved of sessionsToResume) {
    const backendSessionId = saved.backendSessionId ?? metadata[saved.id]?.backendSessionId;
    if (ownedByOthers.has(saved.id) || (backendSessionId && ownedByOthers.has(backendSessionId))) {
      log.warn("skipping resume owned by another instance", "session", {
        sessionId: saved.id,
        backendSessionId,
      });
      continue;
    }

    const toolCfg = config.tools[saved.toolConfigKey];
    if (!toolCfg) continue;

    if (!host.sessionBootstrap.canResumeWithBackendSessionId(toolCfg, backendSessionId)) {
      console.error(
        `Skipping saved session "${saved.id}" because "${saved.toolConfigKey}" has no exact resumable backend session id.`,
      );
      continue;
    }
    const resumeArgs = toolCfg.resumeArgs!.map((a: string) => a.replace("{sessionId}", backendSessionId!));
    const args = host.sessionBootstrap.composeToolArgs(toolCfg, resumeArgs, saved.args);
    log.info("resuming session", "session", {
      sessionId: saved.id,
      command: saved.command,
      backendSessionId,
      toolConfigKey: saved.toolConfigKey,
      worktreePath: saved.worktreePath,
    });
    host.createSession(
      saved.command,
      args,
      toolCfg.preambleFlag,
      saved.toolConfigKey,
      undefined,
      undefined,
      saved.worktreePath,
      backendSessionId,
      saved.id,
      false,
      true,
      saved.team,
    );
  }

  host.openTmuxDashboardTarget();
  return 0;
}

export async function restoreSessions(host: SessionLaunchHost, toolFilter?: string): Promise<number> {
  initProject();
  const sessionsToRestore = listLaunchableTopologySessions(toolFilter);
  if (sessionsToRestore.length === 0) {
    console.error("No saved session state found (or state is stale). Starting fresh.");
    return host.runDashboard();
  }

  const config = loadConfig();

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
      undefined,
      saved.id,
      false,
      false,
      saved.team,
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
  suppressStartupPreamble = false,
  team?: SessionTeamMetadata,
): any {
  const cols = process.stdout.columns ?? 80;
  const sessionId = sessionIdOverride ?? `${command}-${Math.random().toString(36).slice(2, 8)}`;
  if (host.sessions.some((session: any) => session.id === sessionId)) {
    throw new Error(`Session "${sessionId}" already exists`);
  }
  const config = loadConfig();
  const toolCfg = toolConfigKey ? config.tools[toolConfigKey] : undefined;
  const isClaudeResumeStyleLaunch =
    Boolean(toolCfg && toolConfigKey === "claude" && toolCfg.command === command) &&
    shouldSkipClaudeSessionIdInjection(args);
  const explicitClaudeBackendSessionId =
    toolCfg && toolConfigKey === "claude" && toolCfg.command === command
      ? extractClaudeBackendSessionIdFromArgs(args)
      : undefined;
  const explicitCodexBackendSessionId =
    toolCfg && toolConfigKey === "codex" && toolCfg.command === command
      ? extractCodexBackendSessionIdFromArgs(args)
      : undefined;
  const effectiveSuppressStartupPreamble = suppressStartupPreamble;
  const effectiveSessionIdFlag = isClaudeResumeStyleLaunch ? undefined : sessionIdFlag;
  const backendSessionId =
    backendSessionIdOverride ??
    explicitClaudeBackendSessionId ??
    explicitCodexBackendSessionId ??
    (effectiveSessionIdFlag ? randomUUID() : undefined);
  const automaticPreambleEnabled = config.runtime.agentPreambleEnabled !== false;

  const preamble = effectiveSuppressStartupPreamble
    ? ""
    : host.sessionBootstrap.buildSessionPreamble({
        sessionId,
        command,
        worktreePath,
        extraPreamble,
        includeAimuxPreamble: automaticPreambleEnabled,
        team,
      });
  const shouldInjectLaunchPreamble = Boolean(!effectiveSuppressStartupPreamble && preambleFlag && preamble.trim());
  const shouldUseCodexInitialPrompt = Boolean(
    !effectiveSuppressStartupPreamble &&
    !preambleFlag &&
    automaticPreambleEnabled &&
    (!extraPreamble || Boolean(team)) &&
    preamble.trim() &&
    canUseCodexInitialPrompt(args, command, toolConfigKey),
  );

  host.sessionBootstrap.ensurePlanFile(sessionId, command, worktreePath);

  let finalArgs = shouldInjectLaunchPreamble ? [...args, ...preambleFlag!, preamble] : [...args];
  const codexInitialPrompt = shouldUseCodexInitialPrompt
    ? host.sessionBootstrap.buildInitialKickoffPrompt(sessionId, preamble)
    : undefined;
  if (codexInitialPrompt) {
    finalArgs.push(codexInitialPrompt);
  }
  let launchCommand = command;

  if (effectiveSessionIdFlag && backendSessionId) {
    const expandedFlag = effectiveSessionIdFlag.map((a) => a.replace("{sessionId}", backendSessionId));
    finalArgs = [...finalArgs, ...expandedFlag];
  }

  let projectRoot = process.cwd();
  try {
    projectRoot = findMainRepo(worktreePath ?? process.cwd());
  } catch {
    projectRoot = process.cwd();
  }
  clearSessionTranscriptPath(sessionId);
  clearSessionTranscriptPath(sessionId, projectRoot);

  if (toolCfg && toolConfigKey === "claude" && toolCfg.command === command && toolCfg.wrapperEnabled !== false) {
    finalArgs = injectClaudeHookArgs(finalArgs, {
      sessionId,
      projectRoot,
      backendSessionId,
    });
    launchCommand = toolCfg.command;
    const wrapped = wrapCommandWithManagedLaunchEnv({
      command: launchCommand,
      args: finalArgs,
      extraEnv: {
        AIMUX_SESSION_ID: sessionId,
        AIMUX_TOOL: toolConfigKey ?? command,
      },
    });
    launchCommand = wrapped.command;
    finalArgs = wrapped.args;
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

  if (shouldInjectLaunchPreamble) {
    host.sessionBootstrap.finalizePreamble(command, preamble);
  }
  debug(
    `creating session: ${command} (configKey=${toolConfigKey ?? "cli"}, backendId=${backendSessionId ?? "none"}, cwd=${worktreePath ?? process.cwd()}, args=${finalArgs.length})`,
    "session",
  );
  debug(`spawn args: ${JSON.stringify(summarizeLaunchArgs(finalArgs))}`, "session");

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
  host.registerManagedSession(tmuxTransport, args, toolConfigKey, worktreePath, undefined, sessionStartTime, team);

  session.backendSessionId = backendSessionId;
  if (session instanceof TmuxSessionTransport) {
    host.syncTmuxWindowMetadata(sessionId);
  }
  if (!backendSessionId) {
    scheduleBackendSessionCapture({
      host,
      sessionId,
      projectRoot,
      capture: toolCfg?.sessionCapture,
      startedAtMs: sessionStartTime,
    });
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
  if (
    !effectiveSuppressStartupPreamble &&
    !preambleFlag &&
    !extraPreamble &&
    !shouldUseCodexInitialPrompt &&
    (toolConfigKey !== "codex" || !firstCodexPositionalArg(args)) &&
    automaticPreambleEnabled &&
    preamble.trim()
  ) {
    const kickoff = host.sessionBootstrap.buildInitialKickoffPrompt(sessionId, preamble);
    void host.sessionBootstrap.deliverDetachedCodexKickoffPrompt(sessionId, kickoff, 1800);
  }
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

  const sessionMetadata = loadMetadataState().sessions[sessionId];
  const backendSessionId = session.backendSessionId ?? sessionMetadata?.backendSessionId;
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

  const effectiveTarget = targetWorktreePath === process.cwd() ? undefined : targetWorktreePath;
  const waitForExit = (timeoutMs = 8000) =>
    new Promise<void>((resolve, reject) => {
      if (session.exited) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${sessionId} to exit`)), timeoutMs);
      session.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  session.kill();
  await waitForExit().catch(() => {});

  if (!toolCfg?.preambleFlag) {
    createSession(
      host,
      session.command,
      migrateArgs,
      undefined,
      toolConfigKey,
      undefined,
      undefined,
      effectiveTarget,
      useBackendResume ? backendSessionId : undefined,
      sessionId,
      true,
      true,
      session.team,
    );
    const kickoff = host.sessionBootstrap.buildCodexMigrationKickoffPrompt(
      sessionId,
      sourceCwd,
      targetWorktreePath,
      sourceSnapshot,
    );
    await host.sessionBootstrap.deliverDetachedCodexKickoffPrompt(sessionId, kickoff, 1800);
    return;
  }

  createSession(
    host,
    session.command,
    migrateArgs,
    useBackendResume ? undefined : toolCfg?.preambleFlag,
    toolConfigKey,
    historyContext.trim() || undefined,
    useBackendResume ? undefined : toolCfg?.sessionIdFlag,
    effectiveTarget,
    useBackendResume ? backendSessionId : undefined,
    sessionId,
    false,
    false,
    session.team,
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
  const session = host.sessions[index];
  const sid = session.id;
  host.sessionMRU = [sid, ...host.sessionMRU.filter((id: string) => id !== sid)];
  host.agentTracker.markSeen(sid);
  updateNotificationContext("tui", {
    focused: true,
    screen: "agent",
    sessionId: sid,
    panelOpen: false,
  });
  host.noteLastUsedItem(sid);
  markNotificationsRead({ sessionId: sid });
  host.syncTuiNotificationContext(false);
  const target = host.sessionTmuxTargets.get(sid);
  if (target) {
    try {
      const resolved = host.tmuxRuntimeManager.getTargetByWindowId(target.sessionName, target.windowId);
      if (resolved) {
        host.saveState();
        host.selectLinkedOrOpenTarget(resolved);
        return;
      }
    } catch {}
  }
  if (typeof host.openLiveTmuxWindowForEntry === "function") {
    const sessionMetadata = loadMetadataState().sessions[sid];
    const backendSessionId = session.backendSessionId ?? sessionMetadata?.backendSessionId;
    const result = host.openLiveTmuxWindowForEntry({ id: sid, backendSessionId });
    if (result === "opened") {
      host.saveState();
    }
  }
}

export function handleAction(host: SessionLaunchHost, action: any): void {
  switch (action.type) {
    case "dashboard":
      host.openTmuxDashboardTarget();
      break;
    case "notifications":
      host.clearDashboardSubscreens();
      host.setDashboardScreen("notifications");
      host.persistDashboardUiState();
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
