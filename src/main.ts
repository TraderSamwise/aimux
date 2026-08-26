import { Command } from "commander";
import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, resolve as pathResolve } from "node:path";
import { createInterface } from "node:readline/promises";
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
import {
  PROJECT_API_ROUTES,
  type AgentListItem,
  type AgentLoopInput,
  type TeamConfig,
} from "./project-api-contract.js";
import { assertPublishableSource } from "./attachment-store.js";
import { AIMUX_VERSION } from "./version.js";
import { findMainRepo, listWorktrees, type WorktreeInfo } from "./worktree.js";
import { renderWorktreeCacheCleanupRunResult, type WorktreeCacheCleanupRunResult } from "./worktree-cache-cleanup.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import {
  buildTmuxDoctorReport,
  renderTmuxDoctorReport,
  renderTmuxRepairResult,
  repairTmuxRuntime,
} from "./tmux/doctor.js";
import {
  DEFAULT_INSTALL_KEEP_RECENT,
  DEFAULT_INSTALL_RETENTION_DAYS,
  planInstallCleanup,
  runInstallCleanup,
} from "./install-cleanup.js";
import { isInstallCleanupDryRun, renderInstallCleanupResult } from "./install-doctor.js";
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
import { ensureDaemonRunning, isStaleAgainstDaemon, stopDaemon } from "./daemon-supervisor.js";
import { requestCoreCommand } from "./core-command-client.js";
import {
  CORE_API_ROUTES,
  CORE_COMMAND_NAMES,
  type CoreProjectServiceState,
  type CoreRelaySnapshot,
  type CoreStatusProject,
} from "./core-command-contract.js";
import { renderDiskDoctorReport, type DiskDoctorReport } from "./disk-doctor.js";
import { getProjectServiceManifest, manifestsMatch, type ProjectServiceManifest } from "./project-service-manifest.js";
import { type MessageKind, type ThreadKind, type ThreadStatus } from "./threads.js";
import { runLoginFlow } from "./login-flow.js";
import { clearCredentials, loadCredentials, setRemoteEnabled } from "./credentials.js";
import { listRegisteredDesktopProjects } from "./project-scanner.js";
import { tailHostedAudit, tailHostedPrompts } from "./hosted-audit.js";
import { loadHostedConfig, validateHostedStartup } from "./hosted-config.js";
import { hostedLockdownState, setHostedLockdown } from "./hosted-lockdown.js";
import { raiseHostedCliEvent } from "./hosted-outbox.js";
import {
  approveRemoteSecurityDevice,
  blockRemoteSecurityDevice,
  listLivePendingRemoteSecurityDevices,
  listRemoteSecurityDevices,
  type RemoteSecurityDevice,
  unblockRemoteSecurityDevice,
} from "./security-devices-client.js";
import {
  createHostedPrincipal,
  grantHostedSession,
  listHostedPrincipals,
  revokeHostedPrincipal,
  ungrantHostedSession,
} from "./hosted-principals.js";
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
import {
  configureLogging,
  log,
  logLifecycleAlways,
  resolveLoggingRuntimeConfig,
  type LoggingCliOptions,
} from "./debug.js";
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
import { isRuntimeRestartInProgress } from "./runtime-restart.js";
import { isAimuxBuildDriftError } from "./runtime-drift.js";
import { registerExposeCommand } from "./popup-expose.js";
import { MAX_AGENT_OUTPUT_CAPTURE_LINES } from "./agent-output-bounds.js";
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
const CONCURRENT_RUNTIME_RESTART_WAIT_MS = 60_000;

function isRuntimeRestartAlreadyRunningError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("aimux restart is already running");
}

async function waitForConcurrentRuntimeRestart(projectRoot: string): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + CONCURRENT_RUNTIME_RESTART_WAIT_MS;
  let lastError = "aimux restart is already running";
  log.warn("waiting for concurrent aimux restart", "runtime", { projectRoot });

  while (Date.now() < deadline) {
    if (isRuntimeRestartInProgress()) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    try {
      await waitForVerifiedProjectService(projectRoot, { timeoutMs: 4000, repair: false });
      log.info("concurrent aimux restart settled", "runtime", {
        projectRoot,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    } catch (error) {
      if (error instanceof ProjectServiceVersionError || isAimuxBuildDriftError(error)) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      if (!isRepairableCoreProjectStartupError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(
    `aimux restart is already running and project service did not settle after ${CONCURRENT_RUNTIME_RESTART_WAIT_MS}ms; last error: ${lastError}`,
  );
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
  let result;
  try {
    result = (await restartControlPlaneFromCli(projectRoot)).restart;
  } catch (error) {
    if (!isRuntimeRestartAlreadyRunningError(error)) throw error;
    await waitForConcurrentRuntimeRestart(projectRoot);
    return;
  }
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
  opts?: { timeoutMs?: number; repair?: boolean },
): Promise<{
  endpoint: { host: string; port: number; pid: number };
  health: { serviceInfo?: ProjectServiceManifest; pid?: number; projectStateDir?: string };
}> {
  const expected = getProjectServiceManifest();
  const expectedProjectStateDir = getProjectStateDirFor(projectRoot);
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const repair = opts?.repair ?? true;
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
          if (repair && !respawnAttempted) {
            respawnAttempted = true;
            await restartCoreProjectServiceForReadiness(projectRoot);
          }
          // Second time round, wait the loop out instead of deleting the endpoint.
          // This process failing to verify is not a reason to break the readers that
          // are working fine off the same file.
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
          if (repair && !respawnAttempted) {
            respawnAttempted = true;
            await restartCoreProjectServiceForReadiness(projectRoot);
          }
          // Second time round, wait the loop out instead of deleting the endpoint.
          // This process failing to verify is not a reason to break the readers that
          // are working fine off the same file.
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
        // A service built after this process is not broken — this process is the old
        // one. Respawning it here would replace a newer service with an older build
        // and never converge, so stop now and say which side is stale.
        if (isStaleAgainstDaemon(health.serviceInfo?.buildStamp, expected.buildStamp)) {
          throw new ProjectServiceVersionError(
            `this aimux build is older than the running project service for ${projectRoot}; reload this client`,
            projectRoot,
            expected,
            health.serviceInfo as ProjectServiceManifest,
          );
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (
          repair &&
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
          // Respawn, but leave the endpoint file alone. Deleting it to force a
          // rewrite breaks every other reader — Exposé loads items through it and
          // throws synchronously when it is missing, which reads as the popup being
          // dismissed by a keypress nobody pressed. A refused connection is usually
          // a service mid-restart, and the service republishes when it comes back.
          await ensureCoreProjectServiceForReadiness(projectRoot);
        }
      }
    } else {
      lastError = "no live project service metadata endpoint";
      if (!missingEndpointSince) {
        missingEndpointSince = Date.now();
      } else if (repair && !respawnAttempted && Date.now() - missingEndpointSince >= 1000) {
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

async function getDaemonTextJson(path: string, params: Record<string, string | undefined> = {}): Promise<unknown> {
  const info = await ensureDaemonRunning();
  const query = new URLSearchParams({ json: "1" });
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const { status, json } = await requestJson(`http://${getDaemonHost()}:${info.port}${path}?${query.toString()}`, {
    timeoutMs: 120_000,
  });
  if (status < 200 || status >= 300) {
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

function loggingProcessKind(command: Command): "cli" | "daemon" | "project-service" {
  const names = commandPath(command);
  if (names.at(-2) === "daemon" && names.at(-1) === "run") return "daemon";
  // Without this the service logs as "cli" into the project log, which is exactly
  // the distinction you need when debugging why a service died.
  if (names.at(-1) === "__project-service-internal") return "project-service";
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

function parseStrictInteger(value: string): number | undefined {
  if (!/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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

async function repairCoreProjectServiceForCli(projectRoot: string): Promise<CoreProjectServiceState> {
  try {
    const project = await restartCoreProjectServiceForReadiness(projectRoot);
    await waitForVerifiedProjectService(projectRoot);
    return project;
  } catch (error) {
    if (!isRepairableCoreProjectStartupError(error)) {
      throw error;
    }
    await restartStaleControlPlane(projectRoot);
    return await ensureCoreProjectServiceForCli(projectRoot);
  }
}

async function ensureCoreProjectServiceForCliWithRepair(projectRoot: string): Promise<CoreProjectServiceState> {
  try {
    return await ensureCoreProjectServiceForCli(projectRoot);
  } catch (error) {
    if (!isRepairableCoreProjectStartupError(error)) {
      throw error;
    }
    return await repairCoreProjectServiceForCli(projectRoot);
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
      if (!opts.tmuxDashboardInternal) {
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

      const mux = new Multiplexer({
        contextWatcherEnabled: !opts.tmuxDashboardInternal,
        dashboardCoreCommandRequest: opts.tmuxDashboardInternal ? requestCoreCommand : undefined,
      });
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
  .option("--project <path>", "Project path")
  .option("--start-line <number>", "tmux capture-pane start line", "-120")
  .option("--lines <number>", "Number of tail lines to read")
  .action(async (sessionId: string, opts: { project?: string; startLine?: string; lines?: string }) => {
    await initPaths();
    const projectRoot = opts.project
      ? resolveProjectRoot(pathResolve(opts.project))
      : resolveProjectRoot(process.cwd());
    const lines = opts.lines === undefined ? undefined : parseStrictInteger(opts.lines);
    if (lines !== undefined && lines <= 0) {
      throw new Error("--lines must be a positive integer");
    }
    const startLine = lines === undefined ? parseStrictInteger(opts.startLine ?? "-120") : -lines;
    if (startLine === undefined) {
      throw new Error("--start-line must be an integer");
    }
    const result = await getProjectServiceJson(
      `/agents/output?sessionId=${encodeURIComponent(sessionId)}&startLine=${encodeURIComponent(String(startLine))}`,
      { projectRoot },
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
  .option("--project <path>", "Project path")
  .option("--start-line <number>", "tmux capture-pane start line", String(-MAX_AGENT_OUTPUT_CAPTURE_LINES))
  .option("--lines <number>", "Number of tail lines to stream")
  .option("--interval-ms <number>", "Polling interval in milliseconds", "500")
  .action(
    async (sessionId: string, opts: { project?: string; startLine?: string; lines?: string; intervalMs?: string }) => {
      await initPaths();
      const projectRoot = opts.project
        ? resolveProjectRoot(pathResolve(opts.project))
        : resolveProjectRoot(process.cwd());
      const lines = opts.lines === undefined ? undefined : parseStrictInteger(opts.lines);
      if (lines !== undefined && lines <= 0) {
        throw new Error("--lines must be a positive integer");
      }
      const startLine =
        lines === undefined ? parseStrictInteger(opts.startLine ?? String(-MAX_AGENT_OUTPUT_CAPTURE_LINES)) : -lines;
      const intervalMs = parseStrictInteger(opts.intervalMs ?? "500");
      if (startLine === undefined) {
        throw new Error("--start-line must be an integer");
      }
      if (intervalMs === undefined || intervalMs < 100) {
        throw new Error("--interval-ms must be an integer >= 100");
      }

      const endpoint = await getProjectServiceEndpoint(projectRoot);
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
    },
  );

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
    let shuttingDown = false;
    const shutdown = (exitCode: number, trigger: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Always written: a daemon that stops without saying why is the whole
      // reason this restart loop has been diagnosed wrong three times. The pair
      // "stopping" then "started" reads as spontaneous unless the stop names its
      // trigger, and a signal carries no sender, so ppid is the next best clue.
      logLifecycleAlways("daemon stopping", "daemon", {
        trigger,
        exitCode,
        pid: process.pid,
        ppid: process.ppid,
        uptimeMs: Math.round(process.uptime() * 1000),
      });
      void daemon.stop().finally(() => process.exit(exitCode));
    };
    process.on("SIGINT", () => shutdown(130, "SIGINT"));
    process.on("SIGTERM", () => shutdown(143, "SIGTERM"));
    process.on("disconnect", () => shutdown(0, "parent-disconnect"));
    process.on("beforeExit", (code) => {
      // Not a signal: the event loop simply emptied. A daemon should never reach
      // this, so if it does the log has to say so rather than look like a signal.
      logLifecycleAlways("daemon event loop drained", "daemon", { code, pid: process.pid });
    });
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
const hostedCmd = program.command("hosted").description("Manage hosted mode: principals, grants, audit, lockdown");

/**
 * The project root a grant must be stored under.
 *
 * NOT a bare resolve of `--project`. The daemon checks grants against the
 * registry's repo root, which is normalized (a subdirectory or a worktree
 * resolves to the main repo). Storing the raw argument would produce a grant
 * the daemon never matches, and every request would 403 with nothing to show
 * why. The global preAction hook has already initPaths'd `--project`, so this
 * is exactly the value the registry holds.
 */
function hostedGrantProjectRoot(): string {
  const root = getRepoRoot();
  // Checked against the SAME list the daemon resolves ports through, not the
  // raw registry: the preAction hook has already registered whatever was
  // passed, so a registry lookup would always succeed — including for a typo'd
  // or temporary path the daemon filters out and could therefore never match.
  if (!listRegisteredDesktopProjects().some((project) => project.path === root)) {
    console.error(
      `Project ${root} is not one the daemon can resolve, so a grant on it could never match.\n` +
        `Open it in aimux once, and check it is a real repository outside a temporary directory.`,
    );
    process.exit(1);
  }
  return root;
}

hostedCmd
  .command("status")
  .description("Show hosted mode configuration and principals")
  .option("--json", "Emit JSON")
  .action((opts: { json?: boolean }) => {
    const config = loadHostedConfig();
    const principals = listHostedPrincipals();
    const active = principals.filter((principal) => !principal.revokedAt);
    // Surfaced here because a refused start is otherwise only visible in the
    // daemon log, and "enabled: true" alone would be misleading.
    const validation = validateHostedStartup(config, active.length);
    const lockdown = hostedLockdownState();

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            enabled: config.enabled,
            bindAddress: config.bindAddress,
            port: config.port,
            webhookConfigured: Boolean(config.webhookUrl),
            trustedForwardedHeader: config.trustedForwardedHeader,
            retentionDays: config.retentionDays,
            principals: { total: principals.length, active: active.length },
            lockdown,
            startup: validation,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(`Hosted mode: ${config.enabled ? "enabled" : "disabled"}`);
    console.log(`Listener:    ${config.bindAddress}:${config.port}`);
    console.log(`Principals:  ${active.length} active, ${principals.length} total`);
    console.log(`Webhook:     ${config.webhookUrl ? `configured (${config.webhookSecretEnv})` : "not configured"}`);
    console.log(`Lockdown:    ${lockdown.active ? `ON since ${lockdown.since ?? "unknown"}` : "off"}`);
    if (!validation.ok) console.log(`\nWill not start: ${validation.error}`);
  });

const hostedTokenCmd = hostedCmd.command("token").description("Manage hosted bearer tokens");

hostedTokenCmd
  .command("create")
  .description("Create a principal and print its token once")
  .requiredOption("--label <label>", "Who this token is for (an opaque identifier, shown in audit records)")
  .action((opts: { label: string }) => {
    const { principal, token } = createHostedPrincipal({ label: opts.label });
    // Printed once, to stdout only. Nothing stores the plaintext, so a lost
    // token is replaced rather than recovered.
    console.log(`\nPrincipal: ${principal.id}  (${principal.label})`);
    console.log(`Token:     ${token}`);
    console.log(`\nStore it now — only its hash is kept, so it cannot be shown again.`);
    console.log(`Grant it a session with:\n  aimux hosted grant ${principal.id} --project <root> --session <id>\n`);
  });

hostedTokenCmd
  .command("list")
  .description("List principals")
  .option("--json", "Emit JSON")
  .action((opts: { json?: boolean }) => {
    const principals = listHostedPrincipals();
    if (opts.json) {
      console.log(JSON.stringify(principals, null, 2));
      return;
    }
    if (principals.length === 0) {
      console.log("No principals. Create one with: aimux hosted token create --label <label>");
      return;
    }
    for (const principal of principals) {
      const state = principal.revokedAt ? `revoked ${principal.revokedAt}` : "active";
      console.log(`${principal.id}  ${principal.label}  [${state}]`);
      for (const grant of principal.grants) console.log(`    ${grant.sessionId}  ${grant.projectRoot}`);
      if (principal.grants.length === 0) console.log("    (no grants)");
    }
  });

hostedTokenCmd
  .command("revoke <principalId>")
  .description("Revoke a principal's token")
  .action((principalId: string) => {
    if (!revokeHostedPrincipal(principalId)) {
      console.error(`No active principal ${principalId}`);
      process.exit(1);
    }
    raiseHostedCliEvent("hosted_token_revoked", principalId, `revoked via CLI`);
    console.log(`Revoked ${principalId}`);
  });

hostedCmd
  .command("grant <principalId>")
  .description("Allow a principal to converse with one session")
  .requiredOption("--project <root>", "Project root the session belongs to")
  .requiredOption("--session <id>", "Session id")
  .action((principalId: string, opts: { project: string; session: string }) => {
    const projectRoot = hostedGrantProjectRoot();
    if (!grantHostedSession(principalId, { projectRoot, sessionId: opts.session })) {
      console.error(`Could not grant — no active principal ${principalId}, or an invalid project/session`);
      process.exit(1);
    }
    raiseHostedCliEvent("hosted_grant_changed", principalId, `granted ${opts.session}`);
    console.log(`Granted ${principalId} -> ${opts.session} in ${projectRoot}`);
  });

hostedCmd
  .command("ungrant <principalId>")
  .description("Remove a principal's access to one session")
  .requiredOption("--project <root>", "Project root the session belongs to")
  .requiredOption("--session <id>", "Session id")
  .action((principalId: string, opts: { project: string; session: string }) => {
    const projectRoot = hostedGrantProjectRoot();
    if (!ungrantHostedSession(principalId, { projectRoot, sessionId: opts.session })) {
      console.error(`No such grant on ${principalId}`);
      process.exit(1);
    }
    raiseHostedCliEvent("hosted_grant_changed", principalId, `ungranted ${opts.session}`);
    console.log(`Removed ${opts.session} from ${principalId}`);
  });

hostedCmd
  .command("lockdown <state>")
  .description('Close or reopen the hosted listener ("on" or "off")')
  .action((state: string) => {
    if (state !== "on" && state !== "off") {
      console.error("Usage: aimux hosted lockdown on|off");
      process.exit(1);
    }
    const result = setHostedLockdown(state === "on");
    raiseHostedCliEvent("hosted_lockdown", null, state === "on" ? "engaged" : "cleared");
    console.log(result.active ? `Hosted mode locked down at ${result.since}` : "Hosted lockdown cleared");
  });

const hostedAuditCmd = hostedCmd.command("audit").description("Inspect the hosted audit log");

hostedAuditCmd
  .command("tail")
  .description("Show the most recent audit records")
  .option("-n, --lines <count>", "How many records", "20")
  .option("--json", "Emit JSON")
  .option("--prompts", "Include the prompt bodies that were kept")
  .action((opts: { lines?: string; json?: boolean; prompts?: boolean }) => {
    const count = Math.max(1, Number.parseInt(opts.lines ?? "20", 10) || 20);
    const records = tailHostedAudit(count);
    const bodies = opts.prompts
      ? tailHostedPrompts(records.flatMap((record) => (record.promptRef ? [record.promptRef] : [])))
      : new Map();
    if (opts.json) {
      console.log(
        JSON.stringify(
          opts.prompts
            ? records.map((record) => ({
                ...record,
                prompt: record.promptRef ? (bodies.get(record.promptRef) ?? null) : null,
              }))
            : records,
          null,
          2,
        ),
      );
      return;
    }
    for (const record of records) {
      const what = record.event ? `${record.event} ${record.detail ?? ""}`.trim() : `${record.method} ${record.path}`;
      console.log(`${record.ts}  ${record.label}  ${record.status || "-"}  ${record.sessionId ?? "-"}  ${what}`);
      const body = record.promptRef ? bodies.get(record.promptRef) : undefined;
      if (body) {
        const suffix = body.truncated ? " […]" : "";
        console.log(`    ${body.promptText.replace(/\n/g, "\n    ")}${suffix}`);
      }
    }
  });

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
  .command("devices")
  .description("List remote client devices")
  .option("--json", "Emit JSON")
  .action(async (opts: { json?: boolean }) => {
    try {
      const devices = await listRemoteSecurityDevices();
      if (opts.json) {
        console.log(JSON.stringify({ devices }, null, 2));
        return;
      }
      renderRemoteSecurityDevices(devices).forEach((line) => console.log(line));
    } catch (err) {
      console.error(`Could not list remote devices: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

const securityDeviceCmd = securityCmd.command("device").description("Approve a live remote client device");

securityDeviceCmd
  .command("approve [deviceId]")
  .description("Approve the most recent live remote client waiting for access")
  .option("--json", "Emit JSON")
  .action(async (deviceId: string | undefined, opts: { json?: boolean }) => {
    try {
      const devices = await listLivePendingRemoteSecurityDevices();
      const candidates = deviceId
        ? devices.filter((device) => device.id === deviceId || device.deviceId === deviceId)
        : devices;
      if (candidates.length === 0) {
        if (opts.json) {
          console.log(
            JSON.stringify(
              { ok: false, devices: [], error: "No live remote clients are waiting for approval" },
              null,
              2,
            ),
          );
          return;
        }
        console.log(
          deviceId
            ? `No live remote client is waiting for approval as ${deviceId}.`
            : "No live remote clients are waiting for approval.",
        );
        return;
      }

      const approved = await approveLiveRemoteSecurityDeviceInteractively(candidates);
      if (!approved) {
        if (opts.json) console.log(JSON.stringify({ ok: false, devices: candidates }, null, 2));
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, device: approved }, null, 2));
        return;
      }
      console.log(`Approved ${approved.name ?? approved.kind} (${approved.id})`);
    } catch (err) {
      console.error(`Could not approve remote device: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

securityCmd
  .command("approve <deviceId>")
  .description("Approve a remote client device")
  .option("--code <code>", "Approval code shown on the waiting device")
  .option("--json", "Emit JSON")
  .action(async (deviceId: string, opts: { code?: string; json?: boolean }) => {
    try {
      const device = await approveRemoteSecurityDevice(deviceId, opts.code);
      if (opts.json) {
        console.log(JSON.stringify({ device }, null, 2));
        return;
      }
      console.log(`Approved ${device.id} (${device.name ?? device.kind})`);
    } catch (err) {
      console.error(`Could not approve remote device: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

securityCmd
  .command("block <deviceId>")
  .alias("revoke")
  .description("Block a remote client device")
  .option("--json", "Emit JSON")
  .action(async (deviceId: string, opts: { json?: boolean }) => {
    try {
      const device = await blockRemoteSecurityDevice(deviceId);
      if (opts.json) {
        console.log(JSON.stringify({ device }, null, 2));
        return;
      }
      console.log(`Blocked ${device.id} (${device.name ?? device.kind})`);
    } catch (err) {
      console.error(`Could not block remote device: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

securityCmd
  .command("unblock <deviceId>")
  .description("Unblock a remote client device without approving it")
  .option("--json", "Emit JSON")
  .action(async (deviceId: string, opts: { json?: boolean }) => {
    try {
      const device = await unblockRemoteSecurityDevice(deviceId);
      if (opts.json) {
        console.log(JSON.stringify({ device }, null, 2));
        return;
      }
      console.log(`Unblocked ${device.id} (${device.name ?? device.kind})`);
    } catch (err) {
      console.error(`Could not unblock remote device: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
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

function renderRemoteSecurityDevices(devices: RemoteSecurityDevice[]): string[] {
  if (devices.length === 0) return ["No remote client devices have connected."];
  const lines = ["Remote client devices (most recent first)"];
  for (const device of devices) {
    const state = device.blocked ? "blocked" : device.approved ? "approved" : "pending";
    const name = device.name ?? device.kind;
    const location = device.lastCountry ? ` from ${device.lastCountry}` : "";
    lines.push(
      "",
      `${state.padEnd(8)} ${name}${location}`,
      `  id       ${device.id}`,
      `  platform ${device.platform ?? device.kind}`,
      `  seen     ${device.lastSeenAt}`,
    );
  }
  return lines;
}

async function approveLiveRemoteSecurityDeviceInteractively(
  devices: RemoteSecurityDevice[],
): Promise<RemoteSecurityDevice | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Interactive approval requires a TTY. Run `aimux security device approve` in a terminal and type the code shown on the waiting device.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [index, device] of devices.entries()) {
      console.log("");
      renderPendingRemoteSecurityDevice(device, index + 1, devices.length).forEach((line) => console.log(line));
      const answer = (
        await rl.question("Type the code shown on the waiting device here, Enter for not this device, or q to quit: ")
      ).trim();
      if (!answer) continue;
      if (answer.toLowerCase() === "q") return null;
      try {
        return await approveRemoteSecurityDevice(device.id, answer);
      } catch (error) {
        console.log(error instanceof Error ? error.message : "Code did not match; device was not approved.");
        console.log("Leaving this device pending; showing the next live device if there is one.");
        continue;
      }
    }
  } finally {
    rl.close();
  }
  console.log("No device approved.");
  return null;
}

function renderPendingRemoteSecurityDevice(device: RemoteSecurityDevice, index: number, total: number): string[] {
  const name = device.name ?? device.kind;
  const location = device.lastCountry ? ` from ${device.lastCountry}` : "";
  return [
    `Remote client waiting for approval (${index} of ${total})`,
    `  Device   ${name}${location}`,
    `  ID       ${device.id}`,
    `  Platform ${device.platform ?? device.kind}`,
    `  Seen     ${device.lastSeenAt}`,
    "  Confirm  Read the code on that waiting device, then type it here.",
  ];
}

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

function printWorktreeCacheCleanup(result: WorktreeCacheCleanupRunResult): void {
  console.log(renderWorktreeCacheCleanupRunResult(result).join("\n"));
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

const attachmentCmd = program.command("attachment").description("Publish local files as chat attachments");

attachmentCmd
  .command("publish <path>")
  .description("Copy a local file into aimux attachments and print a transcript reference")
  .requiredOption("--session <sessionId>", "Session that owns the attachment")
  .option("--project <path>", "Project path")
  .option("--name <filename>", "Display filename")
  .option("--mime <mimeType>", "Attachment MIME type")
  .option("--json", "Emit JSON")
  .action(
    async (
      filePath: string,
      opts: { session: string; project?: string; name?: string; mime?: string; json?: boolean },
    ) => {
      const sourcePath = pathResolve(filePath);
      const projectRoot = opts.project ? await prepareProjectContext(opts.project) : await prepareProjectContext();
      // Validated before the bytes go anywhere. Hosting uploads a copy to the
      // relay, so leaving this to the project service would exfiltrate first
      // and refuse afterwards.
      let sourceRealPath: string;
      try {
        sourceRealPath = assertPublishableSource({
          sourcePath,
          projectRoot,
          allowedRoots: listWorktrees(projectRoot).map((worktree) => worktree.path),
        });
      } catch (error) {
        console.error(`aimux: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
      const hostedAttachment = await maybeHostPublishedAttachment({
        sourcePath: sourceRealPath,
        filename: opts.name || basename(sourcePath),
        mimeType: opts.mime || mimeTypeForPublishedAttachment(sourcePath),
        sessionId: opts.session,
      });
      const result = await postProjectServiceJson(
        PROJECT_API_ROUTES.attachmentsPublish,
        {
          // The resolved path, so the service copies the same bytes the relay
          // was handed rather than re-resolving the argument on its own.
          path: sourceRealPath,
          sessionId: opts.session,
          filename: opts.name,
          mimeType: opts.mime,
          ...(hostedAttachment ? { hostedAttachment } : {}),
        },
        { projectRoot },
      );
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(result.referenceText);
    },
  );

interface HostedAttachmentForPublish {
  contentUrl: string;
  expiresAt: string;
  sha256?: string;
  sizeBytes?: number;
}

async function maybeHostPublishedAttachment(input: {
  sourcePath: string;
  filename: string;
  mimeType: string;
  sessionId: string;
}): Promise<HostedAttachmentForPublish | undefined> {
  const creds = loadCredentials();
  if (!creds?.remoteEnabled) return undefined;
  let relayBase: string;
  try {
    relayBase = relayHttpUrl(creds.relayUrl);
  } catch {
    return undefined;
  }
  try {
    const bytes = readFileSync(input.sourcePath);
    const response = await requestJson<{
      ok?: boolean;
      error?: string;
      hostedAttachment?: HostedAttachmentForPublish;
    }>(`${relayBase}/attachments/hosted`, {
      method: "POST",
      timeoutMs: 15_000,
      headers: { authorization: `Bearer ${creds.token}` },
      body: {
        filename: input.filename,
        mimeType: input.mimeType,
        dataBase64: bytes.toString("base64"),
        sessionId: input.sessionId,
      },
    });
    if (response.status >= 400 || !response.json.ok || !response.json.hostedAttachment?.contentUrl) {
      console.error(
        `aimux: warning: relay attachment hosting failed${response.json.error ? `: ${response.json.error}` : ""}`,
      );
      return undefined;
    }
    return response.json.hostedAttachment;
  } catch (error) {
    console.error(
      `aimux: warning: relay attachment hosting failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function relayHttpUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return url.toString().replace(/\/+$/, "");
}

function mimeTypeForPublishedAttachment(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  const known = publishMimeTypes.get(extension);
  return known ?? "application/octet-stream";
}

const publishMimeTypes = new Map([
  [".aac", "audio/aac"],
  [".csv", "text/csv"],
  [".flac", "audio/flac"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".m4a", "audio/m4a"],
  [".md", "text/markdown"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".txt", "text/plain"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
]);

type CliAgentListItem = AgentListItem & {
  loop?: { active?: boolean; goal?: string };
  task?: { description?: string; status?: string };
};

function agentCanonicalId(agent: CliAgentListItem): string {
  return agent.toolConfigKey ?? agent.tool ?? agent.command ?? "?";
}

function agentWorktreeLabel(path: string | undefined, projectRoot: string | undefined): string {
  if (!path) return "Main Checkout";
  if (projectRoot && path === projectRoot) return "Main Checkout";
  return basename(path);
}

function agentWorktreeSortKey(path: string | undefined, projectRoot: string | undefined): string {
  if (!path || (projectRoot && path === projectRoot)) return "";
  return path;
}

function renderAgentSummary(agent: CliAgentListItem): string {
  const tags = [
    agent.role ? `role=${agent.role}` : null,
    agent.overseer ? "overseer" : null,
    agent.loop?.active ? `loop${agent.loop.goal ? `=${agent.loop.goal}` : ""}` : null,
  ].filter(Boolean);
  const state = [agent.activity, agent.attention].filter(Boolean).join("/");
  const detail = [
    `canonical=${agentCanonicalId(agent)}`,
    `aimux=${agent.id}`,
    agent.backendSessionId ? `backend=${agent.backendSessionId}` : null,
    state ? `state=${state}` : null,
    tags.length ? tags.join(" ") : null,
  ].filter(Boolean);
  return `  ${agent.status ?? "?"}  ${detail.join("  ")}`;
}

function printAgentsFlat(agents: CliAgentListItem[], projectRoot?: string): void {
  if (agents.length === 0) {
    console.log("no agents");
    return;
  }
  for (const agent of agents) {
    console.log(`${agent.id}  [${agentCanonicalId(agent)}]${agent.role ? `  ${agent.role}` : ""}`);
    console.log(renderAgentSummary(agent));
    if (agent.worktreePath) console.log(`    worktree: ${agent.worktreePath}`);
    else if (projectRoot) console.log(`    worktree: ${projectRoot}`);
    if (agent.task) console.log(`    task: ${agent.task.description ?? ""} (${agent.task.status ?? "?"})`);
  }
}

function printAgentsByWorktree(agents: CliAgentListItem[], projectRoot?: string): void {
  if (agents.length === 0) {
    console.log("no agents");
    return;
  }
  const groups = new Map<string, CliAgentListItem[]>();
  for (const agent of agents) {
    const key = agentWorktreeSortKey(agent.worktreePath, projectRoot);
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  const sortedGroups = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [index, [path, group]] of sortedGroups.entries()) {
    if (index > 0) console.log("");
    const label = agentWorktreeLabel(path || undefined, projectRoot);
    console.log(`${label}${path ? `  ${path}` : projectRoot ? `  ${projectRoot}` : ""}`);
    for (const agent of group.sort((left, right) => left.id.localeCompare(right.id))) {
      console.log(renderAgentSummary(agent));
      if (agent.task) console.log(`    task: ${agent.task.description ?? ""} (${agent.task.status ?? "?"})`);
    }
  }
}

program
  .command("ps")
  .description("Show all agents in this project (across worktrees) with activity and loop state")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (opts: { project?: string; json?: boolean }) => {
    const projectRoot = opts.project ? await prepareProjectContext(opts.project) : undefined;
    if (!projectRoot) await initPaths();
    const result = await getProjectServiceJson("/agents", projectRoot ? { projectRoot } : undefined);
    const agents: CliAgentListItem[] = result.agents ?? [];
    if (opts.json) {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }
    printAgentsFlat(agents, projectRoot);
  });

program
  .command("list")
  .description("List agents grouped by worktree with canonical, Aimux, and backend ids")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (opts: { project?: string; json?: boolean }) => {
    const projectRoot = opts.project ? await prepareProjectContext(opts.project) : undefined;
    if (!projectRoot) await initPaths();
    const result = await getProjectServiceJson("/agents", projectRoot ? { projectRoot } : undefined);
    const agents: CliAgentListItem[] = result.agents ?? [];
    if (opts.json) {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }
    printAgentsByWorktree(agents, projectRoot);
  });

const loopCmd = program.command("loop").description("Manage agents in an overseer-managed loop");

function loopMutationActor(
  defaultSource: AgentLoopInput["source"],
): Pick<AgentLoopInput, "source" | "updatedBy" | "updatedBySessionId" | "updatedByRole"> {
  const sessionId = process.env.AIMUX_SESSION_ID?.trim();
  const tool = process.env.AIMUX_TOOL?.trim();
  const isOverseer = process.env.AIMUX_OVERSEER === "1";
  if (!sessionId) return { source: defaultSource };
  return {
    source: isOverseer ? "overseer" : "agent",
    updatedBy: sessionId,
    updatedBySessionId: sessionId,
    updatedByRole: isOverseer ? "overseer" : tool || undefined,
  };
}

loopCmd
  .command("add")
  .description("Mark an agent as in a managed loop (keep it working until done/blocked)")
  .argument("<sessionId>", "Target agent session id")
  .option("--goal <goal>", "What the agent should keep working toward")
  .action(async (sessionId: string, opts: { goal?: string }) => {
    await initPaths();
    const result = await postProjectServiceJson("/agents/loop", {
      sessionId,
      active: true,
      goal: opts.goal,
      ...loopMutationActor("human"),
    });
    console.log(`loop on ${sessionId}${result.loop?.goal ? ` — ${result.loop.goal}` : ""}`);
  });

loopCmd
  .command("remove")
  .description("Remove an agent from the managed loop")
  .argument("<sessionId>", "Target agent session id")
  .action(async (sessionId: string) => {
    await initPaths();
    await postProjectServiceJson("/agents/loop", {
      sessionId,
      active: false,
      action: "remove",
      ...loopMutationActor("human"),
    });
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
  const action = event.kind === "blocked" ? "block" : "done";
  await postProjectServiceJson("/agents/loop", {
    sessionId,
    active: false,
    action,
    reason: typeof event.message === "string" ? event.message : undefined,
    ...loopMutationActor("agent"),
  });
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
  .option("--result <text>", "Alias for --body")
  .option("--json", "Emit JSON")
  .action(
    async (
      taskId: string,
      opts: { project?: string; from?: string; body?: string; result?: string; json?: boolean },
    ) => {
      const projectRoot = await prepareProjectContext(opts.project);
      const body = opts.body ?? opts.result;
      const result = await postProjectServiceJson(
        "/tasks/complete",
        {
          taskId,
          from: opts.from ?? "user",
          body,
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
  .command("cleanup-caches")
  .description("Remove generated cache directories from Aimux-managed worktrees")
  .option("--project <path>", "Project path")
  .option("--yes", "Delete cache directories instead of doing a dry run")
  .option("--include-active", "Include worktrees with running agents or services")
  .option("--json", "Emit JSON")
  .action(async (opts: { project?: string; yes?: boolean; includeActive?: boolean; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      await ensureDaemonProjectReady(projectRoot);
      const result = (await postLiveProjectServiceJson(projectRoot, PROJECT_API_ROUTES.worktreeActions.cacheCleanup, {
        dryRun: opts.yes !== true,
        includeActive: opts.includeActive === true,
      })) as { result?: WorktreeCacheCleanupRunResult } & WorktreeCacheCleanupRunResult;
      const cleanupResult = result.result ?? result;
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, projectRoot, ...cleanupResult }, null, 2));
        return;
      }
      printWorktreeCacheCleanup(cleanupResult);
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
  .command("lifecycle")
  .description("Inspect project-service lifecycle queue diagnostics")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (opts: { project?: string; json?: boolean }) => {
    try {
      const projectRoot = opts.project ? await prepareProjectContext(opts.project) : resolveProjectRoot(process.cwd());
      const diagnostics = await getProjectServiceJson(PROJECT_API_ROUTES.diagnosticsLifecycle, { projectRoot });
      if (opts.json) {
        console.log(JSON.stringify(diagnostics, null, 2));
        return;
      }
      const telemetry = diagnostics.telemetry ?? {};
      console.log(`Project: ${diagnostics.projectRoot ?? projectRoot}`);
      console.log(`Queue: ${diagnostics.queuedCount ?? "?"}/${diagnostics.queueLimit ?? "?"}`);
      console.log(
        `Lifecycle: enqueued=${telemetry.enqueued ?? 0} started=${telemetry.started ?? 0} succeeded=${
          telemetry.succeeded ?? 0
        } failed=${telemetry.failed ?? 0} released=${telemetry.released ?? 0}`,
      );
      console.log(
        `Max: queued=${telemetry.maxQueuedCount ?? 0} wait=${telemetry.maxQueuedMs ?? 0}ms duration=${
          telemetry.maxDurationMs ?? 0
        }ms`,
      );
      console.log(
        `Rejected: conflicts=${telemetry.rejectedConflicts ?? 0} queueFull=${telemetry.rejectedQueueFull ?? 0}`,
      );
      if (telemetry.lastError) console.log(`Last error: ${telemetry.lastError}`);
      const activeTargets = Array.isArray(diagnostics.activeTargets) ? diagnostics.activeTargets : [];
      if (activeTargets.length > 0) {
        console.log("Active targets:");
        for (const target of activeTargets) {
          console.log(`  ${target.operation ?? "?"} ${target.key ?? target.targetId ?? target.targetPath ?? "?"}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

function printExchangeDiagnostics(diagnostics: any): void {
  const exchange = diagnostics.runtimeExchange ?? {};
  const counts = exchange.counts ?? {};
  const byteCounts = exchange.byteCounts ?? {};
  const compactableByteCounts = exchange.compactableByteCounts ?? {};
  const messageDelivery = exchange.messageDelivery ?? {};
  const retainedCounts = exchange.retainedCounts ?? {};
  const retainedByteCounts = exchange.retainedByteCounts ?? {};
  const retainedMessageDelivery = exchange.retainedMessageDelivery ?? {};
  const telemetry = exchange.telemetry ?? {};
  console.log(`Project: ${diagnostics.projectRoot ?? "unknown"}`);
  console.log(`Path: ${exchange.path ?? "unknown"}`);
  console.log(`Bytes: ${exchange.bytes ?? 0}`);
  console.log(
    `Records: total=${counts.totalRecords ?? 0} threads=${counts.threads ?? 0} messages=${counts.messages ?? 0} tasks=${
      counts.tasks ?? 0
    } inbox=${counts.inbox ?? 0}`,
  );
  console.log(
    `Text bytes: stored=${byteCounts.totalStoredTextBytes ?? 0} original=${
      byteCounts.totalOriginalTextBytes ?? 0
    } messages=${byteCounts.messageBodyBytes ?? 0} tasks=${
      (byteCounts.taskPromptBytes ?? 0) + (byteCounts.taskResultBytes ?? 0) + (byteCounts.taskErrorBytes ?? 0)
    } compactedMessages=${byteCounts.compactedMessageBodies ?? 0} compactedTasks=${byteCounts.compactedTasks ?? 0}`,
  );
  console.log(`Compactable text bytes: ${compactableByteCounts.totalStoredTextBytes ?? 0}`);
  console.log(
    `Retained records after compaction: total=${retainedCounts.totalRecords ?? 0} threads=${
      retainedCounts.threads ?? 0
    } messages=${retainedCounts.messages ?? 0} tasks=${retainedCounts.tasks ?? 0}`,
  );
  console.log(`Retained text bytes after compaction: ${retainedByteCounts.totalStoredTextBytes ?? 0}`);
  console.log(
    `Message delivery bytes: pending=${messageDelivery.pendingMessageBodyBytes ?? 0} delivered=${
      messageDelivery.deliveredMessageBodyBytes ?? 0
    } noRecipient=${messageDelivery.noRecipientMessageBodyBytes ?? 0}`,
  );
  console.log(
    `Retained message delivery bytes: pending=${retainedMessageDelivery.pendingMessageBodyBytes ?? 0} delivered=${
      retainedMessageDelivery.deliveredMessageBodyBytes ?? 0
    } noRecipient=${retainedMessageDelivery.noRecipientMessageBodyBytes ?? 0}`,
  );
  for (const thread of Array.isArray(exchange.largestRetainedThreads)
    ? exchange.largestRetainedThreads.slice(0, 5)
    : []) {
    console.log(
      `Large retained thread: ${thread.id} ${thread.kind}/${thread.status} messages=${thread.messageCount} bytes=${
        thread.messageBodyBytes
      } pendingBytes=${thread.pendingMessageBodyBytes} title=${thread.title}`,
    );
  }
  console.log(
    `Store: reads=${telemetry.reads ?? 0} parses=${telemetry.parses ?? 0} compactions=${
      telemetry.compactions ?? 0
    } compactedRecords=${telemetry.compactedRecords ?? 0}`,
  );
  console.log(
    `Cache: hits=${telemetry.readCacheHits ?? 0} misses=${telemetry.readCacheMisses ?? 0} slowReads=${
      telemetry.slowReads ?? 0
    } suppressedSlowReadLogs=${telemetry.slowReadSuppressed ?? 0}`,
  );
  console.log(`Writes: total=${telemetry.writes ?? 0} noops=${telemetry.writeNoops ?? 0}`);
}

doctorCmd
  .command("exchange")
  .description("Inspect runtime exchange size, counts, and retention telemetry")
  .option("--project <path>", "Project path")
  .option("--json", "Emit JSON")
  .action(async (opts: { project?: string; json?: boolean }) => {
    try {
      const projectRoot = opts.project ? await prepareProjectContext(opts.project) : resolveProjectRoot(process.cwd());
      const diagnostics = await getProjectServiceJson(PROJECT_API_ROUTES.diagnostics, { projectRoot });
      if (opts.json === true) {
        console.log(JSON.stringify(diagnostics.runtimeExchange ?? diagnostics, null, 2));
        return;
      }
      printExchangeDiagnostics({ ...diagnostics, projectRoot });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

doctorCmd
  .command("disk")
  .description("Inspect Aimux-managed worktree cache disk usage")
  .option("--project <path>", "Project path")
  .option("--include-active", "Measure cache directories in active worktrees")
  .option("--json", "Emit JSON")
  .action(async (opts: { project?: string; includeActive?: boolean; json?: boolean }) => {
    try {
      const project = opts.project ? resolveProjectRoot(pathResolve(opts.project)) : undefined;
      const report = (await getDaemonTextJson(CORE_API_ROUTES.doctorDiskText, {
        project,
        includeActive: opts.includeActive ? "1" : undefined,
      })) as DiskDoctorReport;
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(renderDiskDoctorReport(report));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

/** Zero is a real answer here, so only unparseable input falls back to the default. */
function parseCount(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

doctorCmd
  .command("installs")
  .description("Report superseded installs under the aimux install root; removes nothing without --fix")
  .option("--fix", "Remove the reported installs instead of only listing them")
  .option("--retention-days <days>", "Keep installs newer than this many days")
  .option("--keep-recent <count>", "Always keep this many newest installs")
  .option("--json", "Emit JSON")
  .action(async (opts: { fix?: boolean; retentionDays?: string; keepRecent?: string; json?: boolean }) => {
    const plan = planInstallCleanup({
      retentionDays: parseCount(opts.retentionDays, DEFAULT_INSTALL_RETENTION_DAYS),
      keepRecent: parseCount(opts.keepRecent, DEFAULT_INSTALL_KEEP_RECENT),
    });
    const result = await runInstallCleanup(plan, {}, { dryRun: isInstallCleanupDryRun(opts) });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(renderInstallCleanupResult(result));
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
  .command("exchange")
  .description("Compact runtime-exchange.yaml using project-service retention rules")
  .option("--project <path>", "Project path", process.cwd())
  .option("--json", "Emit JSON")
  .action(async (opts: { project: string; json?: boolean }) => {
    try {
      const projectRoot = await prepareProjectContext(opts.project);
      const result = await postProjectServiceJson(PROJECT_API_ROUTES.runtime.compactExchange, {}, { projectRoot });
      const outputJson = opts.json === true || repairCmd.opts<{ json?: boolean }>().json === true;
      if (outputJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const compact = result.result ?? {};
      console.log(`Project: ${projectRoot}`);
      console.log(`Path: ${compact.path ?? "unknown"}`);
      console.log(`Bytes: ${compact.bytesBefore ?? 0} -> ${compact.bytesAfter ?? 0}`);
      console.log(`Removed records: ${compact.removed?.totalRecords ?? 0}`);
      console.log(`Removed text bytes: ${compact.byteCounts?.removed?.totalStoredTextBytes ?? 0}`);
      printExchangeDiagnostics({ ...result, projectRoot });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
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

program
  // Hidden: run by hand against a project the daemon already hosts, this binds a
  // second metadata server and overwrites the endpoint file the first one owns.
  .command("__project-service-internal", { hidden: true })
  .description("Internal daemon-managed project service entrypoint")
  .option("--project-id <id>", "Internal project id")
  .option("--project-root <path>", "Internal project root")
  .action(async (opts: { projectId?: string; projectRoot?: string }) => {
    void opts.projectId;
    const projectRoot = resolveProjectRoot(opts.projectRoot ? pathResolve(opts.projectRoot) : process.cwd());
    if (projectRoot !== process.cwd()) {
      process.chdir(projectRoot);
    }
    // initPaths, not withProjectPaths: the latter is AsyncLocalStorage, which
    // exists because the daemon serves many projects in one process. Here the
    // process serves one, and callbacks that escape the ALS — signal handlers,
    // worker messages, timer chains — would fail "paths not initialized".
    await initPaths(projectRoot);
    initProject();

    const mux = new Multiplexer({ contextWatcherEnabled: false, projectRoot });
    let cleanedUp = false;
    const ensureTerminalRestored = () => mux.cleanupTerminalOnly();
    const cleanupAll = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await mux.cleanup();
    };

    const shutdown = () => {
      void cleanupAll().finally(() => process.exit(0));
    };
    process.on("exit", ensureTerminalRestored);
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("uncaughtException", (err) => {
      log.error("project service uncaught exception", "runtime", {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      console.error(err);
      void cleanupAll().finally(() => process.exit(1));
    });
    process.on("unhandledRejection", (reason) => {
      log.error("project service unhandled rejection", "runtime", {
        error: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
      console.error(reason);
      void cleanupAll().finally(() => process.exit(1));
    });

    try {
      const exitCode = await mux.runProjectService();
      await cleanupAll();
      process.exit(exitCode);
    } catch (err: unknown) {
      await cleanupAll();
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`aimux project service: ${msg}`);
      process.exit(1);
    }
  });

registerExposeCommand(program);

void program.parseAsync().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
