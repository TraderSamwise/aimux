import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join as pathJoin, resolve as pathResolve, dirname as pathDirname } from "node:path";
import { Multiplexer } from "./multiplexer/index.js";
import { llmCompact } from "./context/compactor.js";
import { initProject, loadConfig } from "./config.js";
import {
  initPaths,
  getHistoryDir,
  getContextDir,
  getProjectId,
  getRepoRoot,
  getDaemonLogPath,
  getProjectLogPath,
  getProjectStateDirFor,
  getRuntimeTopologyPath,
} from "./paths.js";
import { loadTeamConfig, saveTeamConfig, getDefaultTeamConfig } from "./team.js";
import { AIMUX_VERSION } from "./version.js";
import { findMainRepo, listWorktrees, type WorktreeInfo } from "./worktree.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import {
  buildTmuxDoctorReport,
  renderTmuxDoctorReport,
  renderTmuxRepairResult,
  repairTmuxRuntime,
} from "./tmux/doctor.js";
import {
  loadMetadataEndpoint,
  resolveProjectServiceEndpoint as resolveStoredProjectServiceEndpoint,
  updateSessionMetadata,
  clearSessionLogs,
  type MetadataTone,
  type SessionContextMetadata,
  type SessionServiceMetadata,
  removeMetadataEndpoint,
} from "./metadata-store.js";
import { AgentTracker } from "./agent-tracker.js";
import type { AgentActivityState, AgentAttentionState, AgentEventKind } from "./agent-events.js";
import { listDesktopProjects } from "./project-scanner.js";
import {
  AimuxDaemon,
  ensureDaemonRunning,
  ensureProjectService,
  getDaemonHost,
  getDaemonPort,
  loadDaemonInfo,
  loadDaemonState,
  projectServiceStatus,
  requestDaemonJson,
  stopDaemon,
  stopProjectService,
} from "./daemon.js";
import { getProjectServiceManifest, manifestsMatch, type ProjectServiceManifest } from "./project-service-manifest.js";
import {
  listThreadSummaries,
  readMessages,
  readThread,
  type MessageKind,
  type ThreadKind,
  type ThreadStatus,
} from "./threads.js";
import { runLoginFlow } from "./login-flow.js";
import { clearCredentials, loadCredentials, setRemoteEnabled } from "./credentials.js";
import { takeOverProjectFromOtherOwners } from "./project-takeover.js";
import { readAllTasks, readTask } from "./tasks.js";
import {
  buildDesktopNotifierDoctorReport,
  renderDesktopNotifierDoctorReport,
  sendDesktopNotificationAndWait,
} from "./desktop-notifier.js";
import {
  parseClaudeHookPayload,
  permissionRequestHookOutput,
  summarizeClaudeNotification,
  summarizeClaudePermissionRequest,
  summarizeClaudeStop,
} from "./claude-hooks.js";
import { parseCodexHookPayload } from "./codex-hooks.js";
import { requestJson } from "./http-client.js";
import { runTmuxSwitcher } from "./tmux/switcher.js";
import { registerExposeCommand } from "./popup-expose.js";
import { runTmuxMetaDashboard } from "./tmux/meta-dashboard.js";
import { runTmuxInboxPopup } from "./tmux/inbox-popup.js";
import { buildDebugStateReport, renderDebugStateReport } from "./debug-state.js";
import { findLiveDashboardTarget, openDashboardTarget, resolveDashboardTarget } from "./dashboard/targets.js";
import { invalidateTmuxStatuslineArtifacts } from "./tmux/statusline-cache.js";
import { loadStatusline, renderTmuxStatuslineFromData } from "./tmux/statusline.js";
import { persistProjectRuntimeSnapshotsBeforeTmuxStop } from "./multiplexer/service-state-snapshot.js";
import { configureLogging, debug, log, resolveLoggingRuntimeConfig, type LoggingCliOptions } from "./debug.js";
import { writeTextAtomic } from "./atomic-write.js";
import { createRuntimeTopologyStore } from "./runtime-core/topology-store.js";
import { listTopologySessionStates } from "./runtime-core/topology-sessions.js";
import { recordTopologyBackendSessionId } from "./runtime-core/backend-session-ids.js";
import { reconcileOfflineBackendSessionIds } from "./runtime-core/backend-id-reconcile.js";
import {
  listTopologyWorktreeGraveyard,
  listTopologyWorktreeGraveyardPaths,
} from "./runtime-core/topology-worktrees.js";
import { buildGraveyardCleanupPlan, runGraveyardCleanup, type GraveyardCleanupRunResult } from "./graveyard-cleanup.js";
import {
  buildRuntimeMigrationReport,
  importRuntimeMigration,
  renderRuntimeMigrationImportResult,
  renderRuntimeMigrationReport,
  renderRuntimeMigrationRollbackResult,
  rollbackRuntimeMigration,
} from "./runtime-migration.js";
import {
  DEFAULT_LOCAL_UI_HOST,
  DEFAULT_LOCAL_UI_PORT,
  openUrlInBrowser,
  startLocalUiServer,
} from "./local-ui-server.js";
import { buildRuntimeCoherenceReport, renderRuntimeCoherenceReport } from "./runtime-coherence.js";
import { renderRuntimeRestartResult, restartAimuxControlPlane } from "./runtime-restart.js";
const program = new Command();

class ProjectServiceVersionError extends Error {
  constructor(
    message: string,
    readonly projectRoot: string,
    readonly expected: ProjectServiceManifest,
    readonly actual: ProjectServiceManifest | null,
  ) {
    super(message);
    this.name = "ProjectServiceVersionError";
  }
}

function renderProjectServiceVersionHelp(error: ProjectServiceVersionError): string {
  const lines = [
    "aimux: the running project service is from a different local build.",
    "",
    `Project: ${error.projectRoot}`,
    `Expected build: ${error.expected.buildStamp}`,
    `Running build: ${error.actual?.buildStamp ?? "unknown"}`,
    "",
    "Restart the local aimux control plane, then retry:",
    "  aimux restart",
    "",
    "Inspect the local version inventory with:",
    "  aimux doctor versions",
  ];
  return lines.join("\n");
}

async function restartStaleControlPlane(projectRoot: string): Promise<void> {
  console.error(`aimux: restarting stale daemon-managed control plane for ${projectRoot}...`);
  log.warn("restarting stale control plane", "runtime", { projectRoot });
  removeMetadataEndpoint(projectRoot);
  const result = await restartAimuxControlPlane({ projectRoot });
  const project = result.projects.find((entry) => entry.projectRoot === projectRoot);
  if (project?.service.status === "failed") {
    throw new Error(project.service.error ?? "failed to restart project service");
  }
}

async function fetchProjectServiceHealth(endpoint: { host: string; port: number }): Promise<{
  serviceInfo?: ProjectServiceManifest;
  pid?: number;
}> {
  const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}/health`, {
    timeoutMs: 1000,
  });
  if (status < 200 || status >= 300 || json?.ok === false) {
    throw new Error(json?.error || `health request failed: ${status}`);
  }
  return json as { serviceInfo?: ProjectServiceManifest; pid?: number };
}

async function waitForVerifiedProjectService(
  projectRoot: string,
  opts?: { timeoutMs?: number },
): Promise<{
  endpoint: { host: string; port: number };
  health: { serviceInfo?: ProjectServiceManifest; pid?: number };
}> {
  const expected = getProjectServiceManifest();
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastError = "project service did not become reachable";
  let lastServiceInfo: unknown = null;
  let respawnAttempted = false;
  let missingEndpointSince = 0;

  while (Date.now() < deadline) {
    const endpoint = await resolveProjectServiceEndpoint(projectRoot);
    if (endpoint) {
      missingEndpointSince = 0;
      try {
        const health = await fetchProjectServiceHealth(endpoint);
        lastServiceInfo = health.serviceInfo ?? null;
        if (manifestsMatch(expected, health.serviceInfo)) {
          log.info("project service verified", "runtime", {
            projectRoot,
            endpoint,
            pid: health.pid,
            elapsedMs: Date.now() - startedAt,
          });
          return { endpoint, health };
        }
        lastError = `project service manifest mismatch: expected ${JSON.stringify(expected)} actual ${JSON.stringify(health.serviceInfo ?? null)}`;
        log.warn("project service manifest mismatch", "runtime", {
          projectRoot,
          endpoint,
          expected,
          actual: health.serviceInfo ?? null,
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (
          !respawnAttempted &&
          typeof lastError === "string" &&
          (lastError.includes("ECONNREFUSED") ||
            lastError.includes("ECONNRESET") ||
            lastError.includes("socket hang up"))
        ) {
          respawnAttempted = true;
          log.warn("respawning project service after connection failure", "runtime", {
            projectRoot,
            endpoint,
            error: lastError,
          });
          removeMetadataEndpoint(projectRoot);
          await ensureProjectService(projectRoot);
        }
      }
    } else {
      lastError = "no live project service metadata endpoint";
      if (!missingEndpointSince) {
        missingEndpointSince = Date.now();
      } else if (!respawnAttempted && Date.now() - missingEndpointSince >= 1000) {
        respawnAttempted = true;
        log.warn("respawning project service after missing endpoint", "runtime", { projectRoot });
        await stopProjectService(projectRoot);
        removeMetadataEndpoint(projectRoot);
        await ensureProjectService(projectRoot);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (
    lastError.startsWith("project service manifest mismatch") &&
    lastServiceInfo &&
    typeof lastServiceInfo === "object"
  ) {
    throw new ProjectServiceVersionError(lastError, projectRoot, expected, lastServiceInfo as ProjectServiceManifest);
  }

  const elapsedMs = Date.now() - startedAt;
  const elapsedSeconds = (elapsedMs / 1000).toFixed(1);
  throw new Error(
    `project service did not become ready after ${elapsedSeconds}s (budget ${timeoutMs}ms); last error: ${lastError}${
      lastServiceInfo ? `; last serviceInfo=${JSON.stringify(lastServiceInfo)}` : ""
    }`,
  );
}

function rewriteLocalStatuslineArtifacts(
  projectRoot: string,
  tmux: TmuxRuntimeManager,
  dashboardSessionName?: string,
): void {
  const data = loadStatusline(projectRoot);
  if (!data) return;
  const statusDir = pathJoin(getProjectStateDirFor(projectRoot), "tmux-statusline");
  mkdirSync(statusDir, { recursive: true });

  const writeStatusFile = (name: string, content: string): void => {
    // Statusline files are cosmetic tmux chrome and can be written concurrently by
    // multiple clients/refreshes. Use the unique-temp atomic writer (never a shared
    // ".tmp" that racing writers rename out from under each other), and never let a
    // write failure abort dashboard startup.
    try {
      writeTextAtomic(pathJoin(statusDir, name), `${content}\n`);
    } catch (error) {
      debug(
        `statusline write failed for ${name}: ${error instanceof Error ? error.message : String(error)}`,
        "statusline",
      );
    }
  };

  const dashboardTop = renderTmuxStatuslineFromData(data, projectRoot, "top", {
    currentWindow: "dashboard",
    currentPath: projectRoot,
  });
  const dashboardBottom = renderTmuxStatuslineFromData(data, projectRoot, "bottom", {
    currentWindow: "dashboard",
    currentPath: projectRoot,
    currentSession: dashboardSessionName,
  });
  writeStatusFile("top-dashboard.txt", dashboardTop);
  writeStatusFile("bottom-dashboard.txt", dashboardBottom);
  if (dashboardSessionName) {
    writeStatusFile(`bottom-dashboard-${dashboardSessionName}.txt`, dashboardBottom);
  }

  for (const entry of [...(data.sessions ?? []), ...(data.teammates ?? [])]) {
    if (!entry.tmuxWindowId) continue;
    const renderOptions = {
      currentWindow: entry.windowName,
      currentWindowId: entry.tmuxWindowId,
      currentPath: entry.worktreePath ?? projectRoot,
    };
    writeStatusFile(
      `top-${entry.tmuxWindowId}.txt`,
      renderTmuxStatuslineFromData(data, projectRoot, "top", renderOptions),
    );
    writeStatusFile(
      `bottom-${entry.tmuxWindowId}.txt`,
      renderTmuxStatuslineFromData(data, projectRoot, "bottom", renderOptions),
    );
  }

  tmux.refreshStatus();
}

async function postProjectServiceJson(path: string, body: unknown, options?: { timeoutMs?: number }): Promise<any> {
  let endpoint = await resolveProjectServiceEndpoint();
  if (!endpoint) {
    await ensureDaemonProjectReady(resolveProjectRoot(process.cwd()));
    endpoint = await resolveProjectServiceEndpoint();
  }
  if (!endpoint) {
    throw new Error("no live project service metadata endpoint");
  }
  const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    timeoutMs: options?.timeoutMs,
  });
  if (status < 200 || status >= 300 || json?.ok === false) {
    throw new Error(json?.error || `request failed: ${status}`);
  }
  return json;
}

async function getProjectServiceJson(path: string): Promise<any> {
  let endpoint = await resolveProjectServiceEndpoint();
  if (!endpoint) {
    await ensureDaemonProjectReady(resolveProjectRoot(process.cwd()));
    endpoint = await resolveProjectServiceEndpoint();
  }
  if (!endpoint) {
    throw new Error("no live project service metadata endpoint");
  }
  const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}${path}`);
  if (status < 200 || status >= 300 || json?.ok === false) {
    throw new Error(json?.error || `request failed: ${status}`);
  }
  return json;
}

function notificationQuery(opts: { unread?: boolean; session?: string }): string {
  const query = new URLSearchParams();
  if (opts.unread) query.set("unread", "1");
  const sessionId = opts.session?.trim();
  if (sessionId) query.set("sessionId", sessionId);
  const rendered = query.toString();
  return rendered ? `?${rendered}` : "";
}

async function getProjectServiceJsonOrLocal(path: string, fallback: () => any): Promise<any> {
  try {
    return await getProjectServiceJson(path);
  } catch {
    return fallback();
  }
}

function exitAfterOpen(): never {
  process.exit(0);
}

/** Shared by the claude + codex permission hooks: register a permission interaction
 * and long-poll for a decision, returning the hook stdout ({} defers to the native prompt). */
async function resolvePermissionRequestOutput(
  projectRoot: string,
  sessionId: string,
  payload: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string },
): Promise<Record<string, unknown>> {
  try {
    const { toolName, input, summary } = summarizeClaudePermissionRequest(payload);
    // The hook runs in the agent's working dir, which is the worktree (or the
    // project root if no worktree). Carry it so clients can show project/worktree.
    const cwd = (typeof payload.cwd === "string" && payload.cwd) || process.cwd();
    const result = await postHookProjectServiceJsonOrLocal(
      projectRoot,
      "/agents/interaction/request",
      { session: sessionId, type: "permission", payload: { toolName, input, cwd }, summary, timeoutMs: 115_000 },
      () => ({}),
    );
    if (result?.request?.status === "resolved") {
      return permissionRequestHookOutput(result.request.response?.decision);
    }
  } catch {
    /* fall through to the native prompt */
  }
  return {};
}

async function postLiveProjectServiceJsonOrLocal(
  projectRoot: string,
  path: string,
  body: unknown,
  fallback: () => any,
  options: { fallbackOnRequestError?: boolean } = {},
): Promise<any> {
  let endpoint;
  try {
    endpoint = await resolveProjectServiceEndpoint(projectRoot);
  } catch {
    return fallback();
  }
  if (!endpoint) {
    return fallback();
  }
  let status: number;
  let json: any;
  try {
    ({ status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
  } catch (error) {
    if (!options.fallbackOnRequestError) throw error;
    return fallback();
  }
  if (status === 404 || status === 405 || status === 501) {
    return fallback();
  }
  if (status < 200 || status >= 300 || json?.ok === false) {
    throw new Error(json?.error || `request failed: ${status}`);
  }
  return json;
}

async function postHookProjectServiceJsonOrLocal(
  projectRoot: string,
  path: string,
  body: unknown,
  fallback: () => any,
): Promise<any> {
  return postLiveProjectServiceJsonOrLocal(projectRoot, path, body, fallback, { fallbackOnRequestError: true });
}

async function clearHookNotificationsViaService(projectRoot: string, sessionId: string): Promise<void> {
  try {
    await postLiveProjectServiceJsonOrLocal(projectRoot, "/notifications/clear", { sessionId }, () => {
      throw new Error("project service unavailable");
    });
  } catch (error) {
    debug(
      `failed to clear notifications via project service for ${sessionId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "session",
    );
  }
}

async function getLiveProjectServiceJsonOrLocal(projectRoot: string, path: string, fallback: () => any): Promise<any> {
  let endpoint;
  try {
    endpoint = await resolveProjectServiceEndpoint(projectRoot);
  } catch {
    return fallback();
  }
  if (!endpoint) {
    return fallback();
  }
  let status: number;
  let json: any;
  try {
    ({ status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}${path}`, {
      method: "GET",
    }));
  } catch {
    return fallback();
  }
  if (status === 404 || status === 405 || status === 501) {
    return fallback();
  }
  if (status < 200 || status >= 300 || json?.ok === false) {
    throw new Error(json?.error || `request failed: ${status}`);
  }
  return json;
}

async function resolveClaudeHookSessionId(explicitSessionId: string, payloadSessionId?: string): Promise<string> {
  if (!payloadSessionId) return explicitSessionId;
  const match = listTopologySessionStates().find((session) => session.backendSessionId === payloadSessionId);
  return match?.id ?? explicitSessionId;
}

function recordBackendSessionIdInTopology(
  projectRoot: string,
  sessionId: string,
  backendSessionId: string,
): { ok: true; sessionId: string; backendSessionId: string } {
  return {
    ok: true,
    ...recordTopologyBackendSessionId({ projectRoot, sessionId, backendSessionId }),
  };
}

async function recordBackendSessionIdForHook(
  projectRoot: string,
  sessionId: string,
  backendSessionId: string,
): Promise<{ ok: boolean; sessionId: string; backendSessionId?: string; error?: string }> {
  try {
    const result = await postHookProjectServiceJsonOrLocal(
      projectRoot,
      "/agents/record-backend-session",
      { sessionId, backendSessionId },
      () => recordBackendSessionIdInTopology(projectRoot, sessionId, backendSessionId),
    );
    return { ok: true, sessionId: result.sessionId ?? sessionId, backendSessionId: result.backendSessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug(`backend session id capture failed for ${sessionId}: ${message}`, "session");
    return { ok: false, sessionId, backendSessionId, error: message };
  }
}

async function resolveProjectServiceEndpoint(projectRoot = resolveProjectRoot(process.cwd())): Promise<{
  host: string;
  port: number;
} | null> {
  return resolveStoredProjectServiceEndpoint(projectRoot);
}

async function getProjectServiceEndpoint(projectRoot = resolveProjectRoot(process.cwd())): Promise<{
  host: string;
  port: number;
}> {
  let endpoint = await resolveProjectServiceEndpoint(projectRoot);
  if (!endpoint) {
    await ensureProjectService(projectRoot);
    endpoint = await resolveProjectServiceEndpoint(projectRoot);
  }
  if (!endpoint) {
    throw new Error("no live project service metadata endpoint");
  }
  return endpoint;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function ensureDaemonProjectReady(projectRoot: string, opts?: { repairVersionDrift?: boolean }): Promise<void> {
  await ensureDaemonRunning();
  await ensureProjectService(projectRoot);
  try {
    await waitForVerifiedProjectService(projectRoot);
  } catch (error) {
    if (opts?.repairVersionDrift === false) {
      throw error;
    }
    if (!(error instanceof ProjectServiceVersionError) && !(error instanceof Error)) {
      throw error;
    }
    await restartStaleControlPlane(projectRoot);
    try {
      await waitForVerifiedProjectService(projectRoot, { timeoutMs: 15_000 });
    } catch {
      await ensureProjectService(projectRoot);
      await waitForVerifiedProjectService(projectRoot, { timeoutMs: 15_000 });
    }
  }
}

async function ensureDaemonProjectSpawned(projectRoot: string): Promise<void> {
  await ensureDaemonRunning();
  await ensureProjectService(projectRoot);
}

function listManagedProjectSessionNames(tmux: TmuxRuntimeManager, projectRoot: string): string[] {
  const hostSession = tmux.getProjectSession(projectRoot).sessionName;
  return tmux
    .listSessionNames()
    .filter((sessionName) => sessionName === hostSession || sessionName.startsWith(`${hostSession}-client-`))
    .sort((a, b) => {
      const aIsHost = a === hostSession ? 1 : 0;
      const bIsHost = b === hostSession ? 1 : 0;
      return aIsHost - bIsHost;
    });
}

function stopProjectTmuxRuntime(tmux: TmuxRuntimeManager, projectRoot: string): string[] {
  const killed: string[] = [];
  for (const sessionName of listManagedProjectSessionNames(tmux, projectRoot)) {
    if (!tmux.hasSession(sessionName)) continue;
    tmux.killSession(sessionName);
    killed.push(sessionName);
  }
  return killed;
}

async function waitForProcessExit(pid: number, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopProjectRuntime(
  projectRoot: string,
): Promise<{ projectServiceStopped: boolean; tmuxSessionsKilled: string[] }> {
  const tmux = new TmuxRuntimeManager();
  if (tmux.isAvailable()) {
    persistProjectRuntimeSnapshotsBeforeTmuxStop(projectRoot, tmux);
  }
  const projectService = await stopProjectService(projectRoot);
  if (projectService?.pid) {
    await waitForProcessExit(projectService.pid);
  }
  removeMetadataEndpoint(projectRoot);
  const tmuxSessionsKilled = tmux.isAvailable() ? stopProjectTmuxRuntime(tmux, projectRoot) : [];
  return {
    projectServiceStopped: Boolean(projectService),
    tmuxSessionsKilled,
  };
}

async function restartProjectRuntime(
  projectRoot: string,
  opts: { open?: boolean } = {},
): Promise<{
  dashboardSessionName: string;
  dashboardTarget: ReturnType<typeof resolveDashboardTarget>["dashboardTarget"];
}> {
  await stopProjectRuntime(projectRoot);
  await ensureDaemonProjectSpawned(projectRoot);
  const tmux = new TmuxRuntimeManager();
  ensureTmuxAvailable(tmux);
  const resolved = resolveDashboardTarget(projectRoot, tmux, { forceReload: true });
  if (opts.open) {
    tmux.openTarget(resolved.dashboardTarget, { insideTmux: tmux.isInsideTmux(), alreadyResolved: true });
  }
  return {
    dashboardSessionName: resolved.dashboardSession.sessionName,
    dashboardTarget: resolved.dashboardTarget,
  };
}

function resolveProjectRoot(cwd: string): string {
  try {
    return findMainRepo(cwd);
  } catch {
    return cwd;
  }
}

function ensureTmuxAvailable(tmux: TmuxRuntimeManager): void {
  if (!tmux.isAvailable()) {
    console.error("aimux: tmux is not installed or not available in PATH");
    process.exit(1);
  }
}

function commandPath(command: Command): string[] {
  const names: string[] = [];
  let current: Command | null = command;
  while (current) {
    const name = current.name();
    if (name) names.unshift(name);
    current = current.parent ?? null;
  }
  return names;
}

function loggingProcessKind(command: Command): "cli" | "daemon" | "project-service" {
  const names = commandPath(command);
  if (names.at(-1) === "__project-service-internal") return "project-service";
  if (names.at(-2) === "daemon" && names.at(-1) === "run") return "daemon";
  return "cli";
}

function configureLoggingForCommand(command: Command): void {
  const processKind = loggingProcessKind(command);
  const config = loadConfig();
  const path = processKind === "daemon" ? getDaemonLogPath() : getProjectLogPath();
  const cli = program.opts<LoggingCliOptions>();
  const resolved = resolveLoggingRuntimeConfig({
    config: config.logging,
    env: process.env,
    cli,
    path,
    processKind,
    projectId: getProjectId(),
    projectRoot: getRepoRoot(),
  });
  configureLogging(resolved);
  log.info("logging configured", "logging", {
    path: resolved.path,
    level: resolved.level,
    categories: resolved.categories,
  });
}

function parseLineCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "80", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 80;
}

function parsePortOption(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Port must be an integer between 1 and 65535, got ${value}`);
  }
  return parsed;
}

function selectedLogPath(opts: { daemon?: boolean }): string {
  return opts.daemon ? getDaemonLogPath() : getProjectLogPath();
}

function readLastLogLines(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  const allLines = content.split(/\r?\n/);
  if (allLines.at(-1) === "") allLines.pop();
  return allLines.slice(-lines).join("\n");
}

program
  .name("aimux")
  .description("Native CLI agent multiplexer")
  .version(AIMUX_VERSION)
  .argument("[tool]", "Tool to run (e.g. claude, codex, aider)")
  .argument("[args...]", "Arguments to pass to the tool")
  .option("--resume", "Resume previous sessions using native tool resume")
  .option("--restore", "Start fresh sessions with injected history context")
  .option("--tmux-dashboard-internal", "Internal tmux dashboard entrypoint")
  .option("--debug", "Enable debug logging for this process")
  .option("--trace", "Enable trace logging for this process")
  .option("--log-level <level>", "Enable logging at level: error|warn|info|debug|trace")
  .option("--log-category <categories>", "Comma-separated log categories to include")
  .hook("preAction", async (_thisCommand, actionCommand) => {
    const names = commandPath(actionCommand);
    const isMigrationAudit = names.at(-2) === "migration" && names.at(-1) === "audit";
    if (isMigrationAudit) {
      return;
    }
    const opts = typeof actionCommand?.opts === "function" ? actionCommand.opts() : {};
    const requestedProject =
      typeof opts.project === "string"
        ? opts.project
        : typeof opts.projectRoot === "string"
          ? opts.projectRoot
          : typeof opts["project-root"] === "string"
            ? opts["project-root"]
            : undefined;
    const projectRoot = requestedProject ? resolveProjectRoot(pathResolve(requestedProject)) : undefined;
    await initPaths(projectRoot);
    configureLoggingForCommand(actionCommand);
  })
  .action(
    async (
      tool: string | undefined,
      args: string[],
      opts: { resume?: boolean; restore?: boolean; tmuxDashboardInternal?: boolean },
    ) => {
      const originalCwd = process.cwd();
      const dashboardMode = !tool && !opts.resume && !opts.restore;
      const shouldAnchorToMainRepo = opts.tmuxDashboardInternal || dashboardMode;
      let projectRoot = originalCwd;
      if (shouldAnchorToMainRepo) {
        try {
          projectRoot = findMainRepo(originalCwd);
        } catch {
          projectRoot = originalCwd;
        }
        if (projectRoot !== originalCwd) {
          process.chdir(projectRoot);
        }
      }
      await initPaths(projectRoot);
      if (opts.tmuxDashboardInternal) {
        await ensureDaemonProjectSpawned(projectRoot);
      } else {
        initProject();
        const tmux = new TmuxRuntimeManager();
        ensureTmuxAvailable(tmux);
        if (!tool && !opts.resume && !opts.restore) {
          await takeOverProjectFromOtherOwners(projectRoot);
          await ensureDaemonProjectReady(projectRoot);
          const liveDashboard = findLiveDashboardTarget(projectRoot, tmux);
          if (liveDashboard) {
            tmux.openTarget(liveDashboard.dashboardTarget, {
              insideTmux: tmux.isInsideTmux(),
              alreadyResolved: true,
            });
            exitAfterOpen();
          }
        }
        await ensureDaemonProjectReady(projectRoot);
        if (!tool && !opts.resume && !opts.restore) {
          openDashboardTarget(projectRoot, tmux);
          exitAfterOpen();
        }
      }

      const mux = new Multiplexer();
      let cleanedUp = false;
      const ensureTerminalRestored = () => mux.cleanupTerminalOnly();
      const cleanupAll = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        mux.cleanup();
      };

      // Graceful shutdown on signals
      const shutdown = () => {
        cleanupAll();
        process.exit(0);
      };
      process.on("exit", ensureTerminalRestored);
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.on("uncaughtException", (err) => {
        cleanupAll();
        log.error("uncaught exception", "runtime", {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        console.error(err);
        process.exit(1);
      });
      process.on("unhandledRejection", (reason) => {
        cleanupAll();
        log.error("unhandled rejection", "runtime", {
          error: reason instanceof Error ? reason.message : String(reason),
          stack: reason instanceof Error ? reason.stack : undefined,
        });
        console.error(reason);
        process.exit(1);
      });

      try {
        let exitCode: number;
        if (opts.resume) {
          exitCode = await mux.resumeSessions(tool);
        } else if (opts.restore) {
          exitCode = await mux.restoreSessions(tool);
        } else if (tool) {
          exitCode = await mux.run({ command: tool, args });
        } else {
          exitCode = await mux.runDashboard();
        }
        cleanupAll();
        process.exit(exitCode);
      } catch (err: unknown) {
        cleanupAll();
        if (err instanceof ProjectServiceVersionError) {
          console.error(renderProjectServiceVersionHelp(err));
          process.exit(1);
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error(tool ? `aimux: failed to spawn "${tool}": ${msg}` : `aimux: dashboard failed to start: ${msg}`);
        process.exit(1);
      }
    },
  );

program
  .command("init")
  .description("Initialize .aimux directory with default config and gitignore")
  .action(() => {
    initProject();
    console.log("Initialized .aimux/ with config.json and .gitignore");
  });

program
  .command("restart")
  .description("Restart local aimux control plane and reload all known dashboards")
  .option("--project <path>", "Reload only one project's dashboard while preserving known services")
  .option("--json", "Emit JSON")
  .action(async (opts: { project?: string; json?: boolean }) => {
    try {
      const projectRoot = opts.project ? resolveProjectRoot(pathResolve(opts.project)) : undefined;
      const result = await restartAimuxControlPlane({ projectRoot });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        if (result.summary.failures > 0) process.exitCode = 1;
        return;
      }
      console.log(renderRuntimeRestartResult(result));
      if (result.summary.failures > 0) process.exitCode = 1;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("dashboard-reload")
  .description("Recreate and optionally reopen the dashboard window only")
  .option("--open", "Open the dashboard after reloading")
  .action(async (opts: { open?: boolean }) => {
    try {
      const originalCwd = process.cwd();
      const projectRoot = resolveProjectRoot(originalCwd);
      await ensureDaemonProjectReady(projectRoot);
      invalidateTmuxStatuslineArtifacts(projectRoot);

      const tmux = new TmuxRuntimeManager();
      ensureTmuxAvailable(tmux);
      const { dashboardSession, dashboardTarget } = resolveDashboardTarget(projectRoot, tmux, { forceReload: true });
      try {
        await postProjectServiceJson("/statusline/refresh", { force: true }, { timeoutMs: 1500 });
      } catch {}
      rewriteLocalStatuslineArtifacts(projectRoot, tmux, dashboardSession.sessionName);

      if (opts.open) {
        tmux.openTarget(dashboardTarget, { insideTmux: tmux.isInsideTmux(), alreadyResolved: true });
        exitAfterOpen();
      }

      console.log(`Reloaded dashboard for ${dashboardSession.sessionName}`);
    } catch (err: unknown) {
      if (err instanceof ProjectServiceVersionError) {
        console.error(renderProjectServiceVersionHelp(err));
        process.exit(1);
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("stop [sessionId]")
  .description("Stop the current project runtime, or stop a specific running agent by session ID")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (sessionId: string | undefined, opts: { project?: string; json?: boolean }) => {
    try {
      if (sessionId) {
        const projectRoot = await prepareProjectContext(opts.project);
        await ensureDaemonProjectReady(projectRoot);
        const result = await postLiveProjectServiceJsonOrLocal(projectRoot, "/agents/stop", { sessionId }, () => {
          const mux = new Multiplexer();
          return mux.stopAgent(sessionId);
        });
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                ok: true,
                projectRoot,
                sessionId: result.sessionId,
                status: result.status,
              },
              null,
              2,
            ),
          );
          return;
        }
        console.log(`stopped ${result.sessionId}`);
        return;
      }

      const projectRoot = resolveProjectRoot(opts.project ?? process.cwd());
      await initPaths(projectRoot);
      const result = await stopProjectRuntime(projectRoot);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              projectServiceStopped: result.projectServiceStopped,
              tmuxSessionsKilled: result.tmuxSessionsKilled,
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
        return;
      }
      console.log(`Stopped project runtime for ${projectRoot}`);
      if (result.tmuxSessionsKilled.length > 0) {
        console.log(`Removed tmux sessions: ${result.tmuxSessionsKilled.join(", ")}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("restart-runtime")
  .description("Hard restart the current project runtime and rebuild its managed tmux topology")
  .option("--project-root <path>", "Project root", process.cwd())
  .option("--open", "Open the dashboard after restarting the runtime")
  .option("--json", "Emit JSON")
  .action(async (opts: { projectRoot: string; open?: boolean; json?: boolean }) => {
    try {
      const projectRoot = resolveProjectRoot(opts.projectRoot);
      await initPaths(projectRoot);
      const result = await restartProjectRuntime(projectRoot, { open: opts.open });
      if (opts.open) exitAfterOpen();
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              dashboardSession: result.dashboardSessionName,
              dashboardTarget: result.dashboardTarget,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`Restarted project runtime for ${projectRoot}`);
      console.log(`Dashboard: ${result.dashboardSessionName}:${result.dashboardTarget.windowIndex}`);
    } catch (err: unknown) {
      if (err instanceof ProjectServiceVersionError) {
        console.error(renderProjectServiceVersionHelp(err));
        process.exit(1);
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

const hostCmd = program
  .command("host")
  .description("Advanced compatibility wrappers for legacy daemon-managed project services");

program
  .command("ui")
  .description("Run the first-party local web UI from the built app bundle")
  .option("--host <host>", "Loopback host to bind", DEFAULT_LOCAL_UI_HOST)
  .option("--port <port>", "Local UI port", String(DEFAULT_LOCAL_UI_PORT))
  .option("--daemon-url <url>", "Daemon URL for the UI to call")
  .option("--no-daemon", "Do not ensure the local daemon before serving")
  .option("--open", "Open the UI in the default browser")
  .action(async (opts: { host?: string; port?: string; daemonUrl?: string; daemon?: boolean; open?: boolean }) => {
    try {
      const shouldEnsureDaemon = opts.daemon !== false;
      const daemonInfo = shouldEnsureDaemon ? await ensureDaemonRunning() : null;
      const daemonUrl = opts.daemonUrl?.trim() || `http://${getDaemonHost()}:${daemonInfo?.port ?? getDaemonPort()}`;
      const server = await startLocalUiServer({
        host: opts.host,
        port: parsePortOption(opts.port, DEFAULT_LOCAL_UI_PORT),
        config: {
          connectionMode: "local",
          daemonUrl,
        },
      });
      console.log(`aimux UI: ${server.url}`);
      console.log(`Daemon: ${daemonUrl}`);
      console.log("Press Ctrl-C to stop.");
      if (opts.open) {
        openUrlInBrowser(server.url);
      }
      const shutdown = async () => {
        await server.close();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
      await new Promise(() => {});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("serve")
  .description("Advanced: ensure the legacy daemon-backed project control service is running")
  .action(async () => {
    const projectRoot = resolveProjectRoot(process.cwd());
    if (projectRoot !== process.cwd()) {
      process.chdir(projectRoot);
    }
    await initPaths(projectRoot);
    await ensureDaemonProjectReady(projectRoot);
    const status = await projectServiceStatus(projectRoot);
    console.log(`aimux serve: daemon managing ${projectRoot}${status ? ` (service pid ${status.pid})` : ""}`);
  });

hostCmd
  .command("status")
  .description("Show current project control-service status")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    await initPaths();
    await ensureDaemonRunning();
    const projectRoot = resolveProjectRoot(process.cwd());
    const project = await projectServiceStatus(projectRoot);
    const endpoint = await resolveProjectServiceEndpoint(projectRoot);
    const expectedServiceManifest = getProjectServiceManifest();
    let liveServiceHealth: { serviceInfo?: ProjectServiceManifest; pid?: number } | null = null;
    if (endpoint) {
      try {
        liveServiceHealth = await fetchProjectServiceHealth(endpoint);
      } catch {}
    }
    const tmux = new TmuxRuntimeManager();
    const session = tmux.getProjectSession(projectRoot);
    const payload = {
      projectRoot,
      sessionName: session.sessionName,
      daemon: loadDaemonInfo(),
      projectService: project,
      metadataEndpoint: endpoint,
      expectedServiceManifest,
      liveServiceHealth,
    };
    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (!project) {
      console.log(`No live control service for ${session.sessionName}`);
      return;
    }
    console.log(`Service pid=${project.pid}`);
    console.log(`Started: ${project.startedAt}`);
    console.log(`Metadata: ${endpoint ? `http://${endpoint.host}:${endpoint.port}` : "not running"}`);
    console.log(`Expected manifest: ${JSON.stringify(expectedServiceManifest)}`);
    if (liveServiceHealth?.serviceInfo) {
      console.log(`Live manifest: ${JSON.stringify(liveServiceHealth.serviceInfo)}`);
    }
    console.log(`Tmux session: ${session.sessionName}`);
  });

hostCmd
  .command("stop")
  .description("Stop the current project's daemon-managed control service")
  .action(async () => {
    await initPaths();
    const projectRoot = resolveProjectRoot(process.cwd());
    const result = await stopProjectService(projectRoot);
    if (!result) {
      console.log("No live project service to stop.");
      return;
    }
    removeMetadataEndpoint();
    console.log(`Stopped project service pid ${result.pid}`);
  });

hostCmd
  .command("kill")
  .description("Force kill the current project's daemon-managed control service")
  .action(async () => {
    await initPaths();
    const projectRoot = resolveProjectRoot(process.cwd());
    const result = await stopProjectService(projectRoot);
    if (!result) {
      console.log("No live project service to kill.");
      return;
    }
    removeMetadataEndpoint();
    console.log(`Killed project service pid ${result.pid}`);
  });

hostCmd
  .command("restart")
  .description("Restart the current project's daemon-managed control service")
  .option("--open", "Open the dashboard after restarting")
  .option("--serve", "Restart the project service without reopening the dashboard")
  .action(async (opts: { open?: boolean; serve?: boolean }) => {
    await initPaths();
    const projectRoot = resolveProjectRoot(process.cwd());
    await stopProjectService(projectRoot);
    removeMetadataEndpoint();
    await ensureDaemonProjectReady(projectRoot);
    if (opts.serve) {
      console.log(`Restarted project service for ${projectRoot}`);
      return;
    }
    const tmux = new TmuxRuntimeManager();
    ensureTmuxAvailable(tmux);
    const { dashboardSession, dashboardTarget } = resolveDashboardTarget(projectRoot, tmux, { forceReload: true });
    if (opts.open) {
      tmux.openTarget(dashboardTarget, { insideTmux: tmux.isInsideTmux(), alreadyResolved: true });
      return;
    }
    console.log(`Restarted project service for ${dashboardSession.sessionName}`);
  });

hostCmd
  .command("topology")
  .description("Show the runtime topology YAML path or parsed contents")
  .option("--json", "Emit parsed topology JSON")
  .option("--raw", "Print raw YAML contents")
  .action(async (opts: { json?: boolean; raw?: boolean }) => {
    await initPaths();
    const path = getRuntimeTopologyPath();
    if (opts.json) {
      console.log(JSON.stringify(createRuntimeTopologyStore(path).read(), null, 2));
      return;
    }
    if (opts.raw) {
      console.log(readFileSync(path, "utf-8"));
      return;
    }
    console.log(path);
  });

hostCmd
  .command("agent-read")
  .description("Read captured output from a running agent session over the project HTTP service")
  .argument("<sessionId>", "Agent session ID")
  .option("--start-line <number>", "tmux capture-pane start line", "-120")
  .action(async (sessionId: string, opts: { startLine?: string }) => {
    await initPaths();
    const startLine = Number.parseInt(opts.startLine ?? "-120", 10);
    if (Number.isNaN(startLine)) {
      throw new Error("--start-line must be an integer");
    }
    const result = await getProjectServiceJson(
      `/agents/output?sessionId=${encodeURIComponent(sessionId)}&startLine=${encodeURIComponent(String(startLine))}`,
    );
    process.stdout.write(result.output ?? "");
    if ((result.output ?? "").length > 0 && !String(result.output).endsWith("\n")) {
      process.stdout.write("\n");
    }
  });

hostCmd
  .command("agent-stream")
  .description("Stream live captured output from a running agent session over SSE")
  .argument("<sessionId>", "Agent session ID")
  .option("--start-line <number>", "tmux capture-pane start line", "-120")
  .option("--interval-ms <number>", "Polling interval in milliseconds", "500")
  .action(async (sessionId: string, opts: { startLine?: string; intervalMs?: string }) => {
    await initPaths();
    const startLine = Number.parseInt(opts.startLine ?? "-120", 10);
    const intervalMs = Number.parseInt(opts.intervalMs ?? "500", 10);
    if (Number.isNaN(startLine)) {
      throw new Error("--start-line must be an integer");
    }
    if (Number.isNaN(intervalMs) || intervalMs < 100) {
      throw new Error("--interval-ms must be an integer >= 100");
    }

    const endpoint = await getProjectServiceEndpoint();
    const controller = new AbortController();
    const shutdown = () => controller.abort();
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    try {
      const res = await fetch(
        `http://${endpoint.host}:${endpoint.port}/agents/output/stream?sessionId=${encodeURIComponent(
          sessionId,
        )}&startLine=${encodeURIComponent(String(startLine))}&intervalMs=${encodeURIComponent(String(intervalMs))}`,
        {
          signal: controller.signal,
          headers: {
            accept: "text/event-stream",
          },
        },
      );
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error || `request failed: ${res.status}`);
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let lastOutput = "";

      const flushEventBlock = (block: string) => {
        const lines = block.split("\n");
        let eventName = "message";
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventName = line.slice("event:".length).trim();
            continue;
          }
          if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).trim());
          }
        }
        if (eventName === "ready") return;
        if (eventName === "error") {
          const payload = dataLines.length > 0 ? JSON.parse(dataLines.join("\n")) : {};
          throw new Error(payload?.error || `stream error for ${sessionId}`);
        }
        if (eventName !== "output" || dataLines.length === 0) return;
        const payload = JSON.parse(dataLines.join("\n")) as { output?: string };
        if (typeof payload.output === "string") {
          const nextOutput = payload.output;
          const renderText = nextOutput.startsWith(lastOutput)
            ? nextOutput.slice(lastOutput.length)
            : `${lastOutput ? "\n[aimux stream resync]\n" : ""}${nextOutput}`;
          lastOutput = nextOutput;
          if (!renderText) return;
          process.stdout.write(renderText);
          if (renderText.length > 0 && !renderText.endsWith("\n")) {
            process.stdout.write("\n");
          }
        }
      };

      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary).replace(/\r/g, "");
          buffer = buffer.slice(boundary + 2);
          if (block && !block.startsWith(":")) {
            flushEventBlock(block);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return;
      }
      throw error;
    } finally {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    }
  });

hostCmd.action(() => {
  console.log("`aimux host` is a compatibility alias for daemon-managed project services.");
});

const daemonCmd = program.command("daemon").description("Advanced: manage the global aimux control-plane daemon");

daemonCmd
  .command("run")
  .description("Internal daemon entrypoint")
  .action(async () => {
    const daemon = new AimuxDaemon();
    await daemon.start();
    const shutdown = () => {
      daemon.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => {});
  });

daemonCmd
  .command("ensure")
  .description("Ensure the global aimux daemon is running")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    const info = await ensureDaemonRunning();
    if (opts.json) {
      console.log(JSON.stringify({ daemon: info }, null, 2));
      return;
    }
    console.log(`aimux daemon: pid ${info.pid} on http://127.0.0.1:${info.port}`);
  });

daemonCmd
  .command("stop")
  .description("Stop the global aimux daemon")
  .action(async () => {
    const info = await stopDaemon("SIGTERM");
    if (!info) {
      console.log("aimux daemon is not running.");
      return;
    }
    console.log(`Stopped daemon pid ${info.pid}`);
  });

daemonCmd
  .command("kill")
  .description("Force kill the global aimux daemon")
  .action(async () => {
    const info = await stopDaemon("SIGKILL");
    if (!info) {
      console.log("aimux daemon is not running.");
      return;
    }
    console.log(`Killed daemon pid ${info.pid}`);
  });

daemonCmd
  .command("restart")
  .description("Compatibility alias for aimux restart")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    const result = await restartAimuxControlPlane();
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      if (result.summary.failures > 0) process.exitCode = 1;
      return;
    }
    console.log(renderRuntimeRestartResult(result));
    if (result.summary.failures > 0) process.exitCode = 1;
  });

daemonCmd
  .command("status")
  .description("Show daemon status")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    const info = loadDaemonInfo();
    const state = loadDaemonState();
    let relay: unknown = { status: "off" };
    if (info) {
      try {
        const result = await requestDaemonJson("/relay/status");
        relay = result.relay;
      } catch {
        // Relay status unavailable — leave as off.
      }
    }
    const payload = {
      daemon: info,
      projects: Object.values(state.projects),
      relay,
    };
    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (!info) {
      console.log("aimux daemon is not running.");
      return;
    }
    console.log(`Daemon pid=${info.pid} port=${info.port}`);
    console.log(`Managed projects: ${Object.keys(state.projects).length}`);
    const r = relay as { status?: string; relayUrl?: string };
    if (r.status && r.status !== "off") {
      console.log(`Relay: ${r.status}${r.relayUrl ? ` (${r.relayUrl})` : ""}`);
    } else {
      console.log("Relay: off");
    }
  });

daemonCmd
  .command("projects")
  .description("List projects through the daemon")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    await ensureDaemonRunning();
    const result = await requestDaemonJson("/projects");
    if (opts.json) {
      console.log(JSON.stringify({ projects: result.projects }, null, 2));
      return;
    }
    for (const project of result.projects as Array<any>) {
      const badge = project.serviceAlive ? "service" : "idle";
      console.log(`${project.name}  ${badge}  ${project.path}`);
    }
  });

daemonCmd
  .command("project-ensure")
  .description("Ensure a project's control service is running")
  .requiredOption("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (opts: { project: string; json?: boolean }) => {
    const projectRoot = resolveProjectRoot(pathResolve(opts.project));
    const project = await ensureProjectService(projectRoot);
    if (opts.json) {
      console.log(JSON.stringify({ project }, null, 2));
      return;
    }
    console.log(`Ensured project service for ${projectRoot} (pid ${project.pid})`);
  });

program
  .command("__project-service-internal")
  .description("Internal daemon-managed project service entrypoint")
  .action(async () => {
    const projectRoot = resolveProjectRoot(process.cwd());
    if (projectRoot !== process.cwd()) {
      process.chdir(projectRoot);
    }
    await initPaths(projectRoot);
    initProject();

    const mux = new Multiplexer();
    let cleanedUp = false;
    const ensureTerminalRestored = () => mux.cleanupTerminalOnly();
    const cleanupAll = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      mux.cleanup();
    };

    const shutdown = () => {
      cleanupAll();
      process.exit(0);
    };
    process.on("exit", ensureTerminalRestored);
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("uncaughtException", (err) => {
      cleanupAll();
      log.error("project service uncaught exception", "runtime", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      console.error(err);
      process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      cleanupAll();
      log.error("project service unhandled rejection", "runtime", {
        error: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
      console.error(reason);
      process.exit(1);
    });

    try {
      const exitCode = await mux.runProjectService();
      cleanupAll();
      process.exit(exitCode);
    } catch (err: unknown) {
      cleanupAll();
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`aimux project service: ${msg}`);
      process.exit(1);
    }
  });

const projectsCmd = program.command("projects").description("Inspect known aimux projects");

projectsCmd
  .command("list")
  .description("List known aimux projects")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    await ensureDaemonRunning();
    const result = await requestDaemonJson("/projects");
    const projects = result.projects as Array<
      ReturnType<typeof listDesktopProjects>[number] & { serviceAlive?: boolean }
    >;
    if (opts.json) {
      console.log(JSON.stringify({ projects }, null, 2));
      return;
    }

    if (projects.length === 0) {
      console.log("No aimux projects found.");
      return;
    }

    for (const project of projects) {
      const liveBadge = project.serviceAlive ? "live" : "idle";
      console.log(`${project.name}  ${liveBadge}  ${project.path}`);
    }
  });

program
  .command("compact")
  .description("Compact session history using LLM summarization")
  .action(() => {
    const historyDir = getHistoryDir();
    let sessionIds: string[] = [];
    try {
      sessionIds = readdirSync(historyDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(/\.jsonl$/, ""));
    } catch {
      console.error("No history found at " + historyDir);
      process.exit(1);
    }

    if (sessionIds.length === 0) {
      console.error("No session history files found.");
      process.exit(1);
    }

    console.log(`Compacting history for ${sessionIds.length} session(s)...`);
    llmCompact(sessionIds);
    console.log(`Done. Summary written to ${getContextDir()}/summary.md`);
  });

program
  .command("login")
  .description("Sign in to enable remote access via aimux.app")
  .option("--web-app-url <url>", "Override the web app URL")
  // No --relay-url here: the token is minted by whichever relay the web app
  // points at, so a CLI override would just store a relay URL that rejects
  // the resulting token (different RELAY_TOKEN_SECRET).
  .action(async (opts: { webAppUrl?: string }) => {
    try {
      const { userId } = await runLoginFlow({ webAppUrl: opts.webAppUrl });
      let relayStatus: string | null = null;
      let relayError: string | null = null;
      if (loadDaemonInfo()) {
        try {
          const result = await requestDaemonJson("/relay/enable", { method: "POST" });
          const relay = result.relay as { status?: string; lastError?: string | null };
          relayStatus = relay.status ?? "unknown";
          relayError = relay.lastError ?? null;
        } catch (err) {
          relayError = err instanceof Error ? err.message : String(err);
        }
      }
      console.log(`\n✓ Logged in as ${userId}`);
      if (relayStatus) {
        console.log(`Remote access is enabled (connection: ${relayStatus}).`);
        if (relayError) console.log(`Last error: ${relayError}`);
      } else {
        console.log("Remote access is enabled. The daemon will connect on next start.");
        if (relayError) console.log(`Daemon refresh failed: ${relayError}`);
      }
    } catch (err) {
      console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Clear stored credentials and disable remote access")
  .action(async () => {
    // If the daemon is running it already has the credential loaded into
    // memory; tell it to disconnect before we yank the file so the running
    // process stops talking to the relay immediately (best-effort — we
    // ignore failures since the daemon may not be up).
    if (loadDaemonInfo()) {
      try {
        await requestDaemonJson("/relay/disable", { method: "POST" });
      } catch {
        // daemon offline or refused; the file removal below still kills
        // future startup, so this isn't fatal.
      }
    }
    const result = clearCredentials();
    if (result === "cleared") console.log("✓ Logged out. Remote access disabled.");
    else if (result === "none") console.log("Not logged in.");
    else {
      console.error("Failed to remove credentials file — check permissions.");
      process.exitCode = 1;
    }
  });

program
  .command("whoami")
  .description("Show the current remote-access login status")
  .option("--json", "Emit JSON")
  .action((opts: { json?: boolean }) => {
    const creds = loadCredentials();
    if (opts.json) {
      console.log(
        JSON.stringify(
          creds
            ? { loggedIn: true, userId: creds.userId, relayUrl: creds.relayUrl, remoteEnabled: creds.remoteEnabled }
            : { loggedIn: false },
          null,
          2,
        ),
      );
      return;
    }
    if (!creds) {
      console.log("Not logged in. Run `aimux login` to enable remote access.");
      return;
    }
    console.log(`Logged in as ${creds.userId}`);
    console.log(`Relay: ${creds.relayUrl}`);
    console.log(`Remote access: ${creds.remoteEnabled ? "enabled" : "disabled"}`);
  });

const remoteCmd = program.command("remote").description("Manage remote access via the relay");
const securityCmd = program.command("security").description("Manage aimux security controls");

remoteCmd
  .command("status")
  .description("Show relay connection status")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    const creds = loadCredentials();
    let relay: unknown = { status: "off" };
    if (loadDaemonInfo()) {
      try {
        const result = await requestDaemonJson("/relay/status");
        relay = result.relay;
      } catch {
        // Daemon is not reachable — fall back to credential state.
      }
    }
    if (opts.json) {
      console.log(JSON.stringify({ loggedIn: Boolean(creds), relay }, null, 2));
      return;
    }
    if (!creds) {
      console.log("Not logged in. Run `aimux login` to enable remote access.");
      return;
    }
    const r = relay as { status?: string; relayUrl?: string; lastError?: string | null };
    console.log(`Remote access: ${creds.remoteEnabled ? "enabled" : "disabled"}`);
    console.log(`Relay: ${creds.relayUrl}`);
    console.log(`Connection: ${r.status ?? "unknown"}`);
    if (r.lastError) console.log(`Last error: ${r.lastError}`);
  });

remoteCmd
  .command("enable")
  .description("Enable remote access and connect to the relay")
  .action(async () => {
    if (!loadCredentials()) {
      console.error("Not logged in. Run `aimux login` first.");
      process.exit(1);
    }
    await ensureDaemonRunning();
    const result = await requestDaemonJson("/relay/enable", { method: "POST" });
    const r = result.relay as { status?: string };
    console.log(`✓ Remote access enabled (connection: ${r.status ?? "unknown"})`);
  });

remoteCmd
  .command("disable")
  .description("Disable remote access and disconnect from the relay")
  .action(async () => {
    if (loadDaemonInfo()) {
      await requestDaemonJson("/relay/disable", { method: "POST" });
      console.log("✓ Remote access disabled. Daemon disconnected from relay.");
      return;
    }
    setRemoteEnabled(false);
    console.log("✓ Remote access disabled.");
  });

securityCmd
  .command("unlock")
  .description("Clear relay security lockdown after re-authenticating")
  .option("--web-app-url <url>", "Override the web app URL")
  .action(async (opts: { webAppUrl?: string }) => {
    try {
      const { userId } = await runLoginFlow({ webAppUrl: opts.webAppUrl, action: "security-unlock" });
      console.log(`\n✓ Security unlocked for ${userId}`);
      console.log("Remote access is enabled with a fresh daemon token. Restart the daemon to reconnect immediately.");
    } catch (err) {
      console.error(`Security unlock failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

async function prepareProjectContext(requestedProject?: string): Promise<string> {
  const requestedPath = pathResolve(requestedProject ?? process.cwd());
  const projectRoot = resolveProjectRoot(requestedPath);
  await initPaths(projectRoot);
  process.chdir(projectRoot);
  return projectRoot;
}

function listVisibleLocalWorktrees(projectRoot: string): WorktreeInfo[] {
  const graveyardPaths = listTopologyWorktreeGraveyardPaths();
  return listWorktrees(projectRoot).filter((worktree) => !graveyardPaths.has(worktree.path));
}

function printWorktrees(projectRoot?: string, worktreesInput?: WorktreeInfo[]): void {
  try {
    const worktrees = worktreesInput ?? listWorktrees(projectRoot);
    if (worktrees.length === 0) {
      console.log("No worktrees found.");
      return;
    }
    console.log("Name".padEnd(30) + "Branch".padEnd(35) + "Path");
    console.log("-".repeat(95));
    for (const wt of worktrees) {
      console.log(wt.name.padEnd(30) + wt.branch.padEnd(35) + wt.path);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}

function printGraveyard(input: { entries?: any[]; worktrees?: any[] }): void {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const worktrees = Array.isArray(input.worktrees) ? input.worktrees : [];
  if (entries.length === 0 && worktrees.length === 0) {
    console.log("Graveyard is empty.");
    return;
  }
  if (worktrees.length > 0) {
    console.log("Worktrees");
    console.log("Name".padEnd(30) + "Branch".padEnd(35) + "Path");
    console.log("-".repeat(95));
    for (const worktree of worktrees) {
      console.log(
        String(worktree.name ?? "?").padEnd(30) +
          String(worktree.branch ?? "").padEnd(35) +
          String(worktree.path ?? "?"),
      );
    }
  }
  if (entries.length > 0) {
    if (worktrees.length > 0) console.log("");
    console.log("Agents");
    console.log("ID".padEnd(25) + "Tool".padEnd(15) + "Backend Session ID");
    console.log("-".repeat(70));
    for (const session of entries) {
      console.log(
        String(session.id ?? "?").padEnd(25) +
          String(session.command ?? session.tool ?? "?").padEnd(15) +
          String(session.backendSessionId ?? "(none)"),
      );
    }
  }
}

function printGraveyardCleanup(result: GraveyardCleanupRunResult): void {
  if (!result.plan.enabled) {
    console.log("Graveyard cleanup is disabled.");
    return;
  }
  const removed = result.results.filter((item) => item.status === "removed").length;
  const dryRun = result.results.filter((item) => item.status === "dry-run").length;
  const failed = result.results.filter((item) => item.status === "failed").length;
  const action = result.dryRun ? "would remove" : "removed";
  console.log(
    `Graveyard cleanup ${action} ${result.dryRun ? dryRun : removed} item(s); ${failed} failed. Retention: ${result.plan.retentionDays} day(s).`,
  );
  for (const item of result.results) {
    const status = item.status === "failed" ? `failed: ${item.error}` : item.status;
    console.log(`${item.kind} ${item.id}: ${status}`);
  }
}

const worktreeCmd = program.command("worktree").description("Manage git worktrees");

async function ensureDaemonProjectReadyForFallback(projectRoot: string): Promise<void> {
  try {
    await ensureDaemonProjectReady(projectRoot);
  } catch (err) {
    if (err instanceof ProjectServiceVersionError) {
      throw err;
    }
  }
}

worktreeCmd.action(async () => {
  const projectRoot = await prepareProjectContext();
  await ensureDaemonProjectReadyForFallback(projectRoot);
  const result = await getLiveProjectServiceJsonOrLocal(projectRoot, "/worktrees", () => ({
    ok: true,
    worktrees: listVisibleLocalWorktrees(projectRoot),
  }));
  printWorktrees(projectRoot, result.worktrees ?? []);
});

const threadCmd = program.command("thread").description("Inspect and manage orchestration threads");
program
  .command("threads")
  .description("Alias for thread list")
  .option("--session <sessionId>", "Filter to threads involving a session")
  .option("--json", "Emit JSON")
  .action(async (opts: { session?: string; json?: boolean }) => {
    const query = opts.session ? `?session=${encodeURIComponent(opts.session)}` : "";
    const summaries = await getProjectServiceJsonOrLocal(`/threads${query}`, () => listThreadSummaries(opts.session));
    if (opts.json) {
      console.log(JSON.stringify(summaries, null, 2));
      return;
    }
    if (summaries.length === 0) {
      console.log("No threads found.");
      return;
    }
    for (const summary of summaries) {
      const unread = summary.thread.unreadBy?.length ? ` unread=${summary.thread.unreadBy.length}` : "";
      const waiting = summary.thread.waitingOn?.length ? ` waiting=${summary.thread.waitingOn.join(",")}` : "";
      console.log(`${summary.thread.id}  ${summary.thread.kind}  ${summary.thread.status}${unread}${waiting}`);
      console.log(`  ${summary.thread.title}`);
      if (summary.latestMessage) {
        console.log(
          `  latest: ${summary.latestMessage.from} [${summary.latestMessage.kind}] ${summary.latestMessage.body}`,
        );
      }
    }
  });

threadCmd
  .command("list")
  .description("List orchestration threads")
  .option("--session <sessionId>", "Filter to threads involving a session")
  .option("--json", "Emit JSON")
  .action(async (opts: { session?: string; json?: boolean }) => {
    const query = opts.session ? `?session=${encodeURIComponent(opts.session)}` : "";
    const summaries = await getProjectServiceJsonOrLocal(`/threads${query}`, () => listThreadSummaries(opts.session));
    if (opts.json) {
      console.log(JSON.stringify(summaries, null, 2));
      return;
    }
    if (summaries.length === 0) {
      console.log("No threads found.");
      return;
    }
    for (const summary of summaries) {
      const unread = summary.thread.unreadBy?.length ? ` unread=${summary.thread.unreadBy.length}` : "";
      const waiting = summary.thread.waitingOn?.length ? ` waiting=${summary.thread.waitingOn.join(",")}` : "";
      console.log(`${summary.thread.id}  ${summary.thread.kind}  ${summary.thread.status}${unread}${waiting}`);
      console.log(`  ${summary.thread.title}`);
      if (summary.latestMessage) {
        console.log(
          `  latest: ${summary.latestMessage.from} [${summary.latestMessage.kind}] ${summary.latestMessage.body}`,
        );
      }
    }
  });

threadCmd
  .command("show")
  .description("Show a thread and its messages")
  .argument("<threadId>")
  .option("--json", "Emit JSON")
  .action(async (threadId: string, opts: { json?: boolean }) => {
    const detail = await getProjectServiceJsonOrLocal(`/threads/${encodeURIComponent(threadId)}`, () => {
      const thread = readThread(threadId);
      if (!thread) return null;
      return { thread, messages: readMessages(threadId) };
    });
    if (!detail?.thread) {
      console.error(`aimux: thread not found: ${threadId}`);
      process.exit(1);
    }
    const { thread, messages } = detail;
    if (opts.json) {
      console.log(JSON.stringify({ thread, messages }, null, 2));
      return;
    }
    console.log(`${thread.title} (${thread.kind})`);
    console.log(`id: ${thread.id}`);
    console.log(`status: ${thread.status}`);
    console.log(`participants: ${thread.participants.join(", ")}`);
    if (thread.owner) console.log(`owner: ${thread.owner}`);
    if (thread.waitingOn?.length) console.log(`waitingOn: ${thread.waitingOn.join(", ")}`);
    console.log("");
    for (const message of messages) {
      console.log(`${message.ts}  ${message.from} [${message.kind}]`);
      console.log(`  ${message.body}`);
    }
  });

threadCmd
  .command("open")
  .description("Open a new orchestration thread")
  .requiredOption("--title <title>", "Thread title")
  .requiredOption("--from <sessionId>", "Creating session")
  .requiredOption("--participants <ids>", "Comma-separated participant session ids")
  .option("--kind <kind>", "conversation|task|review|handoff|user", "conversation")
  .action(async (opts: { title: string; from: string; participants: string; kind?: ThreadKind }) => {
    const participants = opts.participants
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const result = await postProjectServiceJson("/threads/open", {
      title: opts.title,
      from: opts.from,
      participants,
      kind: (opts.kind as ThreadKind) ?? "conversation",
    });
    console.log(result.thread.id);
  });

threadCmd
  .command("send")
  .description("Append a message to an orchestration thread")
  .argument("<threadId>")
  .argument("<body>")
  .requiredOption("--from <sessionId>", "Sending session")
  .option("--to <ids>", "Comma-separated recipient session ids")
  .option("--kind <kind>", "request|reply|status|decision|handoff|note", "note")
  .action(async (threadId: string, body: string, opts: { from: string; to?: string; kind?: MessageKind }) => {
    const to = opts.to
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const result = await postProjectServiceJson("/threads/send", {
      threadId,
      from: opts.from,
      to,
      kind: (opts.kind as MessageKind) ?? "note",
      body,
    });
    console.log(result.message.id);
  });

threadCmd
  .command("mark-seen")
  .description("Mark a thread as seen for a participant")
  .argument("<threadId>")
  .requiredOption("--session <sessionId>", "Participant session id")
  .action(async (threadId: string, opts: { session: string }) => {
    await postProjectServiceJson("/threads/mark-seen", { threadId, session: opts.session });
    console.log("ok");
  });

threadCmd
  .command("status")
  .description("Update a thread status")
  .argument("<threadId>")
  .requiredOption("--status <status>", "open|waiting|blocked|done|abandoned")
  .option("--owner <sessionId>", "Override thread owner")
  .option("--waiting-on <ids>", "Comma-separated waitingOn participants")
  .action(async (threadId: string, opts: { status: ThreadStatus; owner?: string; waitingOn?: string }) => {
    const waitingOn = opts.waitingOn
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const result = await postProjectServiceJson("/threads/status", {
      threadId,
      status: opts.status,
      owner: opts.owner,
      waitingOn,
    });
    console.log(`thread ${result.thread.id}`);
    console.log(`status ${result.thread.status}`);
  });

program
  .command("input")
  .description("Send text into a running agent session as a new turn")
  .argument("<sessionId>", "Target agent session id")
  .argument("<text...>", "Text to deliver (submitted as a prompt)")
  .action(async (sessionId: string, text: string[]) => {
    await initPaths();
    const body = text.join(" ");
    if (!body.trim()) {
      console.error("aimux: input requires non-empty text");
      process.exit(1);
    }
    await postProjectServiceJson("/agents/input", { sessionId, text: body });
    console.log(`delivered to ${sessionId}`);
  });

program
  .command("ps")
  .description("Show all agents in this project (across worktrees) with activity and loop state")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    await initPaths();
    const result = await getProjectServiceJson("/agents");
    const agents: Array<{
      id: string;
      tool?: string;
      role?: string;
      status?: string;
      worktreePath?: string;
      activity?: string;
      attention?: string;
      loop?: { active: boolean; goal?: string };
      overseer?: boolean;
      task?: { description: string; status: string };
    }> = result.agents ?? [];
    if (opts.json) {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }
    if (agents.length === 0) {
      console.log("no agents");
      return;
    }
    for (const agent of agents) {
      const tags = [
        agent.overseer ? "overseer" : null,
        agent.loop?.active ? `loop${agent.loop.goal ? `:${agent.loop.goal}` : ""}` : null,
      ].filter(Boolean);
      const state = [agent.activity, agent.attention].filter(Boolean).join("/");
      console.log(
        `${agent.id}  [${agent.tool ?? "?"}${agent.role ? `:${agent.role}` : ""}]  ${agent.status ?? "?"}` +
          `${state ? `  ${state}` : ""}${tags.length ? `  {${tags.join(" ")}}` : ""}`,
      );
      if (agent.worktreePath) console.log(`    worktree: ${agent.worktreePath}`);
      if (agent.task) console.log(`    task: ${agent.task.description} (${agent.task.status})`);
    }
  });

const loopCmd = program.command("loop").description("Manage agents in an overseer-managed loop");

loopCmd
  .command("add")
  .description("Mark an agent as in a managed loop (keep it working until done/blocked)")
  .argument("<sessionId>", "Target agent session id")
  .option("--goal <goal>", "What the agent should keep working toward")
  .action(async (sessionId: string, opts: { goal?: string }) => {
    await initPaths();
    const result = await postProjectServiceJson("/agents/loop", { sessionId, active: true, goal: opts.goal });
    console.log(`loop on ${sessionId}${result.loop?.goal ? ` — ${result.loop.goal}` : ""}`);
  });

loopCmd
  .command("remove")
  .description("Remove an agent from the managed loop")
  .argument("<sessionId>", "Target agent session id")
  .action(async (sessionId: string) => {
    await initPaths();
    await postProjectServiceJson("/agents/loop", { sessionId, active: false });
    console.log(`loop off ${sessionId}`);
  });

function resolveOwnSessionId(explicit?: string): string {
  const sessionId = (explicit ?? process.env.AIMUX_SESSION_ID ?? "").trim();
  if (!sessionId) {
    console.error("aimux: pass --session or run inside an aimux agent (AIMUX_SESSION_ID is unset)");
    process.exit(1);
  }
  return sessionId;
}

/** Exit a loop: clear the flag first (so the watcher stops nudging even if the
 * notification fails), then emit the status event best-effort. */
async function exitLoop(sessionId: string, event: Record<string, unknown>): Promise<void> {
  await postProjectServiceJson("/agents/loop", { sessionId, active: false });
  try {
    await postProjectServiceJson("/event", { session: sessionId, event });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`aimux: loop exited, but the status event could not be recorded: ${msg}`);
  }
}

loopCmd
  .command("done")
  .description("(run by an agent) Report the loop goal complete and exit the loop")
  .option("--session <id>", "Session id (defaults to $AIMUX_SESSION_ID)")
  .option("--reason <text>", "What was completed")
  .action(async (opts: { session?: string; reason?: string }) => {
    await initPaths();
    const sessionId = resolveOwnSessionId(opts.session);
    await exitLoop(sessionId, {
      kind: "task_done",
      message: opts.reason ?? "Loop goal completed.",
      tone: "success",
      source: "loop",
    });
    console.log(`loop done ${sessionId}`);
  });

loopCmd
  .command("block")
  .description("(run by an agent) Report you are blocked beyond repair and exit the loop")
  .option("--session <id>", "Session id (defaults to $AIMUX_SESSION_ID)")
  .option("--reason <text>", "Why you are blocked")
  .action(async (opts: { session?: string; reason?: string }) => {
    await initPaths();
    const sessionId = resolveOwnSessionId(opts.session);
    await exitLoop(sessionId, {
      kind: "blocked",
      message: opts.reason ?? "Blocked beyond repair.",
      source: "loop",
    });
    console.log(`loop blocked ${sessionId}`);
  });

const messageCmd = program.command("message").description("Send directed orchestration messages");

messageCmd
  .command("send")
  .description("Send a direct message and open or reuse a conversation thread")
  .argument("<body>")
  .option("--to <ids>", "Comma-separated recipient session ids")
  .option("--assignee <role>", "Route to a role if no explicit session id is provided")
  .option("--tool <tool>", "Route to a tool if no explicit session id is provided")
  .option("--worktree <path>", "Prefer a target in this worktree")
  .option("--from <sessionId>", "Sender session id", "user")
  .option("--title <title>", "Conversation title if a new thread is opened")
  .option("--kind <kind>", "request|reply|status|decision|handoff|note", "request")
  .option("--thread <threadId>", "Append to an existing thread instead of opening/reusing a conversation")
  .action(
    async (
      body: string,
      opts: {
        to?: string;
        assignee?: string;
        tool?: string;
        worktree?: string;
        from?: string;
        title?: string;
        kind?: MessageKind;
        thread?: string;
      },
    ) => {
      const to = opts.to
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if ((!to || to.length === 0) && !opts.thread && !opts.assignee && !opts.tool) {
        console.error("aimux: message send requires --to, --assignee, or --tool");
        process.exit(1);
      }
      const result = await postProjectServiceJson("/threads/send", {
        threadId: opts.thread,
        from: opts.from ?? "user",
        to,
        assignee: opts.assignee,
        tool: opts.tool,
        worktreePath: opts.worktree,
        kind: (opts.kind as MessageKind) ?? "request",
        body,
        title: opts.title,
      });
      console.log(`thread ${result.thread.id}`);
      console.log(`message ${result.message.id}`);
      if (Array.isArray(result.deliveredTo) && result.deliveredTo.length > 0) {
        console.log(`delivered ${result.deliveredTo.join(",")}`);
      }
    },
  );

const handoffCmd = program.command("handoff").description("Send an explicit orchestration handoff");

handoffCmd
  .command("send")
  .description("Open a handoff thread and transfer ownership/context to another agent")
  .argument("<body>")
  .option("--to <ids>", "Comma-separated recipient session ids")
  .option("--assignee <role>", "Route to a role if no explicit session id is provided")
  .option("--tool <tool>", "Route to a tool if no explicit session id is provided")
  .option("--worktree <path>", "Prefer a target in this worktree")
  .option("--from <sessionId>", "Sender session id", "user")
  .option("--title <title>", "Handoff thread title")
  .action(
    async (
      body: string,
      opts: { to?: string; assignee?: string; tool?: string; worktree?: string; from?: string; title?: string },
    ) => {
      const to = opts.to
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if ((!to || to.length === 0) && !opts.assignee && !opts.tool) {
        console.error("aimux: handoff send requires --to, --assignee, or --tool");
        process.exit(1);
      }
      const result = await postProjectServiceJson("/handoff", {
        from: opts.from ?? "user",
        to,
        assignee: opts.assignee,
        tool: opts.tool,
        body,
        title: opts.title,
        worktreePath: opts.worktree,
      });
      console.log(`thread ${result.thread.id}`);
      console.log(`message ${result.message.id}`);
      if (Array.isArray(result.deliveredTo) && result.deliveredTo.length > 0) {
        console.log(`delivered ${result.deliveredTo.join(",")}`);
      }
    },
  );

handoffCmd
  .command("accept")
  .description("Accept an existing handoff thread")
  .argument("<threadId>")
  .option("--from <sessionId>", "Accepting session id", "user")
  .option("--body <text>", "Optional acceptance note")
  .action(async (threadId: string, opts: { from?: string; body?: string }) => {
    const result = await postProjectServiceJson("/handoff/accept", {
      threadId,
      from: opts.from ?? "user",
      body: opts.body,
    });
    console.log(`thread ${result.thread.id}`);
    console.log(`message ${result.message.id}`);
  });

handoffCmd
  .command("complete")
  .description("Complete an existing handoff thread")
  .argument("<threadId>")
  .option("--from <sessionId>", "Completing session id", "user")
  .option("--body <text>", "Optional completion note")
  .action(async (threadId: string, opts: { from?: string; body?: string }) => {
    const result = await postProjectServiceJson("/handoff/complete", {
      threadId,
      from: opts.from ?? "user",
      body: opts.body,
    });
    console.log(`thread ${result.thread.id}`);
    console.log(`message ${result.message.id}`);
  });

const taskCmd = program.command("task").description("Create and manage orchestrated tasks");

taskCmd
  .command("list")
  .description("List orchestrated tasks")
  .option("--session <sessionId>", "Filter to tasks assigned to or created by a session")
  .option("--status <status>", "Filter by task status")
  .option("--json", "Emit JSON")
  .action(async (opts: { session?: string; status?: string; json?: boolean }) => {
    const params = new URLSearchParams();
    if (opts.session) params.set("session", opts.session);
    if (opts.status) params.set("status", opts.status);
    const query = params.toString();
    const result = await getProjectServiceJsonOrLocal(`/tasks${query ? `?${query}` : ""}`, () => ({
      ok: true,
      tasks: readAllTasks()
        .filter((task) => !opts.session || task.assignedTo === opts.session || task.assignedBy === opts.session)
        .filter((task) => !opts.status || task.status === opts.status),
    }));
    const tasks = Array.isArray(result.tasks) ? result.tasks : [];
    if (opts.json) {
      console.log(JSON.stringify({ tasks }, null, 2));
      return;
    }
    if (tasks.length === 0) {
      console.log("No tasks found.");
      return;
    }
    for (const task of tasks) {
      const target = task.assignedTo ?? task.assignee ?? task.tool ?? "unassigned";
      const thread = task.threadId ? ` thread=${task.threadId}` : "";
      console.log(`${task.id}  ${task.type ?? "task"}  ${task.status}  target=${target}${thread}`);
      console.log(`  ${task.description}`);
    }
  });

taskCmd
  .command("show")
  .description("Show an orchestrated task")
  .argument("<taskId>")
  .option("--json", "Emit JSON")
  .action(async (taskId: string, opts: { json?: boolean }) => {
    const detail = await getProjectServiceJsonOrLocal(`/tasks/${encodeURIComponent(taskId)}`, () => {
      const task = readTask(taskId);
      if (!task) return null;
      return {
        ok: true,
        task,
        thread: task.threadId ? readThread(task.threadId) : undefined,
        messages: task.threadId ? readMessages(task.threadId) : [],
      };
    });
    if (!detail?.task) {
      console.error(`aimux: task not found: ${taskId}`);
      process.exit(1);
    }
    const { task, thread, messages } = detail;
    if (opts.json) {
      console.log(JSON.stringify({ task, thread, messages }, null, 2));
      return;
    }
    console.log(`${task.description} (${task.type ?? "task"})`);
    console.log(`id: ${task.id}`);
    console.log(`status: ${task.status}`);
    console.log(`assignedBy: ${task.assignedBy}`);
    if (task.assignedTo) console.log(`assignedTo: ${task.assignedTo}`);
    if (task.assignee) console.log(`assignee: ${task.assignee}`);
    if (task.tool) console.log(`tool: ${task.tool}`);
    if (task.threadId) console.log(`thread: ${task.threadId}`);
    if (task.reviewStatus) console.log(`reviewStatus: ${task.reviewStatus}`);
    if (task.reviewFeedback) console.log(`reviewFeedback: ${task.reviewFeedback}`);
    if (task.result) console.log(`result: ${task.result}`);
    if (task.error) console.log(`error: ${task.error}`);
    console.log("");
    console.log(task.prompt);
  });

taskCmd
  .command("assign")
  .description("Create a durable task assignment")
  .argument("<description>")
  .option("--from <sessionId>", "Assigning session id", "user")
  .option("--to <sessionId>", "Specific assignee session id")
  .option("--assignee <role>", "Role name to route to")
  .option("--tool <tool>", "Tool key to route to")
  .option("--prompt <text>", "Full task prompt")
  .option("--type <type>", "task|review", "task")
  .option("--diff <text>", "Optional diff snippet or review payload")
  .option("--worktree <path>", "Associated worktree path")
  .action(
    async (
      description: string,
      opts: {
        from?: string;
        to?: string;
        assignee?: string;
        tool?: string;
        prompt?: string;
        type?: "task" | "review";
        diff?: string;
        worktree?: string;
      },
    ) => {
      const result = await postProjectServiceJson("/tasks/assign", {
        from: opts.from ?? "user",
        to: opts.to,
        assignee: opts.assignee,
        tool: opts.tool,
        description,
        prompt: opts.prompt,
        type: opts.type,
        diff: opts.diff,
        worktreePath: opts.worktree,
      });
      console.log(`task ${result.task.id}`);
      if (result.thread?.id) console.log(`thread ${result.thread.id}`);
    },
  );

taskCmd
  .command("accept")
  .description("Accept an assigned task and mark it in progress")
  .argument("<taskId>")
  .option("--from <sessionId>", "Accepting session id", "user")
  .option("--body <text>", "Optional acceptance note")
  .action(async (taskId: string, opts: { from?: string; body?: string }) => {
    const result = await postProjectServiceJson("/tasks/accept", {
      taskId,
      from: opts.from ?? "user",
      body: opts.body,
    });
    console.log(`task ${result.task.id}`);
    if (result.thread?.id) console.log(`thread ${result.thread.id}`);
  });

taskCmd
  .command("block")
  .description("Mark a task blocked and route it back for attention")
  .argument("<taskId>")
  .option("--from <sessionId>", "Blocking session id", "user")
  .option("--body <text>", "Blocking reason")
  .action(async (taskId: string, opts: { from?: string; body?: string }) => {
    const result = await postProjectServiceJson("/tasks/block", {
      taskId,
      from: opts.from ?? "user",
      body: opts.body,
    });
    console.log(`task ${result.task.id}`);
    if (result.thread?.id) console.log(`thread ${result.thread.id}`);
  });

taskCmd
  .command("complete")
  .description("Complete a task explicitly and publish the result")
  .argument("<taskId>")
  .option("--from <sessionId>", "Completing session id", "user")
  .option("--body <text>", "Completion summary/result")
  .action(async (taskId: string, opts: { from?: string; body?: string }) => {
    const result = await postProjectServiceJson("/tasks/complete", {
      taskId,
      from: opts.from ?? "user",
      body: opts.body,
    });
    console.log(`task ${result.task.id}`);
    if (result.thread?.id) console.log(`thread ${result.thread.id}`);
  });

taskCmd
  .command("reopen")
  .description("Reopen a completed or blocked task chain")
  .argument("<taskId>")
  .option("--from <sessionId>", "Reopening session id", "user")
  .option("--body <text>", "Optional reopening note")
  .action(async (taskId: string, opts: { from?: string; body?: string }) => {
    const result = await postProjectServiceJson("/tasks/reopen", {
      taskId,
      from: opts.from ?? "user",
      body: opts.body,
    });
    console.log(`task ${result.task.id}`);
    if (result.thread?.id) console.log(`thread ${result.thread.id}`);
  });

const reviewCmd = program.command("review").description("Manage review workflow tasks");

reviewCmd
  .command("approve")
  .description("Approve a review task")
  .argument("<taskId>")
  .option("--from <sessionId>", "Reviewer session id", "user")
  .option("--body <text>", "Optional approval note")
  .action(async (taskId: string, opts: { from?: string; body?: string }) => {
    const result = await postProjectServiceJson("/reviews/approve", {
      taskId,
      from: opts.from ?? "user",
      body: opts.body,
    });
    console.log(`task ${result.task.id}`);
    if (result.thread?.id) console.log(`thread ${result.thread.id}`);
  });

reviewCmd
  .command("request-changes")
  .description("Request changes on a review task")
  .argument("<taskId>")
  .option("--from <sessionId>", "Reviewer session id", "user")
  .option("--body <text>", "Requested changes")
  .action(async (taskId: string, opts: { from?: string; body?: string }) => {
    const result = await postProjectServiceJson("/reviews/request-changes", {
      taskId,
      from: opts.from ?? "user",
      body: opts.body,
    });
    console.log(`task ${result.task.id}`);
    if (result.followUpTask?.id) console.log(`follow-up ${result.followUpTask.id}`);
    if (result.thread?.id) console.log(`thread ${result.thread.id}`);
  });

worktreeCmd
  .command("list")
  .description("List all git worktrees")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (opts: { project?: string; json?: boolean }) => {
    const projectRoot = await prepareProjectContext(opts.project);
    await ensureDaemonProjectReadyForFallback(projectRoot);
    const result = await getLiveProjectServiceJsonOrLocal(projectRoot, "/worktrees", () => ({
      ok: true,
      worktrees: listVisibleLocalWorktrees(projectRoot),
    }));
    const worktrees = result.worktrees ?? [];
    if (opts.json) {
      console.log(JSON.stringify(worktrees, null, 2));
      return;
    }
    printWorktrees(projectRoot, worktrees);
  });

worktreeCmd
  .command("create <name>")
  .description("Create a git worktree")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (name: string, opts: { project?: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReadyForFallback(projectRoot);
      const result = await postLiveProjectServiceJsonOrLocal(projectRoot, "/worktrees/create", { name }, () => {
        const mux = new Multiplexer();
        return mux.createDesktopWorktree(name);
      });
      const createdPath = result.path;
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              name,
              path: createdPath,
              projectRoot,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`Created worktree "${name}" at ${createdPath}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

worktreeCmd
  .command("remove <path>")
  .description("Remove a git worktree")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (targetPath: string, opts: { project?: string; json?: boolean }) => {
    try {
      const inputCwd = process.cwd();
      const resolvedPath = pathResolve(inputCwd, targetPath);
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReadyForFallback(projectRoot);
      const result = await postLiveProjectServiceJsonOrLocal(
        projectRoot,
        "/worktrees/remove",
        { path: resolvedPath },
        () => {
          const mux = new Multiplexer();
          return mux.removeDesktopWorktree(resolvedPath);
        },
      );
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, projectRoot, path: result.path, status: result.status }, null, 2));
        return;
      }
      console.log(`${result.status === "removing" ? "removing" : "removed"} ${result.path}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

worktreeCmd
  .command("graveyard <path>")
  .description("Move a worktree to the graveyard without deleting the checkout")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (targetPath: string, opts: { project?: string; json?: boolean }) => {
    try {
      const inputCwd = process.cwd();
      const resolvedPath = pathResolve(inputCwd, targetPath);
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReadyForFallback(projectRoot);
      const result = await postLiveProjectServiceJsonOrLocal(
        projectRoot,
        "/worktrees/graveyard",
        { path: resolvedPath },
        () => {
          const mux = new Multiplexer();
          return mux.graveyardDesktopWorktree(resolvedPath);
        },
      );
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, projectRoot, path: result.path, status: result.status }, null, 2));
        return;
      }
      console.log(`graveyarded ${result.path}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

worktreeCmd
  .command("resurrect <path>")
  .description("Restore a graveyarded worktree to the active worktree list")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (targetPath: string, opts: { project?: string; json?: boolean }) => {
    try {
      const inputCwd = process.cwd();
      const resolvedPath = pathResolve(inputCwd, targetPath);
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReadyForFallback(projectRoot);
      const result = await postLiveProjectServiceJsonOrLocal(
        projectRoot,
        "/graveyard/worktrees/resurrect",
        { path: resolvedPath },
        () => {
          const mux = new Multiplexer();
          return mux.resurrectGraveyardWorktree(resolvedPath);
        },
      );
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, projectRoot, path: result.path, status: result.status }, null, 2));
        return;
      }
      console.log(`resurrected ${result.path}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

worktreeCmd
  .command("delete-graveyard <path>")
  .description("Permanently delete a graveyarded worktree entry")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (targetPath: string, opts: { project?: string; json?: boolean }) => {
    try {
      const inputCwd = process.cwd();
      const resolvedPath = pathResolve(inputCwd, targetPath);
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReadyForFallback(projectRoot);
      const result = await postLiveProjectServiceJsonOrLocal(
        projectRoot,
        "/graveyard/worktrees/delete",
        { path: resolvedPath },
        () => {
          const mux = new Multiplexer();
          return mux.deleteGraveyardWorktree(resolvedPath);
        },
      );
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, projectRoot, path: result.path, status: result.status }, null, 2));
        return;
      }
      console.log(`deleted ${result.path}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("spawn")
  .description("Spawn a fresh agent session using the same flow as the dashboard")
  .requiredOption("--tool <toolKey>", "Configured target tool key, e.g. claude or codex")
  .option("--project <path>", "Project path")
  .option("--worktree <path>", "Target worktree path")
  .option("--no-open", "Do not switch into the spawned agent window")
  .option("--json", "Emit JSON")
  .action(async (opts: { tool: string; project?: string; worktree?: string; open?: boolean; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReady(projectRoot);
      initProject();
      const mux = new Multiplexer();
      const targetWorktreePath = opts.worktree ? pathResolve(opts.worktree) : undefined;
      const result = await mux.spawnAgent({
        toolConfigKey: opts.tool,
        targetWorktreePath,
        open: opts.open,
      });
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              sessionId: result.sessionId,
              tool: opts.tool,
              worktreePath: targetWorktreePath ?? projectRoot,
              opened: opts.open !== false,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`spawned ${result.sessionId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

const overseerCmd = program.command("overseer").description("Manage the project overseer (top-down orchestrator)");

overseerCmd
  .command("start")
  .description("Spawn an overseer agent that monitors and directs the project's agents")
  .option("--tool <toolKey>", "Configured tool key (defaults to the project default)")
  .option("--project <path>", "Project path")
  .option("--worktree <path>", "Target worktree path")
  .option("--no-open", "Do not switch into the overseer window")
  .option("--json", "Emit JSON")
  .action(async (opts: { tool?: string; project?: string; worktree?: string; open?: boolean; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReady(projectRoot);
      initProject();
      const mux = new Multiplexer();
      const tool = opts.tool ?? loadConfig().defaultTool;
      const targetWorktreePath = opts.worktree ? pathResolve(opts.worktree) : undefined;
      const result = await mux.spawnAgent({
        toolConfigKey: tool,
        targetWorktreePath,
        open: opts.open,
        overseer: true,
      });
      if (opts.json) {
        console.log(
          JSON.stringify({ ok: true, projectRoot, sessionId: result.sessionId, tool, overseer: true }, null, 2),
        );
        return;
      }
      console.log(`overseer ${result.sessionId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

overseerCmd
  .command("clear")
  .description("Demote a session from overseer (does not stop the agent)")
  .argument("<sessionId>", "Overseer session id")
  .action(async (sessionId: string) => {
    await initPaths();
    await postProjectServiceJson("/agents/overseer", { sessionId, active: false });
    console.log(`overseer cleared ${sessionId}`);
  });

program
  .command("fork")
  .description("Fork an existing agent into a new agent with handed-off context")
  .argument("<sourceSessionId>", "Source session id to fork from")
  .requiredOption("--tool <toolKey>", "Configured target tool key, e.g. claude or codex")
  .option("--project <path>", "Project path")
  .option("--instruction <text>", "Extra instruction for the forked agent")
  .option("--worktree <path>", "Target worktree path")
  .option("--no-open", "Do not switch into the forked agent window")
  .option("--json", "Emit JSON")
  .action(
    async (
      sourceSessionId: string,
      opts: { tool: string; project?: string; instruction?: string; worktree?: string; open?: boolean; json?: boolean },
    ) => {
      try {
        const projectRoot = await prepareProjectContext(opts.project);
        await ensureDaemonProjectReady(projectRoot);
        initProject();
        const mux = new Multiplexer();
        const targetWorktreePath = opts.worktree ? pathResolve(opts.worktree) : undefined;
        const result = await mux.forkAgent({
          sourceSessionId,
          targetToolConfigKey: opts.tool,
          instruction: opts.instruction,
          targetWorktreePath,
          open: opts.open,
        });
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                ok: true,
                projectRoot,
                sourceSessionId,
                sessionId: result.sessionId,
                threadId: result.threadId,
                tool: opts.tool,
                worktreePath: targetWorktreePath ?? projectRoot,
                opened: opts.open !== false,
              },
              null,
              2,
            ),
          );
          return;
        }
        console.log(`forked ${result.sessionId}`);
        console.log(`thread ${result.threadId}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );

const graveyardCmd = program.command("graveyard").description("Manage killed agents (recoverable)");

graveyardCmd
  .command("list")
  .description("List agents in the graveyard")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (opts: { project?: string; json?: boolean }) => {
    const projectRoot = await prepareProjectContext(opts.project);
    await ensureDaemonProjectReadyForFallback(projectRoot);
    try {
      const graveyard = await getLiveProjectServiceJsonOrLocal(projectRoot, "/graveyard", () => ({
        ok: true,
        entries: listTopologySessionStates({ statuses: ["graveyard"] }),
        worktrees: listTopologyWorktreeGraveyard(),
      }));
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              entries: Array.isArray(graveyard.entries) ? graveyard.entries : [],
              worktrees: Array.isArray(graveyard.worktrees) ? graveyard.worktrees : [],
            },
            null,
            2,
          ),
        );
        return;
      }
      printGraveyard(graveyard);
    } catch {
      if (opts.json) {
        console.log(JSON.stringify({ entries: [], worktrees: [] }, null, 2));
        return;
      }
      console.log("Graveyard is empty.");
    }
  });

graveyardCmd
  .command("send <id>")
  .description("Send an agent to the graveyard from running or offline state")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (id: string, opts: { project?: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReady(projectRoot);
      const result = await postLiveProjectServiceJsonOrLocal(projectRoot, "/agents/kill", { sessionId: id }, () => {
        const mux = new Multiplexer();
        return mux.sendAgentToGraveyard(id);
      });
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              sessionId: result.sessionId,
              status: result.status,
              previousStatus: result.previousStatus,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`graveyarded ${result.sessionId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

graveyardCmd
  .command("resurrect <id>")
  .description("Resurrect an agent from the graveyard back to offline state")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (id: string, opts: { project?: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReady(projectRoot);
      const result = await postLiveProjectServiceJsonOrLocal(
        projectRoot,
        "/graveyard/resurrect",
        { sessionId: id },
        () => {
          const mux = new Multiplexer();
          return mux.resurrectGraveyardSession(id);
        },
      );
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              sessionId: result.sessionId,
              status: result.status,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`resurrected ${result.sessionId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

graveyardCmd
  .command("cleanup")
  .description("Remove expired graveyard agents, worktrees, and their stored assets")
  .option("--project <path>", "Project path")
  .option("--dry-run", "Show what would be removed without deleting anything")
  .option("--json", "Emit JSON")
  .action(async (opts: { project?: string; dryRun?: boolean; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReadyForFallback(projectRoot);
      const result = await postLiveProjectServiceJsonOrLocal(
        projectRoot,
        "/graveyard/cleanup",
        { dryRun: opts.dryRun === true },
        async () => {
          const mux = new Multiplexer();
          return runGraveyardCleanup(
            buildGraveyardCleanupPlan(),
            {
              deleteWorktree: (path) => mux.deleteGraveyardWorktree(path),
            },
            { dryRun: opts.dryRun === true },
          );
        },
      );
      const cleanupResult = (result.result ?? result) as GraveyardCleanupRunResult;
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, projectRoot, ...cleanupResult }, null, 2));
        return;
      }
      printGraveyardCleanup(cleanupResult);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("rename <sessionId>")
  .description("Rename an agent label in running or offline state")
  .requiredOption("--label <label>", "New agent label")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (sessionId: string, opts: { label: string; project?: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReady(projectRoot);
      const result = await postLiveProjectServiceJsonOrLocal(
        projectRoot,
        "/agents/rename",
        { sessionId, label: opts.label },
        () => {
          const mux = new Multiplexer();
          return mux.renameAgent(sessionId, opts.label);
        },
      );
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              sessionId: result.sessionId,
              label: result.label,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`renamed ${result.sessionId} -> ${result.label ?? ""}`.trim());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("switcher")
  .description("Internal tmux popup switcher")
  .requiredOption("--project-root <path>", "Project root")
  .requiredOption("--project-state-dir <path>", "Project state dir")
  .option("--current-client-session <name>", "Current client session")
  .option("--client-tty <tty>", "Client tty")
  .option("--current-window <name>", "Current window name")
  .option("--current-window-id <id>", "Current window id")
  .option("--current-path <path>", "Current path")
  .option("--pane-id <id>", "Current pane id")
  .action(
    async (opts: {
      projectRoot: string;
      projectStateDir: string;
      currentClientSession?: string;
      clientTty?: string;
      currentWindow?: string;
      currentWindowId?: string;
      currentPath?: string;
      paneId?: string;
    }) => {
      const code = await runTmuxSwitcher({
        projectRoot: pathResolve(opts.projectRoot),
        projectStateDir: pathResolve(opts.projectStateDir),
        currentClientSession: opts.currentClientSession,
        clientTty: opts.clientTty,
        currentWindow: opts.currentWindow,
        currentWindowId: opts.currentWindowId,
        currentPath: opts.currentPath,
        paneId: opts.paneId,
      });
      process.exit(code);
    },
  );

// Defined in popup-expose.ts so bin/aimux can run exposé through that lightweight entry
// (no full-CLI load); registered here too so `aimux expose` works via the main program.
registerExposeCommand(program);

program
  .command("meta-dashboard")
  .description("Internal cross-project meta dashboard window")
  .requiredOption("--project-root <path>", "Project root")
  .requiredOption("--project-state-dir <path>", "Project state dir")
  .option("--current-client-session <name>", "Current client session")
  .option("--client-tty <tty>", "Client tty")
  .option("--current-window <name>", "Current window name")
  .option("--current-window-id <id>", "Current window id")
  .option("--current-path <path>", "Current path")
  .option("--pane-id <id>", "Current pane id")
  .option("--aimux-home <path>", "AIMUX_HOME to scope the project registry")
  .action(
    async (opts: {
      projectRoot: string;
      projectStateDir: string;
      currentClientSession?: string;
      clientTty?: string;
      currentWindow?: string;
      currentWindowId?: string;
      currentPath?: string;
      paneId?: string;
      aimuxHome?: string;
    }) => {
      const code = await runTmuxMetaDashboard({
        projectRoot: pathResolve(opts.projectRoot),
        projectStateDir: pathResolve(opts.projectStateDir),
        currentClientSession: opts.currentClientSession,
        clientTty: opts.clientTty,
        currentWindow: opts.currentWindow,
        currentWindowId: opts.currentWindowId,
        currentPath: opts.currentPath,
        paneId: opts.paneId,
        aimuxHome: opts.aimuxHome,
      });
      process.exit(code);
    },
  );

program
  .command("inbox-popup")
  .description("Internal tmux popup inbox")
  .requiredOption("--project-root <path>", "Project root")
  .requiredOption("--project-state-dir <path>", "Project state dir")
  .option("--current-client-session <name>", "Current client session")
  .option("--client-tty <tty>", "Client tty")
  .option("--current-window <name>", "Current window name")
  .option("--current-window-id <id>", "Current window id")
  .option("--current-path <path>", "Current path")
  .option("--pane-id <id>", "Current pane id")
  .action(
    async (opts: {
      projectRoot: string;
      projectStateDir: string;
      currentClientSession?: string;
      clientTty?: string;
      currentWindow?: string;
      currentWindowId?: string;
      currentPath?: string;
      paneId?: string;
    }) => {
      const code = await runTmuxInboxPopup({
        projectRoot: pathResolve(opts.projectRoot),
        projectStateDir: pathResolve(opts.projectStateDir),
        currentClientSession: opts.currentClientSession,
        clientTty: opts.clientTty,
        currentWindow: opts.currentWindow,
        currentWindowId: opts.currentWindowId,
        currentPath: opts.currentPath,
        paneId: opts.paneId,
      });
      process.exit(code);
    },
  );

program
  .command("kill <sessionId>")
  .description("Send an agent to the graveyard from running or offline state")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (sessionId: string, opts: { project?: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReady(projectRoot);
      const result = await postLiveProjectServiceJsonOrLocal(projectRoot, "/agents/kill", { sessionId }, () => {
        const mux = new Multiplexer();
        return mux.sendAgentToGraveyard(sessionId);
      });
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              sessionId: result.sessionId,
              status: result.status,
              previousStatus: result.previousStatus,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`graveyarded ${result.sessionId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

program
  .command("migrate <sessionId>")
  .description("Migrate a running agent into another worktree")
  .requiredOption("--worktree <path>", "Target worktree path")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (sessionId: string, opts: { worktree: string; project?: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      const mux = new Multiplexer();
      const targetWorktreePath = pathResolve(opts.worktree);
      const result = await mux.migrateAgentSession(sessionId, targetWorktreePath);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              sessionId: result.sessionId,
              worktreePath: result.worktreePath ?? projectRoot,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`migrated ${result.sessionId} -> ${result.worktreePath ?? projectRoot}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

const doctorCmd = program.command("doctor").description("Inspect aimux runtime state");
const notificationsCmd = program.command("notifications").description("Manage desktop notification delivery");
const repairCmd = program.command("repair").description("Repair the current project runtime in place");

program
  .command("debug-state <target>")
  .description("Read-only debug snapshot for one session, service, backend session, or worktree")
  .action((target: string) => {
    const report = buildDebugStateReport({ cwd: process.cwd(), target });
    console.log(renderDebugStateReport(report));
  });

const migrationCmd = program
  .command("migration")
  .description("Explicit runtime-core migration audit, import, and rollback tooling");

migrationCmd
  .command("audit")
  .description("Inspect legacy runtime artifacts without mutating project state")
  .option("--project <path>", "Project path", process.cwd())
  .action((opts: { project: string }) => {
    const projectRoot = resolveProjectRoot(pathResolve(opts.project));
    console.log(renderRuntimeMigrationReport(buildRuntimeMigrationReport({ cwd: projectRoot })));
  });

migrationCmd
  .command("import")
  .description("Import legacy exchange artifacts into runtime-exchange.yaml with a rollback manifest")
  .option("--project <path>", "Project path", process.cwd())
  .action(async (opts: { project: string }) => {
    const projectRoot = resolveProjectRoot(pathResolve(opts.project));
    await initPaths(projectRoot);
    console.log(renderRuntimeMigrationImportResult(importRuntimeMigration({ cwd: projectRoot })));
  });

migrationCmd
  .command("rollback <manifest>")
  .description("Restore files recorded by a runtime migration manifest")
  .action((manifest: string) => {
    console.log(renderRuntimeMigrationRollbackResult(rollbackRuntimeMigration(pathResolve(manifest))));
  });

const logsCmd = program.command("logs").description("Inspect persistent aimux logs");

logsCmd
  .command("path")
  .description("Print the active log file path")
  .option("--daemon", "Show the global daemon log path")
  .option("--project <path>", "Project path")
  .action((opts: { daemon?: boolean; project?: string }) => {
    console.log(selectedLogPath(opts));
  });

logsCmd
  .command("tail")
  .description("Print recent log lines")
  .option("--daemon", "Tail the global daemon log")
  .option("--project <path>", "Project path")
  .option("-n, --lines <number>", "Number of lines to print", "80")
  .action((opts: { daemon?: boolean; project?: string; lines?: string }) => {
    const path = selectedLogPath(opts);
    const output = readLastLogLines(path, parseLineCount(opts.lines));
    if (output) {
      console.log(output);
      return;
    }
    console.error(`No log entries at ${path}`);
    process.exit(1);
  });

logsCmd
  .command("clear")
  .description("Clear the active log file")
  .option("--daemon", "Clear the global daemon log")
  .option("--project <path>", "Project path")
  .action((opts: { daemon?: boolean; project?: string }) => {
    const path = selectedLogPath(opts);
    mkdirSync(pathDirname(path), { recursive: true });
    writeFileSync(path, "");
    console.log(`Cleared ${path}`);
  });

doctorCmd
  .command("versions")
  .description("Inspect local daemon, project service, and dashboard version coherence")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    const report = await buildRuntimeCoherenceReport();
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(renderRuntimeCoherenceReport(report));
  });

doctorCmd
  .command("notifications")
  .description("Inspect desktop notification delivery")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    const report = await buildDesktopNotifierDoctorReport();
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(renderDesktopNotifierDoctorReport(report));
  });

doctorCmd
  .command("tmux")
  .description("Inspect managed tmux runtime state")
  .option("--project-root <path>", "Project root", process.cwd())
  .option("--session <name>", "Managed tmux session name override")
  .option("--window-id <id>", "Specific tmux window id to inspect")
  .option("--json", "Emit JSON")
  .action(async (opts: { projectRoot: string; session?: string; windowId?: string; json?: boolean }) => {
    await initPaths(opts.projectRoot);
    const tmux = new TmuxRuntimeManager();
    const report = buildTmuxDoctorReport(tmux, {
      projectRoot: opts.projectRoot,
      sessionName: opts.session,
      windowId: opts.windowId,
    });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(renderTmuxDoctorReport(report));
  });

notificationsCmd
  .command("test")
  .description("Send a desktop notification test")
  .option("--title <title>", "Notification title", "Aimux notification test")
  .option("--body <body>", "Notification body", "Desktop notification delivery is working.")
  .option("--json", "Emit JSON")
  .action(async (opts: { title: string; body: string; json?: boolean }) => {
    const attempt = await sendDesktopNotificationAndWait({
      title: opts.title.trim() || "Aimux notification test",
      message: opts.body.trim() || "Desktop notification delivery is working.",
      sound: true,
    });
    if (opts.json) {
      console.log(JSON.stringify({ ok: attempt.ok, attempt }, null, 2));
      if (!attempt.ok) process.exit(1);
      return;
    }
    if (!attempt.ok) {
      console.error(
        `Failed to send notification via ${attempt.transport}${attempt.helperPath ? ` (${attempt.helperPath})` : ""}${
          attempt.error ? `: ${attempt.error}` : ""
        }.`,
      );
      process.exit(1);
    }
    console.log(`Sent notification via ${attempt.transport}${attempt.helperPath ? ` (${attempt.helperPath})` : ""}.`);
  });

repairCmd
  .option("--project-root <path>", "Project root", process.cwd())
  .option("--open", "Open the repaired dashboard after fixing runtime state")
  .option("--json", "Emit JSON")
  .action(async (opts: { projectRoot: string; open?: boolean; json?: boolean }) => {
    const projectRoot = resolveProjectRoot(opts.projectRoot);
    await initPaths(projectRoot);
    await ensureDaemonProjectReady(projectRoot);
    const tmux = new TmuxRuntimeManager();
    ensureTmuxAvailable(tmux);
    const result = repairTmuxRuntime(tmux, { projectRoot });
    const backendReconcile = reconcileOfflineBackendSessionIds(projectRoot);
    if (opts.open) {
      const { dashboardTarget } = resolveDashboardTarget(projectRoot, tmux);
      tmux.openTarget(dashboardTarget, { insideTmux: tmux.isInsideTmux(), alreadyResolved: true });
      exitAfterOpen();
    }
    if (opts.json) {
      console.log(JSON.stringify({ ...result, backendReconcile }, null, 2));
      return;
    }
    console.log(renderTmuxRepairResult(result));
    if (backendReconcile.reconciled.length > 0) {
      console.log(`Recovered backend session id for ${backendReconcile.reconciled.length} offline agent(s):`);
      for (const entry of backendReconcile.reconciled) {
        console.log(`  ${entry.id} -> ${entry.backendSessionId}`);
      }
    }
  });

const metadataCmd = program.command("metadata").description("Push metadata into aimux tmux status integration");
const metadataTracker = new AgentTracker();

metadataCmd
  .command("endpoint")
  .description("Print the local metadata API endpoint")
  .action(async () => {
    await initPaths();
    const endpoint = loadMetadataEndpoint();
    if (!endpoint) {
      console.error("aimux metadata API is not running for this project");
      process.exit(1);
    }
    console.log(`http://${endpoint.host}:${endpoint.port}`);
  });

metadataCmd
  .command("event <session> <kind>")
  .option("--message <message>", "Event message")
  .option("--source <source>", "Event source")
  .option("--tone <tone>", "Event tone")
  .option("--thread-id <threadId>", "Thread identifier")
  .option("--thread-name <threadName>", "Thread name")
  .description("Emit a normalized agent event")
  .action(
    async (
      session: string,
      kind: AgentEventKind,
      opts: {
        message?: string;
        source?: string;
        tone?: MetadataTone;
        threadId?: string;
        threadName?: string;
      },
    ) => {
      await initPaths();
      metadataTracker.emit(session, {
        kind,
        message: opts.message,
        source: opts.source,
        tone: opts.tone,
        threadId: opts.threadId,
        threadName: opts.threadName,
      });
    },
  );

metadataCmd
  .command("mark-seen <session>")
  .description("Mark a session's unseen activity as seen")
  .action(async (session: string) => {
    await initPaths();
    metadataTracker.markSeen(session);
  });

metadataCmd
  .command("set-activity <session> <activity>")
  .description("Set derived activity state for a session")
  .action(async (session: string, activity: AgentActivityState) => {
    await initPaths();
    metadataTracker.setActivity(session, activity);
  });

metadataCmd
  .command("set-attention <session> <attention>")
  .description("Set derived attention state for a session")
  .action(async (session: string, attention: AgentAttentionState) => {
    await initPaths();
    metadataTracker.setAttention(session, attention);
  });

program
  .command("notify")
  .description("Send a project notification")
  .requiredOption("--title <title>", "Notification title")
  .option("--subtitle <subtitle>", "Notification subtitle")
  .option("--body <body>", "Notification body")
  .option("--session <sessionId>", "Related session id")
  .option("--kind <kind>", "Notification kind", "notification")
  .option("--json", "Emit JSON output")
  .action(
    async (opts: {
      title: string;
      subtitle?: string;
      body?: string;
      session?: string;
      kind?: string;
      json?: boolean;
    }) => {
      await initPaths();
      const title = opts.title.trim();
      const body = opts.body?.trim() || title;
      const result = await postProjectServiceJson("/notify", {
        title,
        subtitle: opts.subtitle?.trim() || undefined,
        message: body,
        sessionId: opts.session?.trim() || undefined,
        kind: opts.kind?.trim() || "notification",
        force: true,
      });
      if (opts.json) {
        console.log(JSON.stringify(result));
        return;
      }
      console.log(`Queued notification "${title}".`);
    },
  );

program
  .command("claude-hook <action>")
  .description("Internal Claude hook adapter modeled after cmux")
  .requiredOption("--session <sessionId>", "Aimux session id")
  .requiredOption("--project <path>", "Project path")
  .option("--json", "Emit JSON output")
  .action(async (action: string, opts: { session: string; project: string; json?: boolean }) => {
    const projectRoot = resolveProjectRoot(pathResolve(opts.project));
    await initPaths(projectRoot);
    const rawInput = await readAllStdin();
    const payload = parseClaudeHookPayload(rawInput);
    const sessionId = await resolveClaudeHookSessionId(opts.session, payload.session_id);
    const result: Record<string, unknown> = { ok: true, action, sessionId };
    if (payload.session_id) {
      result.backendSessionId = payload.session_id;
      // Prefer the live runtime so in-memory state updates immediately; fall
      // back to a strict topology latch only when the live service is absent.
      const recorded = await recordBackendSessionIdForHook(projectRoot, sessionId, payload.session_id);
      if (!recorded.ok) result.backendSessionRecordError = recorded.error;
    }

    const setActivity = async (activity: AgentActivityState) =>
      postHookProjectServiceJsonOrLocal(projectRoot, "/set-activity", { session: sessionId, activity }, () =>
        metadataTracker.setActivity(sessionId, activity, projectRoot),
      );
    const setAttention = async (attention: AgentAttentionState) =>
      postHookProjectServiceJsonOrLocal(projectRoot, "/set-attention", { session: sessionId, attention }, () =>
        metadataTracker.setAttention(sessionId, attention, projectRoot),
      );
    const emitEvent = async (kind: AgentEventKind, message?: string, tone?: MetadataTone) =>
      postHookProjectServiceJsonOrLocal(
        projectRoot,
        "/event",
        { session: sessionId, event: { kind, message, tone } },
        () => metadataTracker.emit(sessionId, { kind, message, tone }, projectRoot),
      );
    const clearSessionNotifications = async () => clearHookNotificationsViaService(projectRoot, sessionId);
    const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path.trim() : "";
    if (transcriptPath) {
      const context: SessionContextMetadata = { transcriptPath };
      await postHookProjectServiceJsonOrLocal(projectRoot, "/set-context", { session: sessionId, context }, () => {
        updateSessionMetadata(
          sessionId,
          (current) => ({
            ...current,
            context: {
              ...(current.context ?? {}),
              ...context,
            },
          }),
          projectRoot,
        );
        return { ok: true };
      });
      result.transcriptPath = transcriptPath;
    }

    switch (action) {
      case "session-start":
      case "active":
        break;
      case "prompt-submit":
      case "pre-tool-use":
        await clearSessionNotifications();
        await setActivity("running");
        await setAttention("normal");
        await postHookProjectServiceJsonOrLocal(projectRoot, "/mark-seen", { session: sessionId }, () =>
          metadataTracker.markSeen(sessionId, projectRoot),
        );
        break;
      case "notification":
      case "notify": {
        const summary = summarizeClaudeNotification(payload);
        await emitEvent("needs_input", summary.body, "warn");
        break;
      }
      case "stop":
      case "idle": {
        const summary = summarizeClaudeStop(payload);
        await emitEvent("task_done", summary.body, "success");
        break;
      }
      case "permission-request": {
        console.log(JSON.stringify(await resolvePermissionRequestOutput(projectRoot, sessionId, payload)));
        return;
      }
      case "session-end":
        break;
      default:
        throw new Error(`Unsupported claude hook action: ${action}`);
    }

    if (opts.json) {
      console.log(JSON.stringify(result));
      return;
    }
    console.log("OK");
  });

program
  .command("codex-hook <action>")
  .description("Internal Codex hook adapter (mirrors claude-hook)")
  .requiredOption("--session <sessionId>", "Aimux session id")
  .requiredOption("--project <path>", "Project path")
  .option("--json", "Emit JSON output")
  .action(async (action: string, opts: { session: string; project: string; json?: boolean }) => {
    const projectRoot = resolveProjectRoot(pathResolve(opts.project));
    await initPaths(projectRoot);
    const rawInput = await readAllStdin();
    const payload = parseCodexHookPayload(rawInput);
    const sessionId = opts.session.trim();

    const result: Record<string, unknown> = { ok: true, action, sessionId };
    const setActivity = async (activity: AgentActivityState) =>
      postHookProjectServiceJsonOrLocal(projectRoot, "/set-activity", { session: sessionId, activity }, () =>
        metadataTracker.setActivity(sessionId, activity, projectRoot),
      );
    const setAttention = async (attention: AgentAttentionState) =>
      postHookProjectServiceJsonOrLocal(projectRoot, "/set-attention", { session: sessionId, attention }, () =>
        metadataTracker.setAttention(sessionId, attention, projectRoot),
      );
    const emitEvent = async (kind: AgentEventKind, message?: string, tone?: MetadataTone) =>
      postHookProjectServiceJsonOrLocal(
        projectRoot,
        "/event",
        { session: sessionId, event: { kind, message, tone } },
        () => metadataTracker.emit(sessionId, { kind, message, tone }, projectRoot),
      );
    const clearSessionNotifications = async () => clearHookNotificationsViaService(projectRoot, sessionId);

    const backendSessionId = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
    if (backendSessionId) {
      result.backendSessionId = backendSessionId;
      const recorded = await recordBackendSessionIdForHook(projectRoot, sessionId, backendSessionId);
      if (!recorded.ok) result.backendSessionRecordError = recorded.error;
    }

    switch (action) {
      case "session-start":
        break;
      case "prompt-submit":
        await clearSessionNotifications();
        await setActivity("running");
        await setAttention("normal");
        await postHookProjectServiceJsonOrLocal(projectRoot, "/mark-seen", { session: sessionId }, () =>
          metadataTracker.markSeen(sessionId, projectRoot),
        );
        break;
      case "stop":
        await emitEvent("task_done", payload.message?.trim() || "Codex completed its turn.", "success");
        break;
      case "permission-request": {
        // Read-only telemetry — never block. Codex's native TUI prompt stays the
        // primary decision surface; we post a non-actionable Feed notice (which
        // also flags attention). Falls through to `console.log({})` → native prompt.
        const { toolName, input, summary } = summarizeClaudePermissionRequest(payload);
        // Best-effort: a telemetry transport failure must never break the hook —
        // it always falls through to `console.log({})` and the native prompt.
        await postHookProjectServiceJsonOrLocal(
          projectRoot,
          "/agents/interaction/notify",
          { session: sessionId, summary, payload: { toolName, input, cwd: process.cwd() } },
          () => ({}),
        ).catch(() => undefined);
        break;
      }
      default:
        throw new Error(`Unsupported codex hook action: ${action}`);
    }

    console.log(JSON.stringify(opts.json ? result : {}));
  });

program
  .command("list-notifications")
  .description("List project notifications")
  .option("--unread", "Show only unread notifications")
  .option("--session <sessionId>", "Filter by session id")
  .option("--json", "Emit JSON output")
  .action(async (opts: { unread?: boolean; session?: string; json?: boolean }) => {
    await initPaths();
    const result = await getProjectServiceJson(`/notifications${notificationQuery(opts)}`);
    const notifications = Array.isArray(result.notifications) ? result.notifications : [];
    const unreadCount = typeof result.unreadCount === "number" ? result.unreadCount : 0;
    if (opts.json) {
      console.log(JSON.stringify({ notifications, unreadCount }));
      return;
    }
    if (notifications.length === 0) {
      console.log("No notifications.");
      return;
    }
    for (const notification of notifications) {
      const state = notification.unread ? "unread" : "read";
      const session = notification.sessionId ? ` [${notification.sessionId}]` : "";
      console.log(`${notification.id} ${state}${session} ${notification.title}: ${notification.body}`);
    }
  });

program
  .command("clear-notifications")
  .description("Clear project notifications")
  .option("--session <sessionId>", "Clear only notifications for a session")
  .option("--json", "Emit JSON output")
  .action(async (opts: { session?: string; json?: boolean }) => {
    await initPaths();
    const result = await postProjectServiceJson("/notifications/clear", {
      sessionId: opts.session?.trim() || undefined,
    });
    const cleared = typeof result.cleared === "number" ? result.cleared : 0;
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, cleared }));
      return;
    }
    console.log(`Cleared ${cleared} notification${cleared === 1 ? "" : "s"}.`);
  });

program
  .command("read-notifications")
  .description("Mark project notifications as read")
  .option("--session <sessionId>", "Mark only notifications for a session as read")
  .option("--json", "Emit JSON output")
  .action(async (opts: { session?: string; json?: boolean }) => {
    await initPaths();
    const result = await postProjectServiceJson("/notifications/read", {
      sessionId: opts.session?.trim() || undefined,
    });
    const updated = typeof result.updated === "number" ? result.updated : 0;
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, updated }));
      return;
    }
    console.log(`Marked ${updated} notification${updated === 1 ? "" : "s"} as read.`);
  });

metadataCmd
  .command("set-status <session> <text>")
  .option("--tone <tone>", "Status tone", "info")
  .description("Set a session status pill")
  .action(async (session: string, text: string, opts: { tone?: MetadataTone }) => {
    await initPaths();
    updateSessionMetadata(session, (current) => ({
      ...current,
      status: { text, tone: opts.tone },
    }));
  });

metadataCmd
  .command("set-progress <session> <current> <total>")
  .option("--label <label>", "Progress label")
  .description("Set per-session progress")
  .action(async (session: string, current: string, total: string, opts: { label?: string }) => {
    await initPaths();
    updateSessionMetadata(session, (existing) => ({
      ...existing,
      progress: { current: Number(current), total: Number(total), label: opts.label },
    }));
  });

metadataCmd
  .command("set-context <session>")
  .option("--cwd <cwd>", "Working directory")
  .option("--worktree-path <path>", "Worktree path")
  .option("--worktree-name <name>", "Worktree name")
  .option("--branch <branch>", "Git branch")
  .option("--pr-number <number>", "PR number")
  .option("--pr-title <title>", "PR title")
  .option("--pr-url <url>", "PR URL")
  .description("Set rich session context metadata")
  .action(
    async (
      session: string,
      opts: {
        cwd?: string;
        worktreePath?: string;
        worktreeName?: string;
        branch?: string;
        prNumber?: string;
        prTitle?: string;
        prUrl?: string;
      },
    ) => {
      await initPaths();
      const context: SessionContextMetadata = {
        cwd: opts.cwd,
        worktreePath: opts.worktreePath,
        worktreeName: opts.worktreeName,
        branch: opts.branch,
        pr:
          opts.prNumber || opts.prTitle || opts.prUrl
            ? {
                number: opts.prNumber ? Number(opts.prNumber) : undefined,
                title: opts.prTitle,
                url: opts.prUrl,
              }
            : undefined,
      };
      updateSessionMetadata(session, (existing) => ({
        ...existing,
        context: {
          ...(existing.context ?? {}),
          ...context,
          pr: {
            ...(existing.context?.pr ?? {}),
            ...(context.pr ?? {}),
          },
        },
      }));
    },
  );

metadataCmd
  .command("set-services <session>")
  .requiredOption("--url <url...>", "One or more service URLs")
  .option("--label <label>", "Shared label for the services")
  .description("Set detected session services/ports")
  .action(async (session: string, opts: { url: string[]; label?: string }) => {
    await initPaths();
    const services: SessionServiceMetadata[] = (opts.url ?? []).map((url) => {
      const match = url.match(/:(\d+)(?:\/|$)/);
      return {
        label: opts.label,
        url,
        port: match ? Number(match[1]) : undefined,
      };
    });
    updateSessionMetadata(session, (existing) => ({
      ...existing,
      derived: {
        ...(existing.derived ?? {}),
        services,
      },
    }));
  });

metadataCmd
  .command("log <session> <message>")
  .option("--source <source>", "Log source")
  .option("--tone <tone>", "Log tone")
  .description("Append a session log line")
  .action(async (session: string, message: string, opts: { source?: string; tone?: MetadataTone }) => {
    await initPaths();
    updateSessionMetadata(session, (existing) => ({
      ...existing,
      logs: [
        ...(existing.logs ?? []).slice(-19),
        { message, source: opts.source, tone: opts.tone, ts: new Date().toISOString() },
      ],
    }));
  });

metadataCmd
  .command("clear-log <session>")
  .description("Clear session logs")
  .action(async (session: string) => {
    await initPaths();
    clearSessionLogs(session);
  });

// ── Team commands ──────────────────────────────────────────────────

const teamCmd = program.command("team").description("Manage agent team roles");

teamCmd
  .command("show")
  .description("Show current team config")
  .action(() => {
    const config = loadTeamConfig();
    console.log("Team Roles:");
    for (const [name, role] of Object.entries(config.roles) as [string, any][]) {
      const flags: string[] = [];
      if (role.reviewedBy) flags.push(`reviewed by: ${role.reviewedBy}`);
      if (role.canEdit) flags.push("can edit");
      const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
      console.log(`  ${name}: ${role.description}${flagStr}`);
    }
    console.log(`\nDefault role: ${config.defaultRole}`);
  });

teamCmd
  .command("add <role>")
  .description("Add or update a role")
  .option("-d, --description <desc>", "Role description")
  .option("--reviewed-by <role>", "Role that reviews this role's work")
  .option("--can-edit", "Whether this role can edit code directly")
  .action((role: string, options: { description?: string; reviewedBy?: string; canEdit?: boolean }) => {
    const config = loadTeamConfig();
    config.roles[role] = {
      description: options.description ?? config.roles[role]?.description ?? `${role} agent`,
      ...(options.reviewedBy && { reviewedBy: options.reviewedBy }),
      ...(options.canEdit && { canEdit: true }),
    };
    saveTeamConfig(config);
    console.log(`Role "${role}" saved.`);
  });

teamCmd
  .command("remove <role>")
  .description("Remove a role")
  .action((role: string) => {
    const config = loadTeamConfig();
    if (!config.roles[role]) {
      console.error(`Role "${role}" not found.`);
      process.exit(1);
    }
    delete config.roles[role];
    if (config.defaultRole === role) {
      config.defaultRole = Object.keys(config.roles)[0] ?? "coder";
    }
    saveTeamConfig(config);
    console.log(`Role "${role}" removed.`);
  });

teamCmd
  .command("default <role>")
  .description("Set the default role for new agents")
  .action((role: string) => {
    const config = loadTeamConfig();
    if (!config.roles[role]) {
      console.error(`Role "${role}" not found. Add it first with: aimux team add ${role}`);
      process.exit(1);
    }
    config.defaultRole = role;
    saveTeamConfig(config);
    console.log(`Default role set to "${role}".`);
  });

teamCmd
  .command("init")
  .description("Initialize project with default team structure")
  .action(() => {
    const config = getDefaultTeamConfig();
    saveTeamConfig(config);
    console.log("Team config initialized with default roles:");
    for (const [name, role] of Object.entries(config.roles) as [string, any][]) {
      console.log(`  ${name}: ${role.description}`);
    }
  });

program.parse();
