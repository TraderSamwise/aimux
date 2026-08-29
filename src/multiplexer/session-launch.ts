import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

import { initProject, loadConfig } from "../config.js";
import { getProjectStateDirFor } from "../paths.js";
import { buildContextPreamble } from "../context/context-bridge.js";
import { readHistory } from "../context/history.js";
import { findMainRepo } from "../worktree.js";
import { TmuxSessionTransport } from "../tmux/session-transport.js";
import type { LaunchOverride } from "../shell-args.js";
import {
  extractClaudeBackendSessionIdFromArgs,
  injectClaudeHookArgs,
  shouldSkipClaudeSessionIdInjection,
} from "../claude-hooks.js";
import { codexLaunchHookArgs, installCodexHooks } from "../codex-hooks.js";
import { wrapCommandWithManagedLaunchEnv } from "../managed-launch-env.js";
import { capLaunchPreambleForArgv } from "../session-bootstrap.js";
import { wrapCommandWithShellIntegration } from "../shell-hooks.js";
import { debug, log } from "../debug.js";
import { clearSessionTranscriptPath, findOverseerSessionId, loadMetadataState } from "../metadata-store.js";
import { isOverseerSession, type SessionTeamMetadata } from "../team.js";
import { extractCodexBackendSessionIdFromArgs } from "./session-capture.js";
import { startDashboardProjectEventStream } from "./project-event-stream.js";
import { listTopologySessionStates } from "../runtime-core/topology-sessions.js";
import { reconcileOfflineBackendSessionIds } from "../runtime-core/backend-id-reconcile.js";
import { captureDashboardLifecycle, isDashboardLifecycleCurrent } from "./dashboard-lifecycle.js";
import { isDashboardModelRefreshUsable, refreshDashboardModelThroughApi } from "./dashboard-api-client.js";
import { queueTuiNotificationContext, queueTuiSessionSeen } from "./tui-runtime-mutations.js";
import { resolveLiveSessionTmuxTarget } from "./session-runtime-core.js";
import { getDashboardCommandSpec } from "../dashboard/command-spec.js";
import { getRuntimeOwnerId, TMUX_DASHBOARD_OWNER_OPTION, TMUX_DASHBOARD_READY_OPTION } from "../runtime-owner.js";
import { discoverCodexBackendSessionId, relocateClaudeTranscript } from "../backend-session-discovery.js";
import { StartupInterstitialDismisser } from "../tmux/startup-interstitials.js";
import { isDashboardTuiVisible } from "./tui-visibility.js";

type SessionLaunchHost = any;

const CODEX_BACKEND_CAPTURE_ATTEMPTS = 20;
const CODEX_BACKEND_CAPTURE_INTERVAL_MS = 250;
const STARTUP_INTERSTITIAL_INTERVAL_MS = 500;
const STARTUP_INTERSTITIAL_WINDOW_MS = 30_000;
const DASHBOARD_VIEWPORT_POLL_MS = 250;
const DERIVED_AIMUX_ID_MIN_CHARS = 6;
const DERIVED_AIMUX_ID_MAX_CHARS = 16;

function projectRootFor(host: SessionLaunchHost, worktreePath?: string): string {
  if (worktreePath?.trim()) return worktreePath.trim();
  return typeof host.projectRoot === "string" && host.projectRoot.trim() ? host.projectRoot.trim() : process.cwd();
}

function backendSessionIdSlug(backendSessionId: string): string {
  const normalized = backendSessionId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return normalized || createHash("sha256").update(backendSessionId).digest("hex");
}

export function deriveAimuxSessionIdFromBackendSessionId(
  command: string,
  backendSessionId: string,
  existingIds: Iterable<string> = [],
): string {
  const commandExecutable = basename(command) || command;
  const slug = backendSessionIdSlug(backendSessionId);
  const taken = new Set(existingIds);
  for (
    let length = Math.min(DERIVED_AIMUX_ID_MIN_CHARS, slug.length);
    length <= Math.min(DERIVED_AIMUX_ID_MAX_CHARS, slug.length);
    length += 1
  ) {
    const candidate = `${commandExecutable}-${slug.slice(0, length)}`;
    if (!taken.has(candidate)) return candidate;
  }
  const suffix = createHash("sha256").update(backendSessionId).digest("hex").slice(0, 8);
  const fallbackBase = `${commandExecutable}-${slug.slice(0, DERIVED_AIMUX_ID_MIN_CHARS)}-${suffix}`;
  if (!taken.has(fallbackBase)) return fallbackBase;
  let counter = 2;
  while (true) {
    const candidate = `${fallbackBase}-${counter}`;
    if (!taken.has(candidate)) return candidate;
    counter += 1;
  }
}

function generatedSessionIdForLaunch(
  host: SessionLaunchHost,
  command: string,
  backendSessionId?: string,
  worktreePath?: string,
): string {
  const commandExecutable = basename(command) || command;
  if (!backendSessionId) return `${commandExecutable}-${Math.random().toString(36).slice(2, 8)}`;
  const projectRoot = projectRootFor(host, worktreePath);
  const topologySessions = listTopologySessionStates({ projectRoot });
  const matchingTopologySession = topologySessions.find(
    (session) =>
      session.backendSessionId === backendSessionId &&
      (basename(session.command) || session.command) === commandExecutable,
  );
  if (matchingTopologySession?.id) return matchingTopologySession.id;
  const existingIds = [
    ...(Array.isArray(host.sessions) ? host.sessions.map((session: any) => session.id).filter(Boolean) : []),
    ...topologySessions.map((session) => session.id),
  ];
  return deriveAimuxSessionIdFromBackendSessionId(command, backendSessionId, existingIds);
}

function clearManagedAgentPaneHistory(host: SessionLaunchHost, sessionId: string, target: any): void {
  try {
    host.tmuxRuntimeManager.clearTargetHistory?.(target);
  } catch (error) {
    debug(
      `tmux pane history reset failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      "tmux",
    );
  }
}

async function clearManagedAgentPaneHistoryAsync(
  host: SessionLaunchHost,
  sessionId: string,
  target: any,
): Promise<void> {
  try {
    if (typeof host.tmuxRuntimeManager.clearTargetHistoryAsync === "function") {
      await host.tmuxRuntimeManager.clearTargetHistoryAsync(target);
    } else {
      host.tmuxRuntimeManager.clearTargetHistory?.(target);
    }
  } catch (error) {
    debug(
      `tmux pane history reset failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      "tmux",
    );
  }
}

function listLaunchableTopologySessions(toolFilter?: string): any[] {
  const sessions = listTopologySessionStates({ statuses: ["offline"] });
  return toolFilter ? sessions.filter((s: any) => s.tool === toolFilter || s.toolConfigKey === toolFilter) : sessions;
}

function reconcileLaunchableTopology(host: SessionLaunchHost): void {
  host.syncSessionsFromTopology?.();
  const backendReconcile = reconcileOfflineBackendSessionIds();
  if (backendReconcile.reconciled.length > 0) {
    debug(`reconciled backend session id for ${backendReconcile.reconciled.length} offline agent(s)`, "session");
    host.syncSessionsFromTopology?.();
  }
  host.saveState?.();
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

function firstCodexPositionalArgIndex(args: string[]): number {
  let skipNext = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "--") {
      return i;
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
    return i;
  }
  return args.length;
}

function codexConfigArg(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`;
}

export function injectCodexDeveloperInstructions(args: string[], key: string, instructions: string): string[] {
  if (!key.trim() || !instructions.trim()) return [...args];
  const insertionIndex = firstCodexPositionalArgIndex(args);
  return [...args.slice(0, insertionIndex), "-c", codexConfigArg(key, instructions), ...args.slice(insertionIndex)];
}

/** Backend ids other agents already hold, so discovery cannot land on one. */
function claimedBackendSessionIds(host: SessionLaunchHost, exceptSessionId: string): string[] {
  const sessions: Array<{ id?: string; backendSessionId?: string }> = host.sessions ?? [];
  return sessions
    .filter((session) => session.id !== exceptSessionId && session.backendSessionId)
    .map((session) => session.backendSessionId as string);
}

function scheduleCodexBackendSessionIdCapture(
  host: SessionLaunchHost,
  sessionId: string,
  cwd: string,
  launchStartedAtMs: number,
): void {
  if (typeof host.recordSessionBackendSessionId !== "function") return;
  let attempts = 0;
  const capture = () => {
    const runtime = host.sessions?.find?.((session: any) => session.id === sessionId);
    if (!runtime || runtime.backendSessionId) return;
    attempts += 1;
    try {
      const backendSessionId = discoverCodexBackendSessionId(cwd, undefined, {
        sinceMs: Math.max(0, launchStartedAtMs - 1000),
        excludeBackendSessionIds: claimedBackendSessionIds(host, sessionId),
      });
      if (backendSessionId) {
        host.recordSessionBackendSessionId(sessionId, backendSessionId);
        debug(`captured codex backend session id for ${sessionId}: ${backendSessionId}`, "session");
        return;
      }
    } catch (error) {
      debug(
        `codex backend session id capture failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        "session",
      );
      return;
    }
    if (attempts >= CODEX_BACKEND_CAPTURE_ATTEMPTS) return;
    const timer = setTimeout(capture, CODEX_BACKEND_CAPTURE_INTERVAL_MS);
    timer.unref?.();
  };
  const timer = setTimeout(capture, CODEX_BACKEND_CAPTURE_INTERVAL_MS);
  timer.unref?.();
}

/**
 * Answer the tool's own startup prompts so a new session lands at its prompt
 * instead of waiting on a keypress nobody is there to make.
 *
 * Keeps watching after a hit: Codex puts its directory-trust prompt behind the
 * update prompt, so dismissing one reveals the next.
 */
function scheduleStartupInterstitialDismissal(
  host: SessionLaunchHost,
  sessionId: string,
  target: any,
  toolConfigKey: string | undefined,
): void {
  const interstitials = toolConfigKey ? (loadConfig().tools[toolConfigKey]?.startupInterstitials ?? []) : [];
  if (interstitials.length === 0) return;
  const dismisser = new StartupInterstitialDismisser(interstitials);
  const deadline = Date.now() + STARTUP_INTERSTITIAL_WINDOW_MS;

  const poll = async () => {
    if (Date.now() >= deadline || dismisser.done) return;
    const runtime = host.sessions?.find?.((session: any) => session.id === sessionId);
    if (!runtime || runtime.exited) return;
    try {
      // Visible pane only. Scanning scrollback would match a prompt that was
      // already answered and type the key into a working agent.
      const screen = await host.tmuxRuntimeManager.captureTargetAsync(target, { startLine: 0 });
      const found = dismisser.next(screen);
      if (found) {
        host.tmuxRuntimeManager.sendText(target, found.key);
        debug(`dismissed ${found.interstitial.id} for ${sessionId} with "${found.key}"`, "session");
      }
    } catch (error) {
      debug(
        `startup interstitial check failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        "session",
      );
    }
    const next = setTimeout(poll, STARTUP_INTERSTITIAL_INTERVAL_MS);
    next.unref?.();
  };

  const timer = setTimeout(poll, STARTUP_INTERSTITIAL_INTERVAL_MS);
  timer.unref?.();
}

export async function run(host: SessionLaunchHost, opts: { command: string; args: string[] }): Promise<number> {
  initProject();
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

const DASHBOARD_FOCUS_IN_REPORT = Buffer.from("\x1b[I");

function stripDashboardFocusInReports(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let start = 0;
  let index = data.indexOf(DASHBOARD_FOCUS_IN_REPORT);
  while (index >= 0) {
    if (index > start) chunks.push(data.subarray(start, index));
    start = index + DASHBOARD_FOCUS_IN_REPORT.length;
    index = data.indexOf(DASHBOARD_FOCUS_IN_REPORT, start);
  }
  if (start < data.length) chunks.push(data.subarray(start));
  return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
}

function markDashboardReadyForInput(host: SessionLaunchHost): void {
  const paneId = process.env.TMUX_PANE?.trim();
  if (!paneId || !host.tmuxRuntimeManager?.setWindowOption) return;
  try {
    const { dashboardBuildStamp } = getDashboardCommandSpec(projectRootFor(host));
    host.tmuxRuntimeManager.setWindowOption(paneId, "@aimux-dashboard-build", dashboardBuildStamp);
    host.tmuxRuntimeManager.setWindowOption(paneId, TMUX_DASHBOARD_OWNER_OPTION, getRuntimeOwnerId());
    host.tmuxRuntimeManager.setWindowOption(paneId, TMUX_DASHBOARD_READY_OPTION, dashboardBuildStamp);
  } catch {}
}

export async function runDashboard(host: SessionLaunchHost): Promise<number> {
  initProject();
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
    let input = data;
    if (host.isFocusInReport(input)) {
      host.handleDashboardFocusIn();
      input = stripDashboardFocusInReports(input);
      if (input.length === 0) return;
    }
    host.dashboardInputEpoch = (host.dashboardInputEpoch ?? 0) + 1;
    if (host.handleActiveDashboardOverlayKey(input)) {
      return;
    }
    if (host.handleRuntimeGuardKey(input)) {
      return;
    }
    if (host.isDashboardScreen("coordination")) {
      host.handleCoordinationKey(input);
      return;
    }
    if (host.isDashboardScreen("project")) {
      host.handleProjectKey(input);
      return;
    }
    if (host.isDashboardScreen("library")) {
      host.handleLibraryKey(input);
      return;
    }
    if (host.isDashboardScreen("topology")) {
      host.handleTopologyKey(input);
      return;
    }
    if (host.isDashboardScreen("help")) {
      host.handleHelpKey(input);
      return;
    }
    if (host.isDashboardScreen("graveyard")) {
      host.handleGraveyardKey(input);
      return;
    }

    if (host.mode === "dashboard") {
      host.handleDashboardKey(input);
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
    if (!isDashboardTuiVisible(host)) return;
    const viewportKey = host.getViewportKey();
    if (viewportKey === host.dashboardLastViewportKey) return;
    host.dashboardLastViewportKey = viewportKey;
    host.invalidateDashboardFrame();
    host.renderCurrentDashboardView();
  }, DASHBOARD_VIEWPORT_POLL_MS);

  host.mode = "dashboard";
  const dashboardRunGeneration = (host.dashboardRunGeneration ?? 0) + 1;
  host.dashboardRunGeneration = dashboardRunGeneration;
  if (typeof host.dashboardInputEpoch !== "number") host.dashboardInputEpoch = 0;
  host.loadDashboardUiState();
  host.hydrateDashboardScreenState?.();
  host.writeDashboardClientStatuslineFile?.();
  const startupBusyState = {
    title: "Connecting Aimux",
    lines: ["Loading project state from the local service."],
    spinnerFrame: 0,
    startedAt: Date.now(),
  };
  host.dashboardBusyState = startupBusyState;
  host.dashboardStartupPriming = true;
  host.terminalHost.enterAlternateScreen(true);
  host.startStatusRefresh();
  host.renderCurrentDashboardView();
  markDashboardReadyForInput(host);

  const startupModelLifecycle = captureDashboardLifecycle(host);
  const primed = await refreshDashboardModelThroughApi(host, { force: true, lifecycle: startupModelLifecycle });
  let projectEventStreamStarted = false;
  const startProjectEventStreamOnce = () => {
    if (projectEventStreamStarted) return;
    projectEventStreamStarted = true;
    startDashboardProjectEventStream(host);
  };
  if (!isDashboardModelRefreshUsable(primed)) {
    const repairModelLifecycle = captureDashboardLifecycle(host);
    const repairRenderLifecycle = captureDashboardLifecycle(host, { inputEpoch: true });
    const isRepairLifecycleCurrent = () =>
      host.dashboardRunGeneration === dashboardRunGeneration &&
      isDashboardLifecycleCurrent(host, repairRenderLifecycle);
    void host
      .ensureDashboardControlPlane()
      .then(async () => {
        if (!isRepairLifecycleCurrent()) {
          if (host.dashboardBusyState === startupBusyState) host.dashboardBusyState = null;
          host.dashboardStartupPriming = false;
          return;
        }
        const refreshed = await refreshDashboardModelThroughApi(host, { force: true, lifecycle: repairModelLifecycle });
        if (host.dashboardBusyState === startupBusyState) host.dashboardBusyState = null;
        if (!isRepairLifecycleCurrent()) return;
        host.dashboardStartupPriming = false;
        if (isDashboardModelRefreshUsable(refreshed) || !host.dashboardModelServiceRefreshError) {
          startProjectEventStreamOnce();
          markDashboardReadyForInput(host);
          host.renderCurrentDashboardView();
          return;
        }
        startProjectEventStreamOnce();
        host.showDashboardError?.("Aimux repair failed", [
          host.dashboardModelServiceRefreshError instanceof Error
            ? host.dashboardModelServiceRefreshError.message
            : String(host.dashboardModelServiceRefreshError),
        ]);
        host.renderCurrentDashboardView();
      })
      .catch((error: unknown) => {
        if (host.dashboardBusyState === startupBusyState) host.dashboardBusyState = null;
        host.dashboardStartupPriming = false;
        if (!isRepairLifecycleCurrent()) return;
        startProjectEventStreamOnce();
        host.showDashboardError?.("Aimux repair failed", [error instanceof Error ? error.message : String(error)]);
      });
  } else {
    if (host.dashboardBusyState === startupBusyState) host.dashboardBusyState = null;
    host.dashboardStartupPriming = false;
    startProjectEventStreamOnce();
    markDashboardReadyForInput(host);
  }
  host.renderCurrentDashboardView();

  const exitCode = await new Promise<number>((resolve) => {
    host.resolveRun = resolve;
  });

  host.teardown();
  return exitCode;
}

/**
 * Run the project service as this process's whole job, until told to stop.
 *
 * The daemon-hosted actor and this share `startProjectServiceHost`, which is the
 * point: everything project-specific lives there, and the only thing this adds is
 * staying alive. Anything project-specific added here instead is how the two
 * paths drift.
 */
export async function runProjectService(host: SessionLaunchHost): Promise<number> {
  await startProjectServiceHost(host);

  const exitCode = await new Promise<number>((resolve) => {
    host.resolveRun = resolve;
  });

  host.teardown();
  return exitCode;
}

export async function startProjectServiceHost(host: SessionLaunchHost): Promise<void> {
  const projectRoot = projectRootFor(host);
  initProject();
  host.mode = "project-service";
  host.tmuxRuntimeManager?.repairLegacyProjectSessionNames?.(projectRoot);
  reconcileLaunchableTopology(host);
  host.writeInstructionFiles();
  host.refreshDesktopStateSnapshot();
  await host.startProjectServices();
  host.startStatusRefresh();
  host.startGraveyardCleanup?.();
  if (host.cleanupGraveyard && !host.graveyardCleanupRunning) {
    host.graveyardCleanupRunning = true;
    void host
      .cleanupGraveyard()
      .catch((error: unknown) => {
        debug(`graveyard cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "graveyard");
      })
      .finally(() => {
        host.graveyardCleanupRunning = false;
      });
  }
  host.startInboxCleanup?.();
  if (host.cleanupInbox && !host.inboxCleanupRunning) {
    host.inboxCleanupRunning = true;
    void host
      .cleanupInbox()
      .catch((error: unknown) => {
        debug(`inbox cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "notification");
      })
      .finally(() => {
        host.inboxCleanupRunning = false;
      });
  }
  host.writeStatuslineFile();
}

export async function resumeSessions(host: SessionLaunchHost, toolFilter?: string): Promise<number> {
  initProject();
  host.startHeartbeat();
  reconcileLaunchableTopology(host);
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

  for (const saved of sessionsToResume) {
    const backendSessionId = saved.backendSessionId;
    const toolCfg = config.tools[saved.toolConfigKey];
    if (!toolCfg) continue;

    if (!backendSessionId || !host.sessionBootstrap.canResumeWithBackendSessionId(toolCfg, backendSessionId)) {
      console.error(
        `Skipping saved session "${saved.id}" because "${saved.toolConfigKey}" has no exact resumable backend session id.`,
      );
      continue;
    }
    const resumeArgs = toolCfg.resumeArgs!.map((a: string) => a.replace("{sessionId}", backendSessionId!));
    const { launch: args, persist } = host.sessionBootstrap.composeToolLaunch(toolCfg, resumeArgs, saved.args);
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
      undefined,
      persist,
    );
  }

  host.openTmuxDashboardTarget();
  return 0;
}

export async function restoreSessions(host: SessionLaunchHost, toolFilter?: string): Promise<number> {
  initProject();
  reconcileLaunchableTopology(host);
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

    // Sanitised on the way past: rows written before this fix carry a resume
    // verb, and re-persisting it keeps the session unlaunchable for codex.
    const configuredArgs = host.sessionBootstrap.stripToolActionArgs(toolCfg, saved.args ?? []);
    host.createSession(
      saved.command,
      configuredArgs,
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
  launchEnv?: Record<string, string>,
  /**
   * What to remember as this session's args, when that differs from how it was
   * launched. A fork is launched with the source's id, and remembering that
   * would make every later resume compose "--resume <mine> --resume <source>
   * --fork-session" and branch the parent again instead of continuing.
   */
  persistArgs?: string[],
): any {
  const cols = process.stdout.columns ?? 80;
  const commandExecutable = basename(command) || command;
  const config = loadConfig();
  const toolCfg = toolConfigKey ? config.tools[toolConfigKey] : undefined;
  // A launch override may swap the binary; aimux flags/preamble only apply to the tool's own command.
  const isConfiguredToolCommand = Boolean(toolCfg && toolCfg.command === command);
  const configuredToolExecutable = toolCfg ? basename(toolCfg.command) || toolCfg.command : undefined;
  const isConfiguredClaudeCommand = isConfiguredToolCommand && configuredToolExecutable === "claude";
  const isConfiguredCodexCommand = isConfiguredToolCommand && configuredToolExecutable === "codex";
  const isClaudeResumeStyleLaunch = isConfiguredClaudeCommand && shouldSkipClaudeSessionIdInjection(args);
  const explicitClaudeBackendSessionId = isConfiguredClaudeCommand
    ? extractClaudeBackendSessionIdFromArgs(args)
    : undefined;
  const explicitCodexBackendSessionId = isConfiguredCodexCommand
    ? extractCodexBackendSessionIdFromArgs(args)
    : undefined;
  const effectiveSuppressStartupPreamble = suppressStartupPreamble;
  const effectiveSessionIdFlag = isConfiguredToolCommand && !isClaudeResumeStyleLaunch ? sessionIdFlag : undefined;
  const backendSessionId =
    backendSessionIdOverride ??
    explicitClaudeBackendSessionId ??
    explicitCodexBackendSessionId ??
    (effectiveSessionIdFlag ? randomUUID() : undefined);
  const sessionId = sessionIdOverride ?? generatedSessionIdForLaunch(host, command, backendSessionId, worktreePath);
  if (host.sessions.some((session: any) => session.id === sessionId)) {
    throw new Error(`Session "${sessionId}" already exists`);
  }
  const automaticPreambleEnabled = config.runtime.agentPreambleEnabled !== false;

  const preamble = effectiveSuppressStartupPreamble
    ? ""
    : capLaunchPreambleForArgv(
        sessionId,
        host.sessionBootstrap.buildSessionPreamble({
          sessionId,
          command,
          worktreePath,
          extraPreamble,
          includeAimuxPreamble: automaticPreambleEnabled,
          team,
        }),
      );
  const shouldInjectLaunchPreamble = Boolean(
    isConfiguredToolCommand && !effectiveSuppressStartupPreamble && preambleFlag && preamble.trim(),
  );
  const shouldInjectCodexDeveloperInstructions = Boolean(
    !effectiveSuppressStartupPreamble &&
    isConfiguredCodexCommand &&
    toolCfg?.developerInstructionsConfigKey &&
    preamble.trim(),
  );

  host.sessionBootstrap.ensurePlanFile(sessionId, command, worktreePath);

  let finalArgs = shouldInjectLaunchPreamble ? [...args, ...preambleFlag!, preamble] : [...args];
  if (shouldInjectCodexDeveloperInstructions) {
    finalArgs = injectCodexDeveloperInstructions(finalArgs, toolCfg!.developerInstructionsConfigKey!, preamble);
  }
  let launchCommand = command;

  if (effectiveSessionIdFlag && backendSessionId) {
    const expandedFlag = effectiveSessionIdFlag.map((a) => a.replace("{sessionId}", backendSessionId));
    finalArgs = [...finalArgs, ...expandedFlag];
  }

  const root = projectRootFor(host);
  const launchCwd = worktreePath ?? root;
  let projectRoot = root;
  try {
    projectRoot = findMainRepo(launchCwd);
  } catch {
    projectRoot = root;
  }
  clearSessionTranscriptPath(sessionId);
  clearSessionTranscriptPath(sessionId, projectRoot);

  if (toolCfg && isConfiguredClaudeCommand && toolCfg.wrapperEnabled !== false) {
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
        ...(launchEnv ?? {}),
        AIMUX_METADATA_ENDPOINT_FILE: `${getProjectStateDirFor(projectRoot)}/metadata-api.txt`,
        AIMUX_SESSION_ID: sessionId,
        AIMUX_TOOL: toolConfigKey ?? command,
      },
    });
    launchCommand = wrapped.command;
    finalArgs = wrapped.args;
  } else if (toolCfg && isConfiguredCodexCommand && toolCfg.wrapperEnabled !== false) {
    try {
      installCodexHooks();
    } catch (error) {
      debug(`codex hook install failed: ${error instanceof Error ? error.message : String(error)}`, "session");
    }
    finalArgs = [...codexLaunchHookArgs(), ...finalArgs];
    launchCommand = toolCfg.command;
    const wrapped = wrapCommandWithManagedLaunchEnv({
      command: launchCommand,
      args: finalArgs,
      extraEnv: {
        ...(launchEnv ?? {}),
        TERM: "tmux-256color",
        AIMUX_METADATA_ENDPOINT_FILE: `${getProjectStateDirFor(projectRoot)}/metadata-api.txt`,
        AIMUX_SESSION_ID: sessionId,
        AIMUX_PROJECT_ROOT: projectRoot,
        AIMUX_TOOL: toolConfigKey ?? command,
      },
    });
    launchCommand = wrapped.command;
    finalArgs = wrapped.args;
  } else if (isConfiguredToolCommand) {
    const wrapped = wrapCommandWithShellIntegration({
      projectRoot,
      sessionId,
      tool: toolConfigKey ?? command,
      command: launchCommand,
      args: finalArgs,
      extraEnv: launchEnv,
    });
    launchCommand = wrapped.command;
    finalArgs = wrapped.args;
  } else if (launchEnv && Object.keys(launchEnv).length > 0) {
    const wrapped = wrapCommandWithManagedLaunchEnv({
      command: launchCommand,
      args: finalArgs,
      extraEnv: launchEnv,
    });
    launchCommand = wrapped.command;
    finalArgs = wrapped.args;
  }

  if (shouldInjectLaunchPreamble) {
    host.sessionBootstrap.finalizePreamble(command, preamble);
  }
  debug(
    `creating session: ${command} (configKey=${toolConfigKey ?? "cli"}, backendId=${backendSessionId ?? "none"}, cwd=${launchCwd}, args=${finalArgs.length})`,
    "session",
  );
  debug(`spawn args: ${JSON.stringify(summarizeLaunchArgs(finalArgs))}`, "session");

  const sessionStartTime = Date.now();
  const tmuxSession = host.tmuxRuntimeManager.ensureProjectSession(projectRoot);
  const target = host.tmuxRuntimeManager.createWindow(
    tmuxSession.sessionName,
    host.getSessionLabel(sessionId) ?? command,
    launchCwd,
    launchCommand,
    finalArgs,
    { detached: detachedInTmux },
  );
  clearManagedAgentPaneHistory(host, sessionId, target);
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
  host.registerManagedSession(
    tmuxTransport,
    persistArgs ?? args,
    toolConfigKey,
    worktreePath,
    undefined,
    sessionStartTime,
    team,
  );
  scheduleStartupInterstitialDismissal(host, sessionId, target, toolConfigKey);

  session.backendSessionId = backendSessionId;
  if (session instanceof TmuxSessionTransport) {
    host.syncTmuxWindowMetadata(sessionId);
  }
  if (isConfiguredCodexCommand && !backendSessionId) {
    scheduleCodexBackendSessionIdCapture(host, sessionId, launchCwd, sessionStartTime);
  }

  host.activeIndex = host.sessions.length - 1;
  if (host.startedInDashboard && host.mode === "dashboard") {
    host.invalidateDesktopStateSnapshot();
    host.refreshLocalDashboardModel();
    host.updateWorktreeSessions();
    // An overseer is not listed under a worktree, so steering the dashboard at
    // its main-repo path would focus a group that does not exist.
    if (!isOverseerSession({ team })) {
      host.preferDashboardEntrySelection("session", sessionId, worktreePath);
    }
    host.renderCurrentDashboardView();
  }

  host.saveState();
  return session;
}

export async function createSessionAsync(
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
  launchEnv?: Record<string, string>,
  /** See createSession: what to remember, when it differs from the launch. */
  persistArgs?: string[],
): Promise<any> {
  const cols = process.stdout.columns ?? 80;
  const commandExecutable = basename(command) || command;
  const config = loadConfig();
  const toolCfg = toolConfigKey ? config.tools[toolConfigKey] : undefined;
  const isConfiguredToolCommand = Boolean(toolCfg && toolCfg.command === command);
  const configuredToolExecutable = toolCfg ? basename(toolCfg.command) || toolCfg.command : undefined;
  const isConfiguredClaudeCommand = isConfiguredToolCommand && configuredToolExecutable === "claude";
  const isConfiguredCodexCommand = isConfiguredToolCommand && configuredToolExecutable === "codex";
  const isClaudeResumeStyleLaunch = isConfiguredClaudeCommand && shouldSkipClaudeSessionIdInjection(args);
  const explicitClaudeBackendSessionId = isConfiguredClaudeCommand
    ? extractClaudeBackendSessionIdFromArgs(args)
    : undefined;
  const explicitCodexBackendSessionId = isConfiguredCodexCommand
    ? extractCodexBackendSessionIdFromArgs(args)
    : undefined;
  const effectiveSuppressStartupPreamble = suppressStartupPreamble;
  const effectiveSessionIdFlag = isConfiguredToolCommand && !isClaudeResumeStyleLaunch ? sessionIdFlag : undefined;
  const backendSessionId =
    backendSessionIdOverride ??
    explicitClaudeBackendSessionId ??
    explicitCodexBackendSessionId ??
    (effectiveSessionIdFlag ? randomUUID() : undefined);
  const sessionId = sessionIdOverride ?? generatedSessionIdForLaunch(host, command, backendSessionId, worktreePath);
  if (host.sessions.some((session: any) => session.id === sessionId)) {
    throw new Error(`Session "${sessionId}" already exists`);
  }
  const automaticPreambleEnabled = config.runtime.agentPreambleEnabled !== false;

  const preamble = effectiveSuppressStartupPreamble
    ? ""
    : capLaunchPreambleForArgv(
        sessionId,
        host.sessionBootstrap.buildSessionPreamble({
          sessionId,
          command,
          worktreePath,
          extraPreamble,
          includeAimuxPreamble: automaticPreambleEnabled,
          team,
        }),
      );
  const shouldInjectLaunchPreamble = Boolean(
    isConfiguredToolCommand && !effectiveSuppressStartupPreamble && preambleFlag && preamble.trim(),
  );
  const shouldInjectCodexDeveloperInstructions = Boolean(
    !effectiveSuppressStartupPreamble &&
    isConfiguredCodexCommand &&
    toolCfg?.developerInstructionsConfigKey &&
    preamble.trim(),
  );

  host.sessionBootstrap.ensurePlanFile(sessionId, command, worktreePath);

  let finalArgs = shouldInjectLaunchPreamble ? [...args, ...preambleFlag!, preamble] : [...args];
  if (shouldInjectCodexDeveloperInstructions) {
    finalArgs = injectCodexDeveloperInstructions(finalArgs, toolCfg!.developerInstructionsConfigKey!, preamble);
  }
  let launchCommand = command;

  if (effectiveSessionIdFlag && backendSessionId) {
    const expandedFlag = effectiveSessionIdFlag.map((a) => a.replace("{sessionId}", backendSessionId));
    finalArgs = [...finalArgs, ...expandedFlag];
  }

  const root = projectRootFor(host);
  const launchCwd = worktreePath ?? root;
  let projectRoot = root;
  try {
    projectRoot = findMainRepo(launchCwd);
  } catch {
    projectRoot = root;
  }
  clearSessionTranscriptPath(sessionId);
  clearSessionTranscriptPath(sessionId, projectRoot);

  if (toolCfg && isConfiguredClaudeCommand && toolCfg.wrapperEnabled !== false) {
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
        ...(launchEnv ?? {}),
        AIMUX_METADATA_ENDPOINT_FILE: `${getProjectStateDirFor(projectRoot)}/metadata-api.txt`,
        AIMUX_SESSION_ID: sessionId,
        AIMUX_TOOL: toolConfigKey ?? command,
      },
    });
    launchCommand = wrapped.command;
    finalArgs = wrapped.args;
  } else if (toolCfg && isConfiguredCodexCommand && toolCfg.wrapperEnabled !== false) {
    try {
      installCodexHooks();
    } catch (error) {
      debug(`codex hook install failed: ${error instanceof Error ? error.message : String(error)}`, "session");
    }
    finalArgs = [...codexLaunchHookArgs(), ...finalArgs];
    launchCommand = toolCfg.command;
    const wrapped = wrapCommandWithManagedLaunchEnv({
      command: launchCommand,
      args: finalArgs,
      extraEnv: {
        ...(launchEnv ?? {}),
        TERM: "tmux-256color",
        AIMUX_METADATA_ENDPOINT_FILE: `${getProjectStateDirFor(projectRoot)}/metadata-api.txt`,
        AIMUX_SESSION_ID: sessionId,
        AIMUX_PROJECT_ROOT: projectRoot,
        AIMUX_TOOL: toolConfigKey ?? command,
      },
    });
    launchCommand = wrapped.command;
    finalArgs = wrapped.args;
  } else if (isConfiguredToolCommand) {
    const wrapped = wrapCommandWithShellIntegration({
      projectRoot,
      sessionId,
      tool: toolConfigKey ?? command,
      command: launchCommand,
      args: finalArgs,
      extraEnv: launchEnv,
    });
    launchCommand = wrapped.command;
    finalArgs = wrapped.args;
  } else if (launchEnv && Object.keys(launchEnv).length > 0) {
    const wrapped = wrapCommandWithManagedLaunchEnv({
      command: launchCommand,
      args: finalArgs,
      extraEnv: launchEnv,
    });
    launchCommand = wrapped.command;
    finalArgs = wrapped.args;
  }

  if (shouldInjectLaunchPreamble) {
    host.sessionBootstrap.finalizePreamble(command, preamble);
  }
  debug(
    `creating session: ${command} (configKey=${toolConfigKey ?? "cli"}, backendId=${backendSessionId ?? "none"}, cwd=${launchCwd}, args=${finalArgs.length})`,
    "session",
  );
  debug(`spawn args: ${JSON.stringify(summarizeLaunchArgs(finalArgs))}`, "session");

  const sessionStartTime = Date.now();
  const tmuxSession =
    typeof host.tmuxRuntimeManager.ensureProjectSessionAsync === "function"
      ? await host.tmuxRuntimeManager.ensureProjectSessionAsync(projectRoot)
      : host.tmuxRuntimeManager.ensureProjectSession(projectRoot);
  const target = await host.tmuxRuntimeManager.createWindowAsync(
    tmuxSession.sessionName,
    host.getSessionLabel(sessionId) ?? command,
    launchCwd,
    launchCommand,
    finalArgs,
    { detached: detachedInTmux },
  );
  await clearManagedAgentPaneHistoryAsync(host, sessionId, target);
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
  host.registerManagedSession(
    tmuxTransport,
    persistArgs ?? args,
    toolConfigKey,
    worktreePath,
    undefined,
    sessionStartTime,
    team,
  );
  scheduleStartupInterstitialDismissal(host, sessionId, target, toolConfigKey);

  session.backendSessionId = backendSessionId;
  if (session instanceof TmuxSessionTransport) {
    const existingMetadata =
      typeof host.buildTmuxWindowMetadata === "function"
        ? host.buildTmuxWindowMetadata(sessionId, command)
        : {
            kind: "agent" as const,
            sessionId,
            command,
            args,
            toolConfigKey: toolConfigKey ?? command,
            backendSessionId,
            team,
            worktreePath,
          };
    const metadata = {
      ...existingMetadata,
      createdAt: existingMetadata?.createdAt ?? new Date(sessionStartTime).toISOString(),
    };
    try {
      if (typeof host.tmuxRuntimeManager.setWindowMetadataAsync === "function") {
        await host.tmuxRuntimeManager.setWindowMetadataAsync(target, metadata);
      } else {
        host.tmuxRuntimeManager.setWindowMetadata(target, metadata);
      }
    } catch (error) {
      host.sessions = host.sessions.filter((runtime: any) => runtime.id !== sessionId);
      host.sessionTmuxTargets.delete(sessionId);
      host.sessionToolKeys.delete(sessionId);
      host.sessionOriginalArgs.delete(sessionId);
      host.sessionWorktreePaths.delete(sessionId);
      host.sessionStartTimes.delete(sessionId);
      host.updateContextWatcherSessions?.();
      try {
        if (typeof host.tmuxRuntimeManager.killWindowAsync === "function") {
          await host.tmuxRuntimeManager.killWindowAsync(target);
        } else {
          host.tmuxRuntimeManager.killWindow(target);
        }
      } catch {}
      throw error;
    }
    try {
      if (typeof host.tmuxRuntimeManager.applyManagedAgentWindowPolicyAsync === "function") {
        await host.tmuxRuntimeManager.applyManagedAgentWindowPolicyAsync(target, metadata.toolConfigKey);
      } else {
        host.tmuxRuntimeManager.applyManagedAgentWindowPolicy(target, metadata.toolConfigKey);
      }
    } catch (error) {
      debug(
        `tmux window policy failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        "session",
      );
    }
  }
  if (isConfiguredCodexCommand && !backendSessionId) {
    scheduleCodexBackendSessionIdCapture(host, sessionId, launchCwd, sessionStartTime);
  }

  host.activeIndex = host.sessions.length - 1;
  if (host.startedInDashboard && host.mode === "dashboard") {
    host.invalidateDesktopStateSnapshot();
    host.refreshLocalDashboardModel();
    host.updateWorktreeSessions();
    // An overseer is not listed under a worktree, so steering the dashboard at
    // its main-repo path would focus a group that does not exist.
    if (!isOverseerSession({ team })) {
      host.preferDashboardEntrySelection("session", sessionId, worktreePath);
    }
    host.renderCurrentDashboardView();
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
  const root = projectRootFor(host);
  const sourceCwd = sourceWorktree ?? root;
  const toolConfigKey = host.sessionToolKeys.get(sessionId) ?? session.command;
  const config = loadConfig();
  const toolCfg = config.tools[toolConfigKey];
  // Reattaching seeds this from tmux metadata, so it carries whatever a launch
  // before this fix wrote — sanitise before it is composed or remembered again.
  const originalArgs = host.sessionBootstrap.stripToolActionArgs(
    toolCfg,
    host.sessionOriginalArgs.get(sessionId) ?? [],
  );

  const backendSessionId = session.backendSessionId;
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
    // Its history is full of the old worktree's absolute paths, and it has no
    // way to notice it was moved.
    historyContext = `You have been moved from ${sourceCwd} to ${targetWorktreePath}. Work in the new path from now on; paths in your earlier messages point at the old one.`;
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

  const effectiveTarget = targetWorktreePath === root ? undefined : targetWorktreePath;
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

  // After it exits, not before: claude keeps writing until then, and a copy
  // taken earlier would leave those turns behind. claude finds a conversation
  // only under the directory it started in and takes no flag pointing
  // elsewhere, so without this the move reports no such conversation and loses
  // the work. codex needs nothing — it keys transcripts by date and adopts the
  // process cwd.
  if (useBackendResume && toolConfigKey === "claude") {
    relocateClaudeTranscript(sourceCwd, targetWorktreePath, backendSessionId!);
  }

  if (!toolCfg?.preambleFlag) {
    // A real resume already carries the conversation, so the written handover
    // would only ask it to re-read a summary of what it already remembers.
    const continuityPreamble = useBackendResume
      ? historyContext
      : host.sessionBootstrap.buildCodexMigrationContinuityPreamble(
          sessionId,
          sourceCwd,
          targetWorktreePath,
          sourceSnapshot,
        );
    createSession(
      host,
      session.command,
      migrateArgs,
      undefined,
      toolConfigKey,
      continuityPreamble,
      undefined,
      effectiveTarget,
      useBackendResume ? backendSessionId : undefined,
      sessionId,
      true,
      false,
      session.team,
      undefined,
      originalArgs,
    );
    return;
  }

  createSession(
    host,
    session.command,
    migrateArgs,
    toolCfg?.preambleFlag,
    toolConfigKey,
    historyContext.trim() || undefined,
    useBackendResume ? undefined : toolCfg?.sessionIdFlag,
    effectiveTarget,
    useBackendResume ? backendSessionId : undefined,
    sessionId,
    false,
    false,
    session.team,
    undefined,
    originalArgs,
  );
}

export async function switchAgentTool(
  host: SessionLaunchHost,
  sessionId: string,
  targetToolConfigKey: string,
  launchOverride?: LaunchOverride,
  instruction?: string,
): Promise<void> {
  const session = host.sessions.find((s: any) => s.id === sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found`);
  }
  if (session.exited) {
    throw new Error(`Session "${sessionId}" is not live`);
  }

  const config = loadConfig();
  const targetToolCfg = config.tools[targetToolConfigKey];
  if (!targetToolCfg) {
    throw new Error(`Unknown tool config: ${targetToolConfigKey}`);
  }
  if (targetToolCfg.enabled === false) {
    throw new Error(`Tool config "${targetToolConfigKey}" is disabled`);
  }

  const sourceToolConfigKey = host.sessionToolKeys.get(sessionId) ?? session.command;
  if (sourceToolConfigKey === targetToolConfigKey && !launchOverride) {
    return;
  }

  const worktreePath = host.sessionWorktreePaths.get(sessionId);
  const sourceToolCfg = config.tools[sourceToolConfigKey];
  const sourceToolLabel = sourceToolConfigKey || session.command;
  const targetToolLabel = targetToolConfigKey || targetToolCfg.command;
  const originalTargetArgs = host.sessionBootstrap.stripToolActionArgs(
    targetToolCfg,
    launchOverride?.args ?? targetToolCfg.args,
  );

  await host.contextWatcher.syncNow(sessionId).catch(() => {});
  const sourceSnapshot = host.sessionBootstrap.readForkSourceSnapshot(sessionId);
  const continuityPreamble = host.sessionBootstrap.buildToolSwitchContinuityPreamble({
    sessionId,
    sourceTool: sourceToolLabel,
    targetTool: targetToolLabel,
    snapshot: sourceSnapshot,
    instruction,
  });

  debug(`switching session ${sessionId} from ${sourceToolLabel} to ${targetToolLabel}`, "session");

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

  createSession(
    host,
    launchOverride?.command ?? targetToolCfg.command,
    originalTargetArgs,
    targetToolCfg.preambleFlag,
    targetToolConfigKey,
    continuityPreamble,
    targetToolCfg.sessionIdFlag,
    worktreePath,
    undefined,
    sessionId,
    !targetToolCfg.preambleFlag,
    false,
    session.team,
    launchOverride?.env,
    originalTargetArgs,
  );

  if (sourceToolCfg?.command === "claude" && targetToolCfg.command !== "claude") {
    debug(`switched ${sessionId} away from claude without carrying backend session id`, "session");
  }
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

function markFocusedSession(host: SessionLaunchHost, index: number, sessionId: string): void {
  host.activeIndex = index;
  host.sessionMRU = [sessionId, ...host.sessionMRU.filter((id: string) => id !== sessionId)];
  queueTuiNotificationContext(host, {
    screen: "agent",
    sessionId,
    panelOpen: false,
  });
  host.noteLastUsedItem(sessionId);
  queueTuiSessionSeen(host, sessionId);
}

export function focusSession(host: SessionLaunchHost, index: number): void {
  if (index < 0 || index >= host.sessions.length) return;

  const session = host.sessions[index];
  const sid = session.id;
  const target = host.sessionTmuxTargets.get(sid);
  if (target) {
    try {
      const resolved = resolveLiveSessionTmuxTarget(host, sid, target);
      if (resolved) {
        host.selectLinkedOrOpenTarget(resolved);
        markFocusedSession(host, index, sid);
        host.saveState();
        return;
      }
    } catch {}
  }
  if (typeof host.openLiveTmuxWindowForEntry === "function") {
    const result = host.openLiveTmuxWindowForEntry({ id: sid, backendSessionId: session.backendSessionId });
    if (result === "opened") {
      markFocusedSession(host, index, sid);
      host.saveState();
    }
  }
}

export function handleAction(host: SessionLaunchHost, action: any): void {
  switch (action.type) {
    case "dashboard":
      host.openTmuxDashboardTarget();
      break;
    case "coordination":
      host.clearDashboardSubscreens();
      host.setDashboardScreen("coordination");
      // This path bypasses showCoordination, so request the service-backed view explicitly.
      host.coordinationLoaded = false;
      host.persistDashboardUiState();
      host.openTmuxDashboardTarget();
      void host.refreshCoordinationFromService?.().catch(() => {});
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
    case "create-overseer": {
      const overseerId = findOverseerSessionId(loadMetadataState());
      const liveOverseer =
        !!overseerId &&
        listTopologySessionStates({ statuses: ["running", "idle"] }).some((session) => session.id === overseerId);
      if (liveOverseer && typeof host.openLiveTmuxWindowForEntry === "function") {
        // "opened" → entered; "error" → already surfaced. Only a stale ("missing")
        // session should fall through to creating a fresh overseer.
        const result = host.openLiveTmuxWindowForEntry({ id: overseerId });
        if (result !== "missing") break;
      }
      host.showToolPicker(undefined, { overseer: true });
      break;
    }
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
      void host.handleReviewRequest();
      break;
  }
}
