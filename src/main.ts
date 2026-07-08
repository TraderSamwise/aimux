import { Command } from "commander";
import { readFileSync, readdirSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
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
import { clearLogFile, parseLineCount, readLastLogLines, selectedLogPath } from "./logs.js";
import { PROJECT_API_ROUTES, type TeamConfig } from "./project-api-contract.js";
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
  type MetadataTone,
  type SessionContextMetadata,
  type SessionServiceMetadata,
  removeMetadataEndpoint,
} from "./metadata-store.js";
import type { AgentActivityState, AgentAttentionState, AgentEventKind } from "./agent-events.js";
import { AimuxDaemon } from "./daemon.js";
import { getDaemonHost, getDaemonPort, loadDaemonInfo, loadDaemonState } from "./daemon-state.js";
import { stopDaemon } from "./daemon-supervisor.js";
import { requestCoreCommand } from "./core-command-client.js";
import {
  CORE_COMMAND_NAMES,
  type CoreProjectServiceState,
  type CoreRelaySnapshot,
  type CoreStatusProject,
} from "./core-command-contract.js";
import { getProjectServiceManifest, manifestsMatch, type ProjectServiceManifest } from "./project-service-manifest.js";
import { type MessageKind, type ThreadKind, type ThreadStatus } from "./threads.js";
import { runLoginFlow } from "./login-flow.js";
import { clearCredentials, loadCredentials, setRemoteEnabled } from "./credentials.js";
import { takeOverProjectFromOtherOwners } from "./project-takeover.js";
import {
  buildDesktopNotifierDoctorReport,
  renderDesktopNotifierDoctorReport,
  sendDesktopNotificationAndWait,
} from "./desktop-notifier.js";
import { requestJson } from "./http-client.js";
import { buildDebugStateReport, renderDebugStateReport } from "./debug-state.js";
import { findLiveDashboardTarget, openDashboardTarget, resolveDashboardTarget } from "./dashboard/targets.js";
import { invalidateTmuxStatuslineArtifacts } from "./tmux/statusline-cache.js";
import { rewriteDashboardStatuslineArtifacts } from "./tmux/statusline-artifacts.js";
import { stopProjectTmuxRuntime } from "./tmux/runtime-stop.js";
import { configureLogging, log, resolveLoggingRuntimeConfig, type LoggingCliOptions } from "./debug.js";
import { createRuntimeTopologyStore } from "./runtime-core/topology-store.js";
import { reconcileOfflineBackendSessionIds } from "./runtime-core/backend-id-reconcile.js";
import { type GraveyardCleanupRunResult } from "./graveyard-cleanup.js";
import {
  buildRuntimeMigrationReport,
  importRuntimeMigration,
  renderRuntimeMigrationImportResult,
  renderRuntimeMigrationReport,
  renderRuntimeMigrationRollbackResult,
  rollbackRuntimeMigration,
} from "./runtime-migration.js";
import { createAgentOutputSseTextHandler } from "./agent-output-stream.js";
import {
  DEFAULT_LOCAL_UI_HOST,
  DEFAULT_LOCAL_UI_PORT,
  openUrlInBrowser,
  startLocalUiServer,
} from "./local-ui-server.js";
import { buildRuntimeCoherenceReport, renderRuntimeCoherenceReport } from "./runtime-coherence.js";
import { restartControlPlaneFromCli } from "./control-plane-restart-client.js";
import { isAimuxBuildDriftError } from "./runtime-drift.js";
import { registerExposeCommand } from "./popup-expose.js";
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

class ProjectServiceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
    message: string,
  ) {
    super(message);
    this.name = "ProjectServiceHttpError";
  }
}

const PROJECT_SERVICE_READ_TIMEOUT_MS = 15_000;

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
  const result = (await restartControlPlaneFromCli(projectRoot)).restart;
  const project = result.projects.find((entry) => entry.projectRoot === projectRoot);
  if (!project) throw new Error("failed to restart project service: project was not included in restart result");
  if (project.runtime.status === "failed") {
    throw new Error(project.runtime.error ?? "failed to repair tmux runtime");
  }
  if (project?.service.status === "failed") {
    throw new Error(project.service.error ?? "failed to restart project service");
  }
  if (project.dashboard.status === "failed") {
    throw new Error(project.dashboard.error ?? "failed to reload dashboard");
  }
  if (result.verification.status === "failed") {
    throw new Error(result.verification.error ?? "post-restart verification failed");
  }
}

async function fetchProjectServiceHealth(endpoint: { host: string; port: number }): Promise<{
  serviceInfo?: ProjectServiceManifest;
  pid?: number;
  projectStateDir?: string;
}> {
  const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}/health`, {
    timeoutMs: 1000,
  });
  if (status < 200 || status >= 300 || json?.ok === false) {
    throw new Error(json?.error || `health request failed: ${status}`);
  }
  return json as { serviceInfo?: ProjectServiceManifest; pid?: number; projectStateDir?: string };
}

async function waitForVerifiedProjectService(
  projectRoot: string,
  opts?: { timeoutMs?: number },
): Promise<{
  endpoint: { host: string; port: number; pid: number };
  health: { serviceInfo?: ProjectServiceManifest; pid?: number; projectStateDir?: string };
}> {
  const expected = getProjectServiceManifest();
  const expectedProjectStateDir = getProjectStateDirFor(projectRoot);
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastError = "project service did not become reachable";
  let lastServiceInfo: unknown = null;
  let respawnAttempted = false;
  let missingEndpointSince = 0;

  while (Date.now() < deadline) {
    const endpoint = loadMetadataEndpoint(projectRoot);
    if (endpoint) {
      missingEndpointSince = 0;
      try {
        const health = await fetchProjectServiceHealth(endpoint);
        lastServiceInfo = health.serviceInfo ?? null;
        if (health.pid !== endpoint.pid) {
          lastError = `project service pid mismatch: endpoint ${endpoint.pid} health ${health.pid ?? "unknown"}`;
          log.warn("project service pid mismatch", "runtime", {
            projectRoot,
            endpoint,
            healthPid: health.pid,
          });
          if (!respawnAttempted) {
            respawnAttempted = true;
            await restartCoreProjectServiceForReadiness(projectRoot);
          } else {
            removeMetadataEndpoint(projectRoot);
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
          continue;
        }
        if (health.projectStateDir !== expectedProjectStateDir) {
          lastError = `project service projectStateDir mismatch: expected ${expectedProjectStateDir} actual ${
            health.projectStateDir ?? "unknown"
          }`;
          log.warn("project service projectStateDir mismatch", "runtime", {
            projectRoot,
            endpoint,
            expectedProjectStateDir,
            actualProjectStateDir: health.projectStateDir ?? null,
          });
          if (!respawnAttempted) {
            respawnAttempted = true;
            await restartCoreProjectServiceForReadiness(projectRoot);
          } else {
            removeMetadataEndpoint(projectRoot);
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
          continue;
        }
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
          await ensureCoreProjectServiceForReadiness(projectRoot);
        }
      }
    } else {
      lastError = "no live project service metadata endpoint";
      if (!missingEndpointSince) {
        missingEndpointSince = Date.now();
      } else if (!respawnAttempted && Date.now() - missingEndpointSince >= 1000) {
        respawnAttempted = true;
        log.warn("respawning project service after missing endpoint", "runtime", { projectRoot });
        await restartCoreProjectServiceForReadiness(projectRoot);
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

const rewriteLocalStatuslineArtifacts = rewriteDashboardStatuslineArtifacts;

async function postProjectServiceJson(
  path: string,
  body: unknown,
  options?: { timeoutMs?: number; projectRoot?: string },
): Promise<any> {
  const projectRoot = options?.projectRoot ?? resolveProjectRoot(process.cwd());
  await ensureDaemonProjectReady(projectRoot);
  const endpoint = await resolveProjectServiceEndpoint(projectRoot);
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

async function getProjectServiceJson(path: string, opts?: { notFound?: "null"; projectRoot?: string }): Promise<any> {
  const projectRoot = opts?.projectRoot ?? resolveProjectRoot(process.cwd());
  await ensureDaemonProjectReady(projectRoot);
  let endpoint = await resolveProjectServiceEndpoint(projectRoot);
  if (!endpoint) {
    throw new Error("no live project service metadata endpoint");
  }
  let status: number;
  let json: any;
  try {
    ({ status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}${path}`, {
      timeoutMs: PROJECT_SERVICE_READ_TIMEOUT_MS,
    }));
  } catch {
    removeMetadataEndpoint(projectRoot);
    await ensureDaemonProjectReady(projectRoot);
    endpoint = await resolveProjectServiceEndpoint(projectRoot);
    if (!endpoint) {
      throw new Error("no live project service metadata endpoint");
    }
    ({ status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}${path}`, {
      timeoutMs: PROJECT_SERVICE_READ_TIMEOUT_MS,
    }));
  }
  if (status === 404 && opts?.notFound === "null") {
    return null;
  }
  if (status < 200 || status >= 300 || json?.ok === false) {
    throw new ProjectServiceHttpError(status, json, json?.error || `request failed: ${status}`);
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

function notificationMutationInput(opts: { id?: string; ids?: string; session?: string }): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const id = opts.id?.trim();
  const ids = opts.ids
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const sessionId = opts.session?.trim();
  if (id) payload.id = id;
  if (ids && ids.length > 0) payload.ids = ids;
  if (sessionId) payload.sessionId = sessionId;
  return payload;
}

function exitAfterOpen(): never {
  process.exit(0);
}

async function postLiveProjectServiceJson(projectRoot: string, path: string, body: unknown): Promise<any> {
  await ensureDaemonProjectReady(projectRoot);
  const endpoint = await resolveProjectServiceEndpoint(projectRoot);
  if (!endpoint) {
    throw new Error("no live project service metadata endpoint");
  }
  const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (status < 200 || status >= 300 || json?.ok === false) {
    throw new Error(json?.error || `request failed: ${status}`);
  }
  return json;
}

async function getLiveProjectServiceJson(projectRoot: string, path: string): Promise<any> {
  await ensureDaemonProjectReady(projectRoot);
  const endpoint = await resolveProjectServiceEndpoint(projectRoot);
  if (!endpoint) {
    throw new Error("no live project service metadata endpoint");
  }
  const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}${path}`, {
    method: "GET",
    timeoutMs: PROJECT_SERVICE_READ_TIMEOUT_MS,
  });
  if (status < 200 || status >= 300 || json?.ok === false) {
    throw new Error(json?.error || `request failed: ${status}`);
  }
  return json;
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
    await ensureCoreProjectServiceForCli(projectRoot);
    endpoint = await resolveProjectServiceEndpoint(projectRoot);
  }
  if (!endpoint) {
    throw new Error("no live project service metadata endpoint");
  }
  return endpoint;
}

async function ensureDaemonProjectReady(projectRoot: string, opts?: { repairVersionDrift?: boolean }): Promise<void> {
  if (opts?.repairVersionDrift === false) {
    await ensureCoreProjectServiceForCli(projectRoot);
    return;
  }
  await ensureCoreProjectServiceForCliWithRepair(projectRoot);
}

async function ensureDaemonProjectSpawned(projectRoot: string): Promise<void> {
  await ensureDaemonProjectReady(projectRoot);
}

function isLocalControlPlaneTransientStartupError(error: unknown): boolean {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    message.includes("ECONNRESET") ||
    message.includes("ECONNREFUSED") ||
    message.includes("project service exited before it became ready") ||
    message.includes("socket hang up") ||
    message.includes("request timed out")
  );
}

function isRepairableCoreProjectStartupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    error instanceof ProjectServiceVersionError ||
    isAimuxBuildDriftError(error) ||
    isLocalControlPlaneTransientStartupError(error) ||
    message.includes("project service did not become ready")
  );
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
  const projectServiceResponse = await requestCoreCommand(CORE_COMMAND_NAMES.projectStop, { projectRoot });
  const projectService = projectServiceResponse.result.project;
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
  opts: { open?: boolean; clientTty?: string } = {},
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
    tmux.openTarget(resolved.dashboardTarget, {
      insideTmux: tmux.isInsideTmux() || Boolean(opts.clientTty),
      alreadyResolved: true,
      clientTty: opts.clientTty,
    });
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

function loggingProcessKind(command: Command): "cli" | "daemon" {
  const names = commandPath(command);
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

function parsePortOption(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Port must be an integer between 1 and 65535, got ${value}`);
  }
  return parsed;
}

function findCoreProject(projects: CoreStatusProject[], projectRoot: string): CoreStatusProject | null {
  const resolvedRoot = pathResolve(projectRoot);
  return projects.find((project) => pathResolve(project.path) === resolvedRoot) ?? null;
}

function coreProjectServicePid(project: CoreStatusProject | null): number | null {
  const service = project?.service;
  return service && typeof service === "object" && typeof (service as { pid?: unknown }).pid === "number"
    ? (service as { pid: number }).pid
    : null;
}

async function ensureCoreProjectServiceForReadiness(projectRoot: string): Promise<CoreProjectServiceState> {
  const response = await requestCoreCommand(CORE_COMMAND_NAMES.projectEnsure, { projectRoot });
  return response.result.project;
}

async function restartCoreProjectServiceForReadiness(projectRoot: string): Promise<CoreProjectServiceState> {
  await requestCoreCommand(CORE_COMMAND_NAMES.projectStop, { projectRoot });
  removeMetadataEndpoint(projectRoot);
  return ensureCoreProjectServiceForReadiness(projectRoot);
}

async function ensureCoreProjectServiceForCli(projectRoot: string): Promise<CoreProjectServiceState> {
  const project = await ensureCoreProjectServiceForReadiness(projectRoot);
  await waitForVerifiedProjectService(projectRoot);
  return project;
}

async function ensureCoreProjectServiceForCliWithRepair(projectRoot: string): Promise<CoreProjectServiceState> {
  try {
    return await ensureCoreProjectServiceForCli(projectRoot);
  } catch (error) {
    if (!isRepairableCoreProjectStartupError(error)) {
      throw error;
    }
    await restartStaleControlPlane(projectRoot);
    return await ensureCoreProjectServiceForCli(projectRoot);
  }
}

async function stopCoreProjectServiceForCliWithRepair(projectRoot: string): Promise<void> {
  try {
    await requestCoreCommand(CORE_COMMAND_NAMES.projectStop, { projectRoot });
  } catch (error) {
    if (!isRepairableCoreProjectStartupError(error)) {
      throw error;
    }
    await restartStaleControlPlane(projectRoot);
  }
}

function relayLastError(relay: CoreRelaySnapshot): string | null {
  return "lastError" in relay ? relay.lastError : null;
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

      const mux = new Multiplexer({ contextWatcherEnabled: !opts.tmuxDashboardInternal });
      let cleanedUp = false;
      const ensureTerminalRestored = () => mux.cleanupTerminalOnly();
      const cleanupAll = async () => {
        if (cleanedUp) return;
        cleanedUp = true;
        await mux.cleanup();
      };

      // Graceful shutdown on signals
      const shutdown = () => {
        void cleanupAll().finally(() => process.exit(0));
      };
      process.on("exit", ensureTerminalRestored);
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.on("uncaughtException", (err) => {
        log.error("uncaught exception", "runtime", {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        console.error(err);
        void cleanupAll().finally(() => process.exit(1));
      });
      process.on("unhandledRejection", (reason) => {
        log.error("unhandled rejection", "runtime", {
          error: reason instanceof Error ? reason.message : String(reason),
          stack: reason instanceof Error ? reason.stack : undefined,
        });
        console.error(reason);
        void cleanupAll().finally(() => process.exit(1));
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
        await cleanupAll();
        process.exit(exitCode);
      } catch (err: unknown) {
        await cleanupAll();
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
      const { restart: result, text } = await restartControlPlaneFromCli(projectRoot);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        if (result.summary.failures > 0) process.exitCode = 1;
        return;
      }
      console.log(text);
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
  .option("--client-tty <tty>", "tmux client tty to switch after reloading")
  .option("--current-client-session <name>", "Current client session to reopen")
  .action(async (opts: { open?: boolean; clientTty?: string; currentClientSession?: string }) => {
    try {
      const originalCwd = process.cwd();
      const projectRoot = resolveProjectRoot(originalCwd);
      await ensureDaemonProjectReady(projectRoot);
      invalidateTmuxStatuslineArtifacts(projectRoot);

      const tmux = new TmuxRuntimeManager();
      ensureTmuxAvailable(tmux);
      const { dashboardSession, dashboardTarget } = resolveDashboardTarget(projectRoot, tmux, {
        forceReload: true,
        openInHostSession: true,
      });
      try {
        await postProjectServiceJson("/statusline/refresh", { force: true }, { timeoutMs: 1500 });
      } catch {}
      rewriteLocalStatuslineArtifacts(projectRoot, tmux, dashboardSession.sessionName);

      if (opts.open) {
        const clientTty = opts.clientTty?.trim() || undefined;
        const returnSessionName = opts.currentClientSession?.trim() || undefined;
        const clientSuffix = returnSessionName?.match(/-client-([0-9a-f]{8})$/)?.[1];
        tmux.openTarget(dashboardTarget, {
          insideTmux: tmux.isInsideTmux() || Boolean(clientTty || clientSuffix),
          alreadyResolved: true,
          clientTty,
          clientSuffix,
          returnSessionName,
        });
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
        const result = await postLiveProjectServiceJson(projectRoot, "/agents/stop", { sessionId });
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
  .option("--client-tty <tty>", "tmux client tty to switch after reopening")
  .option("--json", "Emit JSON")
  .action(async (opts: { projectRoot: string; open?: boolean; clientTty?: string; json?: boolean }) => {
    try {
      const projectRoot = resolveProjectRoot(opts.projectRoot);
      await initPaths(projectRoot);
      const result = await restartProjectRuntime(projectRoot, {
        open: opts.open,
        clientTty: opts.clientTty?.trim() || undefined,
      });
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

const hostCmd = program.command("host").description("Advanced project-service inspection commands");

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
      const coreStatus = shouldEnsureDaemon ? await requestCoreCommand(CORE_COMMAND_NAMES.status) : null;
      const daemonUrl =
        opts.daemonUrl?.trim() || `http://${getDaemonHost()}:${coreStatus?.result.daemon.port ?? getDaemonPort()}`;
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
  .description("Advanced: ensure the daemon-backed project control service is running")
  .action(async () => {
    const projectRoot = resolveProjectRoot(process.cwd());
    if (projectRoot !== process.cwd()) {
      process.chdir(projectRoot);
    }
    await initPaths(projectRoot);
    const project = await ensureCoreProjectServiceForCliWithRepair(projectRoot);
    console.log(`aimux serve: daemon managing ${projectRoot} (service pid ${project.pid})`);
  });

hostCmd
  .command("status")
  .description("Show current project control-service status")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    await initPaths();
    const projectRoot = resolveProjectRoot(process.cwd());
    const response = await requestCoreCommand(CORE_COMMAND_NAMES.status);
    const project = findCoreProject(response.result.projects, projectRoot);
    const payload = {
      projectRoot,
      sessionName: project?.dashboardSessionName ?? null,
      daemon: response.result.daemon,
      projectService: project?.service ?? null,
      serviceAlive: project?.serviceAlive ?? false,
      metadataEndpoint: project?.serviceEndpoint ?? null,
      expectedServiceManifest: response.result.daemon.serviceInfo,
    };
    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (!project) {
      console.log(`No known control service for ${projectRoot}`);
      return;
    }
    console.log(`Service: ${project.serviceAlive ? "live" : "idle"}`);
    const pid = coreProjectServicePid(project);
    if (pid !== null) console.log(`Service pid=${pid}`);
    console.log(`Metadata: ${project.serviceEndpoint ? JSON.stringify(project.serviceEndpoint) : "not running"}`);
    console.log(`Expected manifest: ${JSON.stringify(response.result.daemon.serviceInfo)}`);
    console.log(`Tmux session: ${project.dashboardSessionName}`);
  });

hostCmd
  .command("stop")
  .description("Stop the current project's daemon-managed control service")
  .action(async () => {
    await initPaths();
    const projectRoot = resolveProjectRoot(process.cwd());
    const response = await requestCoreCommand(CORE_COMMAND_NAMES.projectStop, { projectRoot });
    if (!response.result.project) {
      console.log("No live project service to stop.");
      return;
    }
    console.log(`Stopped project service pid ${response.result.project.pid}`);
  });

hostCmd
  .command("kill")
  .description("Force kill the current project's daemon-managed control service")
  .action(async () => {
    await initPaths();
    const projectRoot = resolveProjectRoot(process.cwd());
    const response = await requestCoreCommand(CORE_COMMAND_NAMES.projectKill, { projectRoot });
    if (!response.result.project) {
      console.log("No live project service to kill.");
      return;
    }
    console.log(`Killed project service pid ${response.result.project.pid}`);
  });

hostCmd
  .command("restart")
  .description("Restart the current project's daemon-managed control service")
  .option("--open", "Open the dashboard after restarting")
  .option("--serve", "Restart the project service without reopening the dashboard")
  .action(async (opts: { open?: boolean; serve?: boolean }) => {
    await initPaths();
    const projectRoot = resolveProjectRoot(process.cwd());
    await stopCoreProjectServiceForCliWithRepair(projectRoot);
    await ensureCoreProjectServiceForCliWithRepair(projectRoot);
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
      const textHandler = createAgentOutputSseTextHandler(sessionId, (text) => process.stdout.write(text));

      for await (const chunk of res.body) {
        textHandler.pushChunkText(decoder.decode(chunk, { stream: true }));
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
  console.log("Use `aimux host status` or `aimux host --help` to inspect project services.");
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
    const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.status);
    if (opts.json) {
      console.log(JSON.stringify({ daemon: result.daemon }, null, 2));
      return;
    }
    console.log(`aimux daemon: pid ${result.daemon.pid} on http://127.0.0.1:${result.daemon.port}`);
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
    const { restart: result, text } = await restartControlPlaneFromCli();
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      if (result.summary.failures > 0) process.exitCode = 1;
      return;
    }
    console.log(text);
    if (result.summary.failures > 0) process.exitCode = 1;
  });

daemonCmd
  .command("status")
  .description("Show daemon status")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    const info = loadDaemonInfo();
    const state = loadDaemonState();
    let payload: {
      daemon: unknown;
      projects: unknown[];
      relay: CoreRelaySnapshot;
    };
    try {
      const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.status, undefined, {
        ensureDaemon: false,
        timeoutMs: 1000,
      });
      const serviceAliveById = new Map(result.projects.map((project) => [project.id, project.serviceAlive]));
      payload = {
        daemon: result.daemon,
        projects: Object.values(state.projects).map((project) => ({
          ...project,
          serviceAlive: serviceAliveById.get(project.projectId) ?? false,
        })),
        relay: result.relay,
      };
    } catch {
      payload = {
        daemon: info,
        projects: Object.values(state.projects).map((project) => ({ ...project, serviceAlive: false })),
        relay: { status: "off" },
      };
    }
    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    const daemon = payload.daemon as { pid?: number; port?: number } | null;
    if (!daemon) {
      console.log("aimux daemon is not running.");
      return;
    }
    console.log(`Daemon pid=${daemon.pid} port=${daemon.port}`);
    const projects = payload.projects as Array<{ serviceAlive?: boolean }>;
    const liveProjectServices = projects.filter((project) => project.serviceAlive).length;
    console.log(`Known projects: ${projects.length}`);
    console.log(`Live project services: ${liveProjectServices}`);
    const r = payload.relay;
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
    const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.projectsList);
    if (opts.json) {
      console.log(JSON.stringify({ projects: result.projects }, null, 2));
      return;
    }
    for (const project of result.projects) {
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
    const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.projectEnsure, { projectRoot });
    if (opts.json) {
      console.log(JSON.stringify({ project: result.project }, null, 2));
      return;
    }
    console.log(`Ensured project service for ${projectRoot} (pid ${result.project.pid})`);
  });

const projectsCmd = program.command("projects").description("Inspect known aimux projects");

projectsCmd
  .command("list")
  .description("List known aimux projects")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.projectsList);
    const projects = result.projects;
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
          const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.relayEnable, undefined, {
            ensureDaemon: false,
            timeoutMs: 1000,
          });
          const relay = result.relay;
          relayStatus = relay.status ?? "unknown";
          relayError = relayLastError(relay);
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
        await requestCoreCommand(CORE_COMMAND_NAMES.relayDisable, undefined, { ensureDaemon: false, timeoutMs: 1000 });
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
    let relay: CoreRelaySnapshot = { status: "off" };
    if (loadDaemonInfo()) {
      try {
        const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.relayStatus, undefined, {
          ensureDaemon: false,
          timeoutMs: 1000,
        });
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
    const r = relay;
    console.log(`Remote access: ${creds.remoteEnabled ? "enabled" : "disabled"}`);
    console.log(`Relay: ${creds.relayUrl}`);
    console.log(`Connection: ${r.status ?? "unknown"}`);
    const lastError = relayLastError(r);
    if (lastError) console.log(`Last error: ${lastError}`);
  });

remoteCmd
  .command("enable")
  .description("Enable remote access and connect to the relay")
  .action(async () => {
    if (!loadCredentials()) {
      console.error("Not logged in. Run `aimux login` first.");
      process.exit(1);
    }
    const { result } = await requestCoreCommand(CORE_COMMAND_NAMES.relayEnable);
    const r = result.relay;
    console.log(`✓ Remote access enabled (connection: ${r.status ?? "unknown"})`);
  });

remoteCmd
  .command("disable")
  .description("Disable remote access and disconnect from the relay")
  .action(async () => {
    if (loadDaemonInfo()) {
      await requestCoreCommand(CORE_COMMAND_NAMES.relayDisable, undefined, { ensureDaemon: false, timeoutMs: 1000 });
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

worktreeCmd.action(async () => {
  const projectRoot = await prepareProjectContext();
  const result = await getLiveProjectServiceJson(projectRoot, "/worktrees");
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
    const summaries = await getProjectServiceJson(`/threads${query}`);
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
    const summaries = await getProjectServiceJson(`/threads${query}`);
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
    const detail = await getProjectServiceJson(`/threads/${encodeURIComponent(threadId)}`, { notFound: "null" });
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
  .option("--project <path>", "Project path")
  .action(async (sessionId: string, text: string[], opts: { project?: string }) => {
    const projectRoot = opts.project ? await prepareProjectContext(opts.project) : undefined;
    if (!projectRoot) await initPaths();
    const body = text.join(" ");
    if (!body.trim()) {
      console.error("aimux: input requires non-empty text");
      process.exit(1);
    }
    await postProjectServiceJson("/agents/input", { sessionId, text: body }, projectRoot ? { projectRoot } : undefined);
    console.log(`delivered to ${sessionId}`);
  });

program
  .command("ps")
  .description("Show all agents in this project (across worktrees) with activity and loop state")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (opts: { project?: string; json?: boolean }) => {
    const projectRoot = opts.project ? await prepareProjectContext(opts.project) : undefined;
    if (!projectRoot) await initPaths();
    const result = await getProjectServiceJson("/agents", projectRoot ? { projectRoot } : undefined);
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
  .option("--project <path>", "Project path")
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
        project?: string;
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
      const projectRoot = await prepareProjectContext(opts.project);
      const result = await postProjectServiceJson(
        "/threads/send",
        {
          threadId: opts.thread,
          from: opts.from ?? "user",
          to,
          assignee: opts.assignee,
          tool: opts.tool,
          worktreePath: opts.worktree,
          kind: (opts.kind as MessageKind) ?? "request",
          body,
          title: opts.title,
        },
        { projectRoot },
      );
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
  .option("--project <path>", "Project path")
  .option("--from <sessionId>", "Sender session id", "user")
  .option("--title <title>", "Handoff thread title")
  .option("--json", "Emit JSON")
  .action(
    async (
      body: string,
      opts: {
        to?: string;
        assignee?: string;
        tool?: string;
        worktree?: string;
        project?: string;
        from?: string;
        title?: string;
        json?: boolean;
      },
    ) => {
      const to = opts.to
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if ((!to || to.length === 0) && !opts.assignee && !opts.tool) {
        console.error("aimux: handoff send requires --to, --assignee, or --tool");
        process.exit(1);
      }
      const projectRoot = await prepareProjectContext(opts.project);
      const result = await postProjectServiceJson(
        "/handoff",
        {
          from: opts.from ?? "user",
          to,
          assignee: opts.assignee,
          tool: opts.tool,
          body,
          title: opts.title,
          worktreePath: opts.worktree,
        },
        { projectRoot },
      );
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
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
  .option("--project <path>", "Project path")
  .option("--from <sessionId>", "Accepting session id", "user")
  .option("--body <text>", "Optional acceptance note")
  .option("--json", "Emit JSON")
  .action(async (threadId: string, opts: { project?: string; from?: string; body?: string; json?: boolean }) => {
    const projectRoot = await prepareProjectContext(opts.project);
    const result = await postProjectServiceJson(
      "/handoff/accept",
      {
        threadId,
        from: opts.from ?? "user",
        body: opts.body,
      },
      { projectRoot },
    );
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`thread ${result.thread.id}`);
    console.log(`message ${result.message.id}`);
  });

handoffCmd
  .command("complete")
  .description("Complete an existing handoff thread")
  .argument("<threadId>")
  .option("--project <path>", "Project path")
  .option("--from <sessionId>", "Completing session id", "user")
  .option("--body <text>", "Optional completion note")
  .option("--json", "Emit JSON")
  .action(async (threadId: string, opts: { project?: string; from?: string; body?: string; json?: boolean }) => {
    const projectRoot = await prepareProjectContext(opts.project);
    const result = await postProjectServiceJson(
      "/handoff/complete",
      {
        threadId,
        from: opts.from ?? "user",
        body: opts.body,
      },
      { projectRoot },
    );
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`thread ${result.thread.id}`);
    console.log(`message ${result.message.id}`);
  });

const taskCmd = program.command("task").description("Create and manage orchestrated tasks");

taskCmd
  .command("list")
  .description("List orchestrated tasks")
  .option("--session <sessionId>", "Filter to tasks assigned to or created by a session")
  .option("--status <status>", "Filter by task status")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (opts: { session?: string; status?: string; project?: string; json?: boolean }) => {
    const params = new URLSearchParams();
    if (opts.session) params.set("session", opts.session);
    if (opts.status) params.set("status", opts.status);
    const query = params.toString();
    const projectRoot = await prepareProjectContext(opts.project);
    const result = await getProjectServiceJson(`/tasks${query ? `?${query}` : ""}`, { projectRoot });
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
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (taskId: string, opts: { project?: string; json?: boolean }) => {
    const projectRoot = await prepareProjectContext(opts.project);
    const detail = await getProjectServiceJson(`/tasks/${encodeURIComponent(taskId)}`, {
      notFound: "null",
      projectRoot,
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
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
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
        project?: string;
        json?: boolean;
      },
    ) => {
      const projectRoot = await prepareProjectContext(opts.project);
      const result = await postProjectServiceJson(
        "/tasks/assign",
        {
          from: opts.from ?? "user",
          to: opts.to,
          assignee: opts.assignee,
          tool: opts.tool,
          description,
          prompt: opts.prompt,
          type: opts.type,
          diff: opts.diff,
          worktreePath: opts.worktree,
        },
        { projectRoot },
      );
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`task ${result.task.id}`);
      if (result.thread?.id) console.log(`thread ${result.thread.id}`);
    },
  );

taskCmd
  .command("accept")
  .description("Accept an assigned task and mark it in progress")
  .argument("<taskId>")
  .option("--project <path>", "Project path")
  .option("--from <sessionId>", "Accepting session id", "user")
  .option("--body <text>", "Optional acceptance note")
  .option("--json", "Emit JSON")
  .action(async (taskId: string, opts: { project?: string; from?: string; body?: string; json?: boolean }) => {
    const projectRoot = await prepareProjectContext(opts.project);
    const result = await postProjectServiceJson(
      "/tasks/accept",
      {
        taskId,
        from: opts.from ?? "user",
        body: opts.body,
      },
      { projectRoot },
    );
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`task ${result.task.id}`);
    if (result.thread?.id) console.log(`thread ${result.thread.id}`);
  });

taskCmd
  .command("block")
  .description("Mark a task blocked and route it back for attention")
  .argument("<taskId>")
  .option("--project <path>", "Project path")
  .option("--from <sessionId>", "Blocking session id", "user")
  .option("--body <text>", "Blocking reason")
  .option("--json", "Emit JSON")
  .action(async (taskId: string, opts: { project?: string; from?: string; body?: string; json?: boolean }) => {
    const projectRoot = await prepareProjectContext(opts.project);
    const result = await postProjectServiceJson(
      "/tasks/block",
      {
        taskId,
        from: opts.from ?? "user",
        body: opts.body,
      },
      { projectRoot },
    );
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`task ${result.task.id}`);
    if (result.thread?.id) console.log(`thread ${result.thread.id}`);
  });

taskCmd
  .command("complete")
  .description("Complete a task explicitly and publish the result")
  .argument("<taskId>")
  .option("--project <path>", "Project path")
  .option("--from <sessionId>", "Completing session id", "user")
  .option("--body <text>", "Completion summary/result")
  .option("--json", "Emit JSON")
  .action(async (taskId: string, opts: { project?: string; from?: string; body?: string; json?: boolean }) => {
    const projectRoot = await prepareProjectContext(opts.project);
    const result = await postProjectServiceJson(
      "/tasks/complete",
      {
        taskId,
        from: opts.from ?? "user",
        body: opts.body,
      },
      { projectRoot },
    );
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`task ${result.task.id}`);
    if (result.thread?.id) console.log(`thread ${result.thread.id}`);
  });

taskCmd
  .command("reopen")
  .description("Reopen a completed or blocked task chain")
  .argument("<taskId>")
  .option("--project <path>", "Project path")
  .option("--from <sessionId>", "Reopening session id", "user")
  .option("--body <text>", "Optional reopening note")
  .option("--json", "Emit JSON")
  .action(async (taskId: string, opts: { project?: string; from?: string; body?: string; json?: boolean }) => {
    const projectRoot = await prepareProjectContext(opts.project);
    const result = await postProjectServiceJson(
      "/tasks/reopen",
      {
        taskId,
        from: opts.from ?? "user",
        body: opts.body,
      },
      { projectRoot },
    );
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`task ${result.task.id}`);
    if (result.thread?.id) console.log(`thread ${result.thread.id}`);
  });

const reviewCmd = program.command("review").description("Manage review workflow tasks");

reviewCmd
  .command("approve")
  .description("Approve a review task")
  .argument("<taskId>")
  .option("--project <path>", "Project path")
  .option("--from <sessionId>", "Reviewer session id", "user")
  .option("--body <text>", "Optional approval note")
  .option("--json", "Emit JSON")
  .action(async (taskId: string, opts: { project?: string; from?: string; body?: string; json?: boolean }) => {
    const projectRoot = await prepareProjectContext(opts.project);
    const result = await postProjectServiceJson(
      "/reviews/approve",
      {
        taskId,
        from: opts.from ?? "user",
        body: opts.body,
      },
      { projectRoot },
    );
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`task ${result.task.id}`);
    if (result.thread?.id) console.log(`thread ${result.thread.id}`);
  });

reviewCmd
  .command("request-changes")
  .description("Request changes on a review task")
  .argument("<taskId>")
  .option("--project <path>", "Project path")
  .option("--from <sessionId>", "Reviewer session id", "user")
  .option("--body <text>", "Requested changes")
  .option("--json", "Emit JSON")
  .action(async (taskId: string, opts: { project?: string; from?: string; body?: string; json?: boolean }) => {
    const projectRoot = await prepareProjectContext(opts.project);
    const result = await postProjectServiceJson(
      "/reviews/request-changes",
      {
        taskId,
        from: opts.from ?? "user",
        body: opts.body,
      },
      { projectRoot },
    );
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
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
    const result = await getLiveProjectServiceJson(projectRoot, "/worktrees");
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
      await ensureDaemonProjectReady(projectRoot);
      const result = await postLiveProjectServiceJson(projectRoot, "/worktrees/create", { name });
      const createdPath = result.path;
      const status = result.status === "creating" ? "creating" : "created";
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              name,
              path: createdPath,
              status,
              projectRoot,
            },
            null,
            2,
          ),
        );
        return;
      }
      if (status === "creating") {
        console.log(`Creating worktree "${name}"${createdPath ? ` (${createdPath})` : ""}.`);
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
      await ensureDaemonProjectReady(projectRoot);
      const result = await postLiveProjectServiceJson(projectRoot, "/worktrees/remove", { path: resolvedPath });
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
      await ensureDaemonProjectReady(projectRoot);
      const result = await postLiveProjectServiceJson(projectRoot, "/worktrees/graveyard", { path: resolvedPath });
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
      await ensureDaemonProjectReady(projectRoot);
      const result = await postLiveProjectServiceJson(projectRoot, "/graveyard/worktrees/resurrect", {
        path: resolvedPath,
      });
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
      await ensureDaemonProjectReady(projectRoot);
      const result = await postLiveProjectServiceJson(projectRoot, "/graveyard/worktrees/delete", {
        path: resolvedPath,
      });
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
      const targetWorktreePath = opts.worktree ? pathResolve(opts.worktree) : undefined;
      const result = await postLiveProjectServiceJson(projectRoot, "/agents/spawn", {
        tool: opts.tool,
        worktreePath: targetWorktreePath,
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
      initProject();
      const tool = opts.tool ?? loadConfig().defaultTool;
      const targetWorktreePath = opts.worktree ? pathResolve(opts.worktree) : undefined;
      const result = await postLiveProjectServiceJson(projectRoot, "/agents/spawn", {
        tool,
        worktreePath: targetWorktreePath,
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
        const targetWorktreePath = opts.worktree ? pathResolve(opts.worktree) : undefined;
        const result = await postLiveProjectServiceJson(projectRoot, "/agents/fork", {
          sourceSessionId,
          tool: opts.tool,
          instruction: opts.instruction,
          worktreePath: targetWorktreePath,
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
    const graveyard = await getLiveProjectServiceJson(projectRoot, "/graveyard");
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
      const result = await postLiveProjectServiceJson(projectRoot, "/agents/kill", { sessionId: id });
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
      const result = await postLiveProjectServiceJson(projectRoot, "/graveyard/resurrect", { sessionId: id });
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
      await ensureDaemonProjectReady(projectRoot);
      const result = await postLiveProjectServiceJson(projectRoot, "/graveyard/cleanup", {
        dryRun: opts.dryRun === true,
      });
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
      const result = await postLiveProjectServiceJson(projectRoot, "/agents/rename", {
        sessionId,
        label: opts.label,
      });
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
  .command("kill <sessionId>")
  .description("Send an agent to the graveyard from running or offline state")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (sessionId: string, opts: { project?: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReady(projectRoot);
      const result = await postLiveProjectServiceJson(projectRoot, "/agents/kill", { sessionId });
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
      const targetWorktreePath = pathResolve(opts.worktree);
      const result = await postLiveProjectServiceJson(projectRoot, "/agents/migrate", {
        sessionId,
        worktreePath: targetWorktreePath,
      });
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              projectRoot,
              sessionId: result.sessionId,
              worktreePath: result.worktreePath ?? targetWorktreePath,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`migrated ${result.sessionId} -> ${result.worktreePath ?? targetWorktreePath}`);
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
    clearLogFile(path);
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
    const projectRoot = resolveProjectRoot(opts.projectRoot);
    await initPaths(projectRoot);
    const tmux = new TmuxRuntimeManager();
    const report = buildTmuxDoctorReport(tmux, {
      projectRoot,
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

async function postRuntimeMetadata(path: string, body: unknown): Promise<void> {
  await postProjectServiceJson(path, body);
}

metadataCmd
  .command("endpoint")
  .description("Print the local metadata API endpoint")
  .action(async () => {
    const endpoint = await getProjectServiceEndpoint();
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
      await postRuntimeMetadata(PROJECT_API_ROUTES.runtime.event, {
        session,
        event: {
          kind,
          message: opts.message,
          source: opts.source,
          tone: opts.tone,
          threadId: opts.threadId,
          threadName: opts.threadName,
        },
      });
    },
  );

metadataCmd
  .command("mark-seen <session>")
  .description("Mark a session's unseen activity as seen")
  .action(async (session: string) => {
    await postRuntimeMetadata(PROJECT_API_ROUTES.runtime.markSeen, { session });
  });

metadataCmd
  .command("set-activity <session> <activity>")
  .description("Set derived activity state for a session")
  .action(async (session: string, activity: AgentActivityState) => {
    await postRuntimeMetadata(PROJECT_API_ROUTES.runtime.setActivity, { session, activity });
  });

metadataCmd
  .command("set-attention <session> <attention>")
  .description("Set derived attention state for a session")
  .action(async (session: string, attention: AgentAttentionState) => {
    await postRuntimeMetadata(PROJECT_API_ROUTES.runtime.setAttention, { session, attention });
  });

program
  .command("notify")
  .description("Send a project notification")
  .requiredOption("--title <title>", "Notification title")
  .option("--subtitle <subtitle>", "Notification subtitle")
  .option("--body <body>", "Notification body")
  .option("--session <sessionId>", "Related session id")
  .option("--kind <kind>", "Notification kind", "notification")
  .option("--project <path>", "Project root")
  .option("--json", "Emit JSON output")
  .action(
    async (opts: {
      title: string;
      subtitle?: string;
      body?: string;
      session?: string;
      kind?: string;
      project?: string;
      json?: boolean;
    }) => {
      const projectRoot = opts.project ? resolveProjectRoot(opts.project) : undefined;
      await initPaths(projectRoot);
      const title = opts.title.trim();
      const body = opts.body?.trim() || title;
      const projectOptions = projectRoot ? { projectRoot } : undefined;
      const result = await postProjectServiceJson(
        "/notify",
        {
          title,
          subtitle: opts.subtitle?.trim() || undefined,
          message: body,
          sessionId: opts.session?.trim() || undefined,
          kind: opts.kind?.trim() || "notification",
          force: true,
        },
        projectOptions,
      );
      if (opts.json) {
        console.log(JSON.stringify(result));
        return;
      }
      console.log(`Queued notification "${title}".`);
    },
  );

program
  .command("list-notifications")
  .description("List project notifications")
  .option("--unread", "Show only unread notifications")
  .option("--session <sessionId>", "Filter by session id")
  .option("--project <path>", "Project root")
  .option("--json", "Emit JSON output")
  .action(async (opts: { unread?: boolean; session?: string; project?: string; json?: boolean }) => {
    const projectRoot = opts.project ? resolveProjectRoot(opts.project) : undefined;
    await initPaths(projectRoot);
    const result = await getProjectServiceJson(
      `/notifications${notificationQuery(opts)}`,
      projectRoot ? { projectRoot } : undefined,
    );
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
  .option("--id <notificationId>", "Clear one notification")
  .option("--ids <notificationIds>", "Comma-separated notification ids")
  .option("--session <sessionId>", "Clear only notifications for a session")
  .option("--project <path>", "Project root")
  .option("--json", "Emit JSON output")
  .action(async (opts: { id?: string; ids?: string; session?: string; project?: string; json?: boolean }) => {
    const projectRoot = opts.project ? resolveProjectRoot(opts.project) : undefined;
    await initPaths(projectRoot);
    const result = await postProjectServiceJson(
      "/notifications/clear",
      notificationMutationInput(opts),
      projectRoot ? { projectRoot } : undefined,
    );
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
  .option("--id <notificationId>", "Mark one notification as read")
  .option("--ids <notificationIds>", "Comma-separated notification ids")
  .option("--session <sessionId>", "Mark only notifications for a session as read")
  .option("--project <path>", "Project root")
  .option("--json", "Emit JSON output")
  .action(async (opts: { id?: string; ids?: string; session?: string; project?: string; json?: boolean }) => {
    const projectRoot = opts.project ? resolveProjectRoot(opts.project) : undefined;
    await initPaths(projectRoot);
    const result = await postProjectServiceJson(
      "/notifications/read",
      notificationMutationInput(opts),
      projectRoot ? { projectRoot } : undefined,
    );
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
    await postRuntimeMetadata(PROJECT_API_ROUTES.runtime.setStatus, { session, text, tone: opts.tone });
  });

metadataCmd
  .command("set-progress <session> <current> <total>")
  .option("--label <label>", "Progress label")
  .description("Set per-session progress")
  .action(async (session: string, current: string, total: string, opts: { label?: string }) => {
    const currentNum = Number(current);
    const totalNum = Number(total);
    if (!Number.isFinite(currentNum) || !Number.isFinite(totalNum)) {
      console.error("metadata set-progress requires numeric <current> and <total>");
      process.exitCode = 1;
      return;
    }
    await postRuntimeMetadata(PROJECT_API_ROUTES.runtime.setProgress, {
      session,
      current: currentNum,
      total: totalNum,
      label: opts.label,
    });
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
      const context: SessionContextMetadata = {
        cwd: opts.cwd,
        worktreePath: opts.worktreePath,
        worktreeName: opts.worktreeName,
        branch: opts.branch,
      };
      if (opts.prNumber || opts.prTitle || opts.prUrl) {
        context.pr = {
          number: opts.prNumber ? Number(opts.prNumber) : undefined,
          title: opts.prTitle,
          url: opts.prUrl,
        };
      }
      await postRuntimeMetadata(PROJECT_API_ROUTES.runtime.setContext, { session, context });
    },
  );

metadataCmd
  .command("set-services <session>")
  .requiredOption("--url <url...>", "One or more service URLs")
  .option("--label <label>", "Shared label for the services")
  .description("Set detected session services/ports")
  .action(async (session: string, opts: { url: string[]; label?: string }) => {
    const services: SessionServiceMetadata[] = (opts.url ?? []).map((url) => {
      const match = url.match(/:(\d+)(?:\/|$)/);
      return {
        label: opts.label,
        url,
        port: match ? Number(match[1]) : undefined,
      };
    });
    await postRuntimeMetadata(PROJECT_API_ROUTES.runtime.setServices, { session, services });
  });

metadataCmd
  .command("log <session> <message>")
  .option("--source <source>", "Log source")
  .option("--tone <tone>", "Log tone")
  .description("Append a session log line")
  .action(async (session: string, message: string, opts: { source?: string; tone?: MetadataTone }) => {
    await postRuntimeMetadata(PROJECT_API_ROUTES.runtime.log, {
      session,
      message,
      source: opts.source,
      tone: opts.tone,
    });
  });

metadataCmd
  .command("clear-log <session>")
  .description("Clear session logs")
  .action(async (session: string) => {
    await postRuntimeMetadata(PROJECT_API_ROUTES.runtime.clearLog, { session });
  });

// ── Team commands ──────────────────────────────────────────────────

const teamCmd = program.command("team").description("Manage agent team roles");

interface TeamCommandOptions {
  project?: string;
  json?: boolean;
}

function buildTeamCliPayload(projectRoot: string, config: TeamConfig, role?: string) {
  return {
    ok: true,
    projectRoot,
    config,
    ...(role ? { role } : {}),
  };
}

function printTeamShow(config: TeamConfig): void {
  console.log("Team Roles:");
  for (const [name, role] of Object.entries(config.roles)) {
    const flags: string[] = [];
    if (role.reviewedBy) flags.push(`reviewed by: ${role.reviewedBy}`);
    if (role.canEdit) flags.push("can edit");
    const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
    console.log(`  ${name}: ${role.description}${flagStr}`);
  }
  console.log(`\nDefault role: ${config.defaultRole}`);
}

function printTeamInit(config: TeamConfig): void {
  console.log("Team config initialized with default roles:");
  for (const [name, role] of Object.entries(config.roles)) {
    console.log(`  ${name}: ${role.description}`);
  }
}

teamCmd
  .command("show")
  .description("Show current team config")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (options: TeamCommandOptions) => {
    const projectRoot = await prepareProjectContext(options.project);
    const result = await getProjectServiceJson(PROJECT_API_ROUTES.team.config, { projectRoot });
    if (options.json) {
      console.log(JSON.stringify(buildTeamCliPayload(projectRoot, result.config), null, 2));
      return;
    }
    printTeamShow(result.config);
  });

teamCmd
  .command("add <role>")
  .description("Add or update a role")
  .option("-d, --description <desc>", "Role description")
  .option("--reviewed-by <role>", "Role that reviews this role's work")
  .option("--can-edit", "Whether this role can edit code directly")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(
    async (
      role: string,
      options: TeamCommandOptions & { description?: string; reviewedBy?: string; canEdit?: boolean },
    ) => {
      const projectRoot = await prepareProjectContext(options.project);
      const result = await postProjectServiceJson(
        PROJECT_API_ROUTES.team.addRole,
        {
          role,
          ...(options.description ? { description: options.description } : {}),
          ...(options.reviewedBy ? { reviewedBy: options.reviewedBy } : {}),
          ...(options.canEdit ? { canEdit: true } : {}),
        },
        { projectRoot },
      );
      if (options.json) {
        console.log(JSON.stringify(buildTeamCliPayload(projectRoot, result.config, role), null, 2));
        return;
      }
      console.log(`Role "${role}" saved.`);
    },
  );

teamCmd
  .command("remove <role>")
  .description("Remove a role")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (role: string, options: TeamCommandOptions) => {
    const projectRoot = await prepareProjectContext(options.project);
    const result = await postProjectServiceJson(PROJECT_API_ROUTES.team.removeRole, { role }, { projectRoot });
    if (options.json) {
      console.log(JSON.stringify(buildTeamCliPayload(projectRoot, result.config, role), null, 2));
      return;
    }
    console.log(`Role "${role}" removed.`);
  });

teamCmd
  .command("default <role>")
  .description("Set the default role for new agents")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (role: string, options: TeamCommandOptions) => {
    const projectRoot = await prepareProjectContext(options.project);
    const result = await postProjectServiceJson(PROJECT_API_ROUTES.team.defaultRole, { role }, { projectRoot });
    if (options.json) {
      console.log(JSON.stringify(buildTeamCliPayload(projectRoot, result.config, role), null, 2));
      return;
    }
    console.log(`Default role set to "${role}".`);
  });

teamCmd
  .command("init")
  .description("Initialize project with default team structure")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (options: TeamCommandOptions) => {
    const projectRoot = await prepareProjectContext(options.project);
    const result = await postProjectServiceJson(PROJECT_API_ROUTES.team.init, {}, { projectRoot });
    if (options.json) {
      console.log(JSON.stringify(buildTeamCliPayload(projectRoot, result.config), null, 2));
      return;
    }
    printTeamInit(result.config);
  });

registerExposeCommand(program);

void program.parseAsync().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
