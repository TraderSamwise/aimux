import { resolve as pathResolve } from "node:path";
import { getDaemonHost } from "../daemon-state.js";
import { ensureDaemonRunning, isStaleAgainstDaemon } from "../daemon-supervisor.js";
import { CORE_COMMAND_NAMES, type CoreProjectServiceState, type CoreStatusProject } from "../core-command-contract.js";
import { requestCoreCommand } from "../core-command-client.js";
import { log } from "../debug.js";
import { requestJson } from "../http-client.js";
import {
  loadMetadataEndpoint,
  removeMetadataEndpoint,
  resolveProjectServiceEndpoint as resolveStoredProjectServiceEndpoint,
} from "../metadata-store.js";
import { getProjectStateDirFor } from "../paths.js";
import { getProjectServiceManifest, manifestsMatch, type ProjectServiceManifest } from "../project-service-manifest.js";
import { findMainRepo } from "../worktree.js";
import { restartControlPlaneFromCli } from "../control-plane-restart-client.js";
import { isRuntimeRestartInProgress } from "../runtime-restart.js";
import { isAimuxBuildDriftError } from "../runtime-drift.js";

export class ProjectServiceVersionError extends Error {
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

export class ProjectServiceHttpError extends Error {
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

export function renderProjectServiceVersionHelp(error: ProjectServiceVersionError): string {
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

export async function postProjectServiceJson(
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

export async function getProjectServiceJson(
  path: string,
  opts?: { notFound?: "null"; projectRoot?: string },
): Promise<any> {
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

export async function postLiveProjectServiceJson(projectRoot: string, path: string, body: unknown): Promise<any> {
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

export async function getLiveProjectServiceJson(projectRoot: string, path: string): Promise<any> {
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

export async function getDaemonTextJson(
  path: string,
  params: Record<string, string | undefined> = {},
): Promise<unknown> {
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

export async function resolveProjectServiceEndpoint(projectRoot = resolveProjectRoot(process.cwd())): Promise<{
  host: string;
  port: number;
} | null> {
  return resolveStoredProjectServiceEndpoint(projectRoot);
}

export async function getProjectServiceEndpoint(projectRoot = resolveProjectRoot(process.cwd())): Promise<{
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

export async function ensureDaemonProjectReady(
  projectRoot: string,
  opts?: { repairVersionDrift?: boolean },
): Promise<void> {
  if (opts?.repairVersionDrift === false) {
    await ensureCoreProjectServiceForCli(projectRoot);
    return;
  }
  await ensureCoreProjectServiceForCliWithRepair(projectRoot);
}

export async function ensureDaemonProjectSpawned(projectRoot: string): Promise<void> {
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

export function resolveProjectRoot(cwd: string): string {
  try {
    return findMainRepo(cwd);
  } catch {
    return cwd;
  }
}

export function findCoreProject(projects: CoreStatusProject[], projectRoot: string): CoreStatusProject | null {
  const resolvedRoot = pathResolve(projectRoot);
  return projects.find((project) => pathResolve(project.path) === resolvedRoot) ?? null;
}

export function coreProjectServicePid(project: CoreStatusProject | null): number | null {
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

export async function ensureCoreProjectServiceForCliWithRepair(projectRoot: string): Promise<CoreProjectServiceState> {
  try {
    return await ensureCoreProjectServiceForCli(projectRoot);
  } catch (error) {
    if (!isRepairableCoreProjectStartupError(error)) {
      throw error;
    }
    return await repairCoreProjectServiceForCli(projectRoot);
  }
}

export async function stopCoreProjectServiceForCliWithRepair(projectRoot: string): Promise<void> {
  try {
    await requestCoreCommand(CORE_COMMAND_NAMES.projectStop, { projectRoot });
  } catch (error) {
    if (!isRepairableCoreProjectStartupError(error)) {
      throw error;
    }
    await restartStaleControlPlane(projectRoot);
  }
}
