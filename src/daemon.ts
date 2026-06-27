import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { execFileSync, spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { writeJsonAtomic } from "./atomic-write.js";
import {
  getDaemonInfoPath,
  getDaemonStatePath,
  getDaemonStdioLogPath,
  getGlobalAimuxDir,
  getProjectIdFor,
  getProjectServiceStdioLogPathFor,
} from "./paths.js";
import { listDesktopProjects } from "./project-scanner.js";
import { loadMetadataEndpoint } from "./metadata-store.js";
import { requestJson } from "./http-client.js";
import { getLoggingConfig, log } from "./debug.js";
import { RelayClient, type RelayNotificationPush, type RelayStatusSnapshot } from "./relay-client.js";
import { MobilePushThrottle } from "./mobile-push-throttle.js";
import { loadCredentials, setRemoteEnabled } from "./credentials.js";
import { assertRemoteAccessAllowed, parseRemoteActor } from "./remote-access.js";
import { PROJECT_API_ROUTES } from "./project-api-contract.js";
import { getProjectServiceManifest, manifestsMatch } from "./project-service-manifest.js";
import { commandArgValueMatches } from "./process-args.js";
import { getAimuxCliLaunchCommand } from "./cli-launcher.js";

const DEFAULT_DAEMON_PORT = 43190;
const DEFAULT_DAEMON_HOST = "127.0.0.1";
const DAEMON_STARTUP_TIMEOUT_MS = 10_000;
const DAEMON_HEALTH_PROBE_TIMEOUT_MS = 2_500;
const PROJECT_SERVICE_STARTUP_GRACE_MS = 15_000;
const PROJECT_SERVICE_READY_POLL_MS = 100;
const PROJECT_SERVICE_HEALTH_TIMEOUT_MS = 2_500;
// A busy event loop can miss a health ping; only restart after this many
// consecutive failures so transient stalls don't churn the service.
const PROJECT_SERVICE_HEALTH_FAILURE_THRESHOLD = 3;
const PROJECT_SERVICE_TERM_GRACE_MS = 2_000;
const PROJECT_SERVICE_KILL_GRACE_MS = 3_000;
const PROJECT_SERVICE_EXIT_POLL_MS = 50;
const PROXY_TIMEOUT_MS = 10_000;
const DAEMON_HEALTH_KIND = "aimux-daemon";
// `::1` is intentionally excluded — building http://::1:port is invalid (IPv6
// needs brackets) and metadata services bind to 127.0.0.1 anyway.
const PROXY_ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);
const CORS_ALLOWED_ORIGINS = new Set([
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://localhost:8091",
  "http://127.0.0.1:8091",
  "http://localhost:43192",
  "http://127.0.0.1:43192",
]);

export function getDaemonHost(): string {
  const host = process.env.AIMUX_DAEMON_HOST?.trim();
  const resolved = host || DEFAULT_DAEMON_HOST;
  if (resolved !== "127.0.0.1" && resolved !== "localhost") {
    throw new Error(`AIMUX_DAEMON_HOST must be loopback (127.0.0.1 or localhost), got ${resolved}`);
  }
  return resolved;
}

export function getDaemonPort(): number {
  const raw = process.env.AIMUX_DAEMON_PORT?.trim();
  if (!raw) return DEFAULT_DAEMON_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`AIMUX_DAEMON_PORT must be an integer between 1 and 65535, got ${raw}`);
  }
  return port;
}

function getDaemonBaseUrl(port = getDaemonPort()): string {
  return `http://${getDaemonHost()}:${port}`;
}

export interface AimuxDaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
  updatedAt: string;
}

export interface ProjectServiceState {
  projectId: string;
  projectRoot: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
}

export interface StoppedDaemonInfo extends AimuxDaemonInfo {
  stoppedProjectServices: ProjectServiceState[];
}

export interface EnsureDaemonRunningOptions {
  adoptExisting?: boolean;
}

interface DaemonState {
  version: 1;
  updatedAt: string;
  projects: Record<string, ProjectServiceState>;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function loggingChildEnv(): NodeJS.ProcessEnv {
  const logging = getLoggingConfig();
  if (!logging.enabled) return process.env;
  return {
    ...process.env,
    AIMUX_LOG: "1",
    AIMUX_LOG_LEVEL: logging.level,
    AIMUX_LOG_CATEGORIES: logging.categories.join(","),
  };
}

function loggingChildStdio(path: string): { stdio: StdioOptions; close: () => void } {
  const logging = getLoggingConfig();
  if (!logging.enabled) return { stdio: "ignore", close: () => {} };
  try {
    ensureParent(path);
    const stdout = openSync(path, "a");
    const stderr = openSync(path, "a");
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      closeSync(stdout);
      closeSync(stderr);
    };
    return { stdio: ["ignore", stdout, stderr], close };
  } catch {
    return { stdio: "ignore", close: () => {} };
  }
}

function saveJson(path: string, value: unknown): void {
  try {
    writeJsonAtomic(path, value);
  } catch {
    ensureParent(path);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  }
}

function clearFile(path: string): void {
  ensureParent(path);
  writeFileSync(path, "");
}

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ProjectServiceProcessIdentity {
  projectId?: string;
  projectRoot?: string;
}

function isAimuxDaemonHealth(json: any): boolean {
  return json?.kind === DAEMON_HEALTH_KIND && Number.isInteger(json?.pid) && json.pid > 0;
}

function isMatchingDaemonHealth(json: any): boolean {
  return isAimuxDaemonHealth(json) && manifestsMatch(getProjectServiceManifest(), json?.serviceInfo);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daemonStartLockPath(): string {
  return join(getGlobalAimuxDir(), "locks", "daemon-start");
}

function readLockPid(lockPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

function tryAcquireDaemonStartLock(): string | null {
  const lockPath = daemonStartLockPath();
  mkdirSync(dirname(lockPath), { recursive: true });
  const acquire = (): string | null => {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`);
      return lockPath;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      return null;
    }
  };
  const acquired = acquire();
  if (acquired) return acquired;
  const pid = readLockPid(lockPath);
  if (pid && isPidAlive(pid)) return null;
  rmSync(lockPath, { recursive: true, force: true });
  return acquire();
}

function releaseDaemonStartLock(lockPath: string | null): void {
  if (!lockPath) return;
  if (readLockPid(lockPath) !== process.pid) return;
  rmSync(lockPath, { recursive: true, force: true });
}

async function probeDefaultDaemon(options: EnsureDaemonRunningOptions): Promise<AimuxDaemonInfo | null> {
  try {
    const { status, json } = await requestJson(`${getDaemonBaseUrl()}/health`, {
      timeoutMs: DAEMON_HEALTH_PROBE_TIMEOUT_MS,
    });
    if (status >= 200 && status < 300 && json?.ok !== false && isAimuxDaemonHealth(json)) {
      if (options.adoptExisting === false) {
        log.warn("terminating daemon on default port instead of adopting", "daemon", { pid: json.pid });
        await terminateDaemonOnDefaultPort(json.pid);
        clearFile(getDaemonInfoPath());
        return null;
      }
      if (!isMatchingDaemonHealth(json)) {
        throw new Error("aimux daemon on default port is from a different local build; run aimux restart");
      }
      const adopted: AimuxDaemonInfo = {
        pid: json.pid,
        port: typeof json?.port === "number" ? json.port : getDaemonPort(),
        startedAt: loadDaemonInfo()?.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveJson(getDaemonInfoPath(), adopted);
      log.info("adopted existing daemon on default port", "daemon", { ...adopted });
      return adopted;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("different local build")) {
      throw error;
    }
    log.debug("default daemon health probe failed", "daemon", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

function readProcessCwd(pid: number): string | null {
  try {
    const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const cwd = output
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1)
      .trim();
    return cwd || null;
  } catch {
    return null;
  }
}

function isAimuxProjectServiceProcess(pid: number, expected: ProjectServiceProcessIdentity = {}): boolean {
  try {
    const args = execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!args.includes("__project-service-internal")) return false;
    if (!args.includes("--project-id") && !args.includes("--project-root") && expected.projectRoot) {
      return pathResolve(readProcessCwd(pid) ?? "") === pathResolve(expected.projectRoot);
    }
    if (expected.projectId && !commandArgValueMatches(args, "--project-id", expected.projectId)) return false;
    if (expected.projectRoot && !commandArgValueMatches(args, "--project-root", expected.projectRoot)) return false;
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidAlive(pid);
}

async function terminateDaemonOnDefaultPort(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  if (await waitForPidExit(pid, 2_000)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  await waitForPidExit(pid, 2_000);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? JSON.parse(body) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.setHeader("connection", "close");
  res.end(payload);
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin && !isAllowedCorsOrigin(origin)) return false;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return true;
}

function isAllowedCorsOrigin(origin: string): boolean {
  if (CORS_ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function rejectCors(res: ServerResponse): void {
  send(res, 403, { ok: false, error: "origin not allowed" });
}

export function loadDaemonInfo(): AimuxDaemonInfo | null {
  const info = loadJson<AimuxDaemonInfo | null>(getDaemonInfoPath(), null);
  if (!info) return null;
  return isPidAlive(info.pid) ? info : null;
}

export async function stopDaemon(signal: NodeJS.Signals = "SIGTERM"): Promise<StoppedDaemonInfo | null> {
  const info = loadDaemonInfo();
  if (!info) return null;
  const state = loadDaemonState();
  const projectServiceStates = Object.values(state.projects);
  log.info("stopping daemon", "daemon", {
    pid: info.pid,
    signal,
    projectCount: Object.keys(state.projects).length,
  });
  const stoppedProjectServices: ProjectServiceState[] = [];
  for (const entry of projectServiceStates) {
    if (!isAimuxProjectServiceProcess(entry.pid, entry)) {
      log.warn("skipping unverified project service pid during daemon stop", "daemon", {
        projectId: entry.projectId,
        projectRoot: entry.projectRoot,
        pid: entry.pid,
      });
      continue;
    }
    try {
      process.kill(entry.pid, signal);
      stoppedProjectServices.push(entry);
    } catch {}
  }
  try {
    process.kill(info.pid, signal);
  } catch {}
  saveJson(getDaemonStatePath(), {
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: {},
  } satisfies DaemonState);
  clearFile(getDaemonInfoPath());
  return { ...info, stoppedProjectServices };
}

export function loadDaemonState(): DaemonState {
  const raw = loadJson<DaemonState>(getDaemonStatePath(), {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    projects: {},
  });
  const projects: Record<string, ProjectServiceState> = {};
  for (const [projectId, entry] of Object.entries(raw.projects ?? {})) {
    if (entry && isPidAlive(entry.pid)) {
      projects[projectId] = entry;
    }
  }
  if (Object.keys(projects).length !== Object.keys(raw.projects ?? {}).length) {
    saveJson(getDaemonStatePath(), {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects,
    } satisfies DaemonState);
  }
  return {
    version: 1,
    updatedAt: raw.updatedAt,
    projects,
  };
}

export async function requestDaemonJson(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<any> {
  const info = loadDaemonInfo();
  if (!info) {
    throw new Error("aimux daemon is not running");
  }
  const { status, json } = await requestJson(`${getDaemonBaseUrl(info.port)}${path}`, {
    method: init?.method,
    headers: init?.headers as Record<string, string> | undefined,
    body: init?.body,
    timeoutMs: init?.timeoutMs,
  });
  if (status < 200 || status >= 300 || json?.ok === false) {
    throw new Error(json?.error || `daemon request failed: ${status}`);
  }
  return json;
}

export async function ensureDaemonRunning(options: EnsureDaemonRunningOptions = {}): Promise<AimuxDaemonInfo> {
  const existing = loadDaemonInfo();
  if (existing) {
    try {
      const health = await requestDaemonJson("/health", { timeoutMs: DAEMON_HEALTH_PROBE_TIMEOUT_MS });
      if (!isAimuxDaemonHealth(health)) {
        throw new Error("stored daemon health response does not identify Aimux");
      }
      if (health.pid !== existing.pid) {
        throw new Error(`stored daemon pid ${existing.pid} does not match live pid ${health?.pid ?? "unknown"}`);
      }
      if (options.adoptExisting === false) {
        log.warn("terminating stored daemon instead of adopting", "daemon", { pid: existing.pid });
        await terminateDaemonOnDefaultPort(existing.pid);
        clearFile(getDaemonInfoPath());
      } else if (!isMatchingDaemonHealth(health)) {
        throw new Error("stored daemon health response does not match this Aimux build");
      } else {
        return existing;
      }
    } catch (error) {
      log.warn("stored daemon info failed health check", "daemon", {
        pid: existing.pid,
        error: error instanceof Error ? error.message : String(error),
      });
      clearFile(getDaemonInfoPath());
    }
  }

  const probed = await probeDefaultDaemon(options);
  if (probed) return probed;

  let lockPath = tryAcquireDaemonStartLock();
  if (!lockPath) {
    const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const adopted = await probeDefaultDaemon(options);
      if (adopted) return adopted;
      lockPath = tryAcquireDaemonStartLock();
      if (lockPath) break;
      await sleep(100);
    }
    if (!lockPath) {
      throw new Error("timed out waiting for aimux daemon startup lock");
    }
  }

  try {
    const adopted = await probeDefaultDaemon(options);
    if (adopted) return adopted;

    const stdio = loggingChildStdio(getDaemonStdioLogPath());
    let child: ChildProcess;
    try {
      const launch = getAimuxCliLaunchCommand(["daemon", "run"]);
      child = spawn(launch.command, launch.args, {
        detached: true,
        env: loggingChildEnv(),
        stdio: stdio.stdio,
      });
    } catch (error) {
      stdio.close();
      throw error;
    }
    child.once("exit", stdio.close);
    child.unref();
    log.info("spawned daemon", "daemon", { pid: child.pid });

    const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const info = loadDaemonInfo();
      if (info) {
        try {
          const health = await requestDaemonJson("/health");
          if (health?.pid === info.pid && isMatchingDaemonHealth(health)) return info;
        } catch {}
      }
      await sleep(100);
    }

    throw new Error("timed out waiting for aimux daemon to start");
  } finally {
    releaseDaemonStartLock(lockPath);
  }
}

export async function ensureProjectService(projectRoot: string): Promise<ProjectServiceState> {
  await ensureDaemonRunning();
  const result = await requestDaemonJson("/projects/ensure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot }),
  });
  return result.project as ProjectServiceState;
}

export async function stopProjectService(projectRoot: string): Promise<ProjectServiceState | null> {
  await ensureDaemonRunning();
  const result = await requestDaemonJson("/projects/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectRoot }),
  });
  return (result.project ?? null) as ProjectServiceState | null;
}

export async function projectServiceStatus(projectRoot: string): Promise<ProjectServiceState | null> {
  await ensureDaemonRunning();
  const projectId = getProjectIdFor(projectRoot);
  const result = await requestDaemonJson(`/projects/${encodeURIComponent(projectId)}`);
  return (result.project ?? null) as ProjectServiceState | null;
}

export class AimuxDaemon {
  private server: Server | null = null;
  private relayClient: RelayClient | null = null;
  private readonly pushThrottle = new MobilePushThrottle();
  private readonly children = new Map<string, ChildProcess>();
  private readonly projectEnsurePromises = new Map<string, Promise<ProjectServiceState>>();
  // Consecutive failed health checks per project; a single transient stall
  // (event loop briefly busy) must not trigger a restart.
  private readonly projectHealthFailures = new Map<string, number>();
  private state: DaemonState = loadDaemonState();

  async start(): Promise<void> {
    if (this.server) return;
    saveJson(getDaemonInfoPath(), {
      pid: process.pid,
      port: getDaemonPort(),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies AimuxDaemonInfo);
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        send(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    const host = getDaemonHost();
    const port = getDaemonPort();
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
    this.refreshState();
    log.info("daemon started", "daemon", { pid: process.pid, host, port });
    this.connectRelayIfConfigured();
  }

  // Resolve relay config from stored credentials (`aimux login`), with env-var
  // overrides for advanced/CI use. Connects only when remote access is enabled.
  private connectRelayIfConfigured(options: { force?: boolean } = {}): void {
    const status = this.relayClient?.getStatus().status;
    if (!options.force && this.relayClient && status !== "auth_failed" && status !== "disconnected") return;
    if (this.relayClient) {
      this.relayClient.disconnect();
      this.relayClient = null;
    }
    const creds = loadCredentials();
    const relayUrl = process.env.AIMUX_RELAY_URL ?? creds?.relayUrl;
    const relayToken = process.env.AIMUX_RELAY_TOKEN ?? creds?.token;
    const hasEnvOverride = Boolean(process.env.AIMUX_RELAY_URL || process.env.AIMUX_RELAY_TOKEN);
    const enabled = hasEnvOverride ? Boolean(relayUrl && relayToken) : Boolean(creds?.remoteEnabled);
    if (relayUrl && relayToken && enabled) {
      this.relayClient = new RelayClient(relayUrl, relayToken, this);
      this.relayClient.connect();
    }
  }

  getRelayStatus(): RelayStatusSnapshot | { status: "off" } {
    return this.relayClient?.getStatus() ?? { status: "off" };
  }

  enableRelay(): RelayStatusSnapshot | { status: "off" } {
    setRemoteEnabled(true);
    this.connectRelayIfConfigured({ force: true });
    return this.getRelayStatus();
  }

  disableRelay(): { status: "off" } {
    setRemoteEnabled(false);
    this.relayClient?.disconnect();
    this.relayClient = null;
    return { status: "off" };
  }

  stop(): void {
    log.info("daemon stopping child services", "daemon", { projectCount: Object.keys(this.state.projects).length });
    this.relayClient?.disconnect();
    this.relayClient = null;
    for (const entry of Object.values(this.state.projects)) {
      const child = this.children.get(entry.projectId);
      const trackedChild = child?.pid === entry.pid;
      if (!trackedChild && !isAimuxProjectServiceProcess(entry.pid, entry)) {
        log.warn("skipping unverified project service pid during daemon shutdown", "daemon", {
          projectId: entry.projectId,
          projectRoot: entry.projectRoot,
          pid: entry.pid,
        });
        continue;
      }
      try {
        process.kill(entry.pid, "SIGTERM");
      } catch {}
    }
    this.children.clear();
    this.state = {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {},
    };
    saveJson(getDaemonStatePath(), this.state);
    clearFile(getDaemonInfoPath());
    this.server?.close();
    this.server = null;
  }

  private refreshState(): void {
    const nextProjects: Record<string, ProjectServiceState> = {};
    for (const [projectId, entry] of Object.entries(this.state.projects)) {
      if (isPidAlive(entry.pid)) {
        nextProjects[projectId] = {
          ...entry,
          updatedAt: new Date().toISOString(),
        };
      }
    }
    this.state = {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: nextProjects,
    };
    saveJson(getDaemonStatePath(), this.state);
    saveJson(getDaemonInfoPath(), {
      pid: process.pid,
      port: getDaemonPort(),
      startedAt: loadDaemonInfo()?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies AimuxDaemonInfo);
  }

  private spawnProjectService(projectRoot: string, projectId: string): ProjectServiceState {
    // A fresh service instance starts with a clean health-failure slate, so a
    // new pid never inherits the previous instance's accumulated failure debt.
    this.projectHealthFailures.delete(projectId);
    const stdio = loggingChildStdio(getProjectServiceStdioLogPathFor(projectRoot));
    let child: ChildProcess;
    try {
      const launch = getAimuxCliLaunchCommand([
        "__project-service-internal",
        "--project-id",
        projectId,
        "--project-root",
        projectRoot,
      ]);
      child = spawn(launch.command, launch.args, {
        cwd: projectRoot,
        env: loggingChildEnv(),
        stdio: stdio.stdio,
      });
    } catch (error) {
      stdio.close();
      throw error;
    }
    this.children.set(projectId, child);
    const now = new Date().toISOString();
    const state: ProjectServiceState = {
      projectId,
      projectRoot,
      pid: child.pid!,
      startedAt: now,
      updatedAt: now,
    };
    this.state.projects[projectId] = state;
    log.info("spawned project service", "daemon", {
      projectId,
      projectRoot,
      pid: state.pid,
    });
    child.on("exit", (code, signal) => {
      stdio.close();
      log.warn("project service exited", "daemon", {
        projectId,
        projectRoot,
        pid: state.pid,
        code,
        signal,
      });
      if (this.children.get(projectId) === child) {
        this.children.delete(projectId);
      }
      const current = this.state.projects[projectId];
      if (current?.pid === state.pid) {
        delete this.state.projects[projectId];
        this.refreshState();
      }
    });
    this.refreshState();
    return state;
  }

  private async waitForProjectServiceReady(
    resolvedRoot: string,
    projectId: string,
    state: ProjectServiceState,
  ): Promise<ProjectServiceState> {
    const deadline = Date.now() + PROJECT_SERVICE_STARTUP_GRACE_MS;
    let lastError = "metadata endpoint was not written";
    while (Date.now() < deadline) {
      if (!isPidAlive(state.pid)) {
        throw new Error(`project service exited before it became ready: pid ${state.pid}`);
      }
      const endpoint = loadMetadataEndpoint(resolvedRoot);
      if (!endpoint) {
        await sleep(PROJECT_SERVICE_READY_POLL_MS);
        continue;
      }
      if (endpoint.pid !== state.pid) {
        lastError = `metadata endpoint pid ${endpoint.pid} did not match spawned pid ${state.pid}`;
        await sleep(PROJECT_SERVICE_READY_POLL_MS);
        continue;
      }
      try {
        const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}/health`, {
          timeoutMs: PROJECT_SERVICE_HEALTH_TIMEOUT_MS,
        });
        if (status >= 200 && status < 300 && json?.ok !== false && json?.pid === state.pid) {
          if (manifestsMatch(getProjectServiceManifest(), json?.serviceInfo)) {
            return {
              ...state,
              updatedAt: new Date().toISOString(),
            };
          }
          lastError = "health manifest did not match current build";
        } else {
          lastError = json?.error || `health request failed: ${status}`;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(PROJECT_SERVICE_READY_POLL_MS);
    }
    throw new Error(`project service did not become ready: ${lastError}`);
  }

  private async spawnReadyProjectService(resolvedRoot: string, projectId: string): Promise<ProjectServiceState> {
    const spawned = this.spawnProjectService(resolvedRoot, projectId);
    try {
      const ready = await this.waitForProjectServiceReady(resolvedRoot, projectId, spawned);
      this.state.projects[projectId] = ready;
      this.refreshState();
      return ready;
    } catch (error) {
      log.warn("spawned project service failed readiness check", "daemon", {
        projectId,
        projectRoot: resolvedRoot,
        pid: spawned.pid,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.terminateProjectService(projectId, spawned);
      const current = this.state.projects[projectId];
      if (current?.pid === spawned.pid) {
        delete this.state.projects[projectId];
        this.refreshState();
      }
      throw error;
    }
  }

  private async ensureProject(projectRoot: string): Promise<ProjectServiceState> {
    const resolvedRoot = pathResolve(projectRoot);
    const projectId = getProjectIdFor(resolvedRoot);
    const existingEnsure = this.projectEnsurePromises.get(projectId);
    if (existingEnsure) return existingEnsure;

    const ensure = this.ensureProjectUnlocked(resolvedRoot, projectId).finally(() => {
      if (this.projectEnsurePromises.get(projectId) === ensure) {
        this.projectEnsurePromises.delete(projectId);
      }
    });
    this.projectEnsurePromises.set(projectId, ensure);
    return ensure;
  }

  private async ensureProjectUnlocked(resolvedRoot: string, projectId: string): Promise<ProjectServiceState> {
    const existing = this.state.projects[projectId];
    if (existing && isPidAlive(existing.pid)) {
      const startedAtMs = Date.parse(existing.startedAt);
      const withinStartupGrace =
        Number.isFinite(startedAtMs) && Date.now() - startedAtMs < PROJECT_SERVICE_STARTUP_GRACE_MS;
      const refreshExisting = (): ProjectServiceState => {
        const next = {
          ...existing,
          updatedAt: new Date().toISOString(),
        };
        this.state.projects[projectId] = next;
        this.refreshState();
        return next;
      };
      const waitForExistingReady = async (): Promise<ProjectServiceState> => {
        try {
          const ready = await this.waitForProjectServiceReady(resolvedRoot, projectId, existing);
          this.projectHealthFailures.delete(projectId);
          this.state.projects[projectId] = ready;
          this.refreshState();
          return ready;
        } catch (error) {
          log.warn("just-started project service failed readiness check", "daemon", {
            projectId,
            projectRoot: resolvedRoot,
            pid: existing.pid,
            error: error instanceof Error ? error.message : String(error),
          });
          return this.replaceProjectServiceAfterExit(resolvedRoot, projectId, existing, refreshExisting);
        }
      };
      const endpoint = loadMetadataEndpoint(resolvedRoot);
      if (!endpoint) {
        if (withinStartupGrace) {
          return waitForExistingReady();
        }
        log.warn("project service missing metadata endpoint after startup grace", "daemon", {
          projectId,
          projectRoot: resolvedRoot,
          pid: existing.pid,
        });
        return this.replaceProjectServiceAfterExit(resolvedRoot, projectId, existing, refreshExisting);
      }
      try {
        if (endpoint.pid !== existing.pid) {
          if (withinStartupGrace) return waitForExistingReady();
          log.warn("project service metadata endpoint pid mismatch", "daemon", {
            projectId,
            projectRoot: resolvedRoot,
            pid: existing.pid,
            endpointPid: endpoint.pid,
          });
          return this.replaceProjectServiceAfterExit(resolvedRoot, projectId, existing, refreshExisting);
        }
        const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}/health`, {
          timeoutMs: PROJECT_SERVICE_HEALTH_TIMEOUT_MS,
        });
        if (status < 200 || status >= 300 || json?.ok === false) {
          throw new Error(json?.error || `health request failed: ${status}`);
        }
        if (json?.pid !== existing.pid) {
          if (withinStartupGrace) return waitForExistingReady();
          log.warn("project service health pid mismatch", "daemon", {
            projectId,
            projectRoot: resolvedRoot,
            pid: existing.pid,
            healthPid: json?.pid,
          });
          return this.replaceProjectServiceAfterExit(resolvedRoot, projectId, existing, refreshExisting);
        }
        const expectedManifest = getProjectServiceManifest();
        if (!manifestsMatch(expectedManifest, json?.serviceInfo)) {
          log.warn("project service manifest mismatch", "daemon", {
            projectId,
            projectRoot: resolvedRoot,
            pid: existing.pid,
            expected: expectedManifest,
            actual: json.serviceInfo,
          });
          return this.replaceProjectServiceAfterExit(resolvedRoot, projectId, existing, refreshExisting);
        }
      } catch (error) {
        if (withinStartupGrace) {
          return waitForExistingReady();
        }
        const failures = (this.projectHealthFailures.get(projectId) ?? 0) + 1;
        this.projectHealthFailures.set(projectId, failures);
        log.warn("project service health check failed", "daemon", {
          projectId,
          projectRoot: resolvedRoot,
          pid: existing.pid,
          error: error instanceof Error ? error.message : String(error),
          consecutiveFailures: failures,
          threshold: PROJECT_SERVICE_HEALTH_FAILURE_THRESHOLD,
        });
        // Tolerate transient stalls; only restart after sustained failures.
        if (failures < PROJECT_SERVICE_HEALTH_FAILURE_THRESHOLD) {
          return refreshExisting();
        }
        // The counter is reset by spawnProjectService once a replacement
        // actually starts; if termination fails we keep the debt and retry.
        return this.replaceProjectServiceAfterExit(resolvedRoot, projectId, existing, refreshExisting);
      }
      this.projectHealthFailures.delete(projectId);
      return refreshExisting();
    }
    return this.spawnReadyProjectService(resolvedRoot, projectId);
  }

  private async replaceProjectServiceAfterExit(
    resolvedRoot: string,
    projectId: string,
    existing: ProjectServiceState,
    refreshExisting: () => ProjectServiceState,
  ): Promise<ProjectServiceState> {
    const stopped = await this.terminateProjectService(projectId, existing);
    if (!stopped) {
      log.warn("project service did not exit before replacement deadline", "daemon", {
        projectId,
        projectRoot: resolvedRoot,
        pid: existing.pid,
      });
      return refreshExisting();
    }
    const current = this.state.projects[projectId];
    if (current?.pid === existing.pid) {
      delete this.state.projects[projectId];
    }
    const child = this.children.get(projectId);
    if (child?.pid === existing.pid) {
      this.children.delete(projectId);
    }
    this.refreshState();
    return this.spawnReadyProjectService(resolvedRoot, projectId);
  }

  private async terminateProjectService(projectId: string, existing: ProjectServiceState): Promise<boolean> {
    const child = this.children.get(projectId);
    const trackedChild = child?.pid === existing.pid;
    if (!trackedChild && !isAimuxProjectServiceProcess(existing.pid, existing)) {
      log.warn("skipping unverified project service pid during replacement", "daemon", {
        projectId,
        projectRoot: existing.projectRoot,
        pid: existing.pid,
      });
      return true;
    }
    log.info("terminating project service", "daemon", {
      projectId,
      projectRoot: existing.projectRoot,
      pid: existing.pid,
    });
    try {
      process.kill(existing.pid, "SIGTERM");
    } catch {
      return true;
    }
    if (await this.waitForProjectServiceExit(existing.pid, child, PROJECT_SERVICE_TERM_GRACE_MS)) {
      return true;
    }
    try {
      process.kill(existing.pid, "SIGKILL");
    } catch {
      return true;
    }
    return this.waitForProjectServiceExit(existing.pid, child, PROJECT_SERVICE_KILL_GRACE_MS);
  }

  private async waitForProjectServiceExit(
    pid: number,
    child: ChildProcess | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!isPidAlive(pid)) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const cleanups: Array<() => void> = [];

      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        for (const cleanup of cleanups) cleanup();
        resolve(value);
      };

      const onExit = () => finish(true);
      if (child) {
        child.once("exit", onExit);
        cleanups.push(() => child.off("exit", onExit));
      }
      const interval = setInterval(() => {
        if (!isPidAlive(pid)) finish(true);
      }, PROJECT_SERVICE_EXIT_POLL_MS);
      cleanups.push(() => clearInterval(interval));
      const timeout = setTimeout(() => finish(!isPidAlive(pid)), timeoutMs);
      cleanups.push(() => clearTimeout(timeout));
    });
  }

  private stopProject(projectRoot: string): ProjectServiceState | null {
    const projectId = getProjectIdFor(pathResolve(projectRoot));
    const existing = this.state.projects[projectId];
    if (!existing) return null;
    const child = this.children.get(projectId);
    const trackedChild = child?.pid === existing.pid;
    if (trackedChild || isAimuxProjectServiceProcess(existing.pid, existing)) {
      try {
        process.kill(existing.pid, "SIGTERM");
      } catch {}
    } else {
      log.warn("skipping unverified project service pid during project stop", "daemon", {
        projectId,
        projectRoot: existing.projectRoot,
        pid: existing.pid,
      });
    }
    delete this.state.projects[projectId];
    this.projectHealthFailures.delete(projectId);
    if (this.children.get(projectId)?.pid === existing.pid) {
      this.children.delete(projectId);
    }
    this.refreshState();
    return existing;
  }

  async routeRequest(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    this.refreshState();
    const routeUrl = new URL(path, getDaemonBaseUrl());
    const pathname = routeUrl.pathname;
    const actor = parseRemoteActor(headers);
    const access = assertRemoteAccessAllowed(actor, method, pathname, routeUrl.searchParams);
    if (!access.ok) {
      return { status: access.status ?? 403, body: { ok: false, error: access.error ?? "remote access denied" } };
    }

    if (method === "GET" && pathname === "/health") {
      return {
        status: 200,
        body: {
          ok: true,
          kind: DAEMON_HEALTH_KIND,
          pid: process.pid,
          port: getDaemonPort(),
          serviceInfo: getProjectServiceManifest(),
        },
      };
    }

    if (method === "GET" && pathname === "/relay/status") {
      return { status: 200, body: { ok: true, relay: this.getRelayStatus() } };
    }

    if (method === "POST" && pathname === "/relay/enable") {
      return { status: 200, body: { ok: true, relay: this.enableRelay() } };
    }

    if (method === "POST" && pathname === "/relay/disable") {
      return { status: 200, body: { ok: true, relay: this.disableRelay() } };
    }

    if (method === "POST" && pathname === "/internal/push") {
      if (actor) return { status: 403, body: { ok: false, error: "internal route is loopback-only" } };
      const payload = body as RelayNotificationPush | undefined;
      if (!payload?.title) return { status: 400, body: { ok: false, error: "title is required" } };
      if (this.relayClient?.getStatus().status !== "connected") {
        return { status: 200, body: { ok: true, suppressed: true, reason: "relay_unavailable" } };
      }
      if (!this.pushThrottle.allow(payload)) return { status: 200, body: { ok: true, suppressed: true } };
      this.relayClient.pushNotification(payload);
      return { status: 200, body: { ok: true } };
    }

    if (method === "GET" && pathname === "/projects") {
      const liveById = this.state.projects;
      const projects = listDesktopProjects().map((project) => ({
        ...project,
        service: liveById[project.id] ?? null,
        serviceAlive: Boolean(liveById[project.id]),
        serviceEndpoint: project.path ? loadMetadataEndpoint(project.path) : null,
      }));
      return { status: 200, body: { ok: true, projects } };
    }

    if (method === "GET" && pathname.startsWith("/projects/")) {
      const projectId = decodeURIComponent(pathname.slice("/projects/".length));
      const project = this.state.projects[projectId] ?? null;
      return { status: 200, body: { ok: true, project } };
    }

    if (method === "POST" && pathname === "/projects/ensure") {
      const b = body as { projectRoot?: string } | undefined;
      if (!b?.projectRoot) {
        return { status: 400, body: { ok: false, error: "projectRoot is required" } };
      }
      const project = await this.ensureProject(b.projectRoot);
      return { status: 200, body: { ok: true, project } };
    }

    if (method === "POST" && pathname === "/projects/stop") {
      const b = body as { projectRoot?: string } | undefined;
      if (!b?.projectRoot) {
        return { status: 400, body: { ok: false, error: "projectRoot is required" } };
      }
      const project = this.stopProject(b.projectRoot);
      return { status: 200, body: { ok: true, project } };
    }

    const proxyMatch = pathname.match(/^\/proxy\/([^/]+)\/(\d+)(\/.*)/);
    if (proxyMatch) {
      const [, host, portStr, subPath] = proxyMatch;
      if (!PROXY_ALLOWED_HOSTS.has(host)) {
        return { status: 403, body: { ok: false, error: "proxy host not allowed" } };
      }
      try {
        const { status, json } = await requestJson(`http://${host}:${portStr}${subPath}${routeUrl.search}`, {
          method,
          headers,
          body: body !== undefined ? body : undefined,
          timeoutMs: PROXY_TIMEOUT_MS,
        });
        return { status, body: json };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Proxy error";
        const status = /timed? out|timeout/i.test(message) ? 504 : 502;
        return { status, body: { ok: false, error: message } };
      }
    }

    return { status: 404, body: { ok: false, error: "not found" } };
  }

  resolveProjectEventStream(
    path: string,
    headers?: Record<string, string>,
  ): { ok: true; url: string; headers?: Record<string, string> } | { ok: false; status: number; error: string } {
    this.refreshState();
    const routeUrl = new URL(path, getDaemonBaseUrl());
    const pathname = routeUrl.pathname;
    const actor = parseRemoteActor(headers);
    const access = assertRemoteAccessAllowed(actor, "GET", pathname, routeUrl.searchParams);
    if (!access.ok) {
      return { ok: false, status: access.status ?? 403, error: access.error ?? "remote access denied" };
    }

    const proxyMatch = pathname.match(/^\/proxy\/([^/]+)\/(\d+)(\/.*)/);
    if (!proxyMatch) return { ok: false, status: 404, error: "project event stream not found" };
    const [, host, portStr, subPath] = proxyMatch;
    if (!PROXY_ALLOWED_HOSTS.has(host)) {
      return { ok: false, status: 403, error: "proxy host not allowed" };
    }
    if (subPath !== PROJECT_API_ROUTES.events) {
      return { ok: false, status: 403, error: "route is not a project event stream" };
    }
    return {
      ok: true,
      url: `http://${host}:${portStr}${subPath}${routeUrl.search}`,
      headers,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // No auth on the HTTP server: the daemon binds to 127.0.0.1, and remote
    // app requests come in over the relay (which performs Clerk/HS256 verify
    // before forwarding) and call routeRequest() directly in-process. Local
    // CLI is trusted with the daemon's user.
    if (!setCorsHeaders(req, res)) {
      rejectCors(res);
      return;
    }
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", getDaemonBaseUrl());
    const body = req.method === "POST" ? await readJson(req) : undefined;
    const result = await this.routeRequest(req.method ?? "GET", `${url.pathname}${url.search}`, body);
    send(res, result.status, result.body);
  }
}
