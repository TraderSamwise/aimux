import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { getDaemonStdioLogPath, getGlobalAimuxDir, getProjectIdFor } from "./paths.js";
import { requestJson } from "./http-client.js";
import { getLoggingConfig, log } from "./debug.js";
import { getProjectServiceManifest, manifestsMatch } from "./project-service-manifest.js";
import { getAimuxDaemonLaunchCommand } from "./cli-launcher.js";
import { requestDaemonJson } from "./daemon-client.js";
import { isAimuxProjectServiceProcess, isPidAlive } from "./process-inspector.js";
import {
  clearDaemonInfo,
  getDaemonBaseUrl,
  getDaemonPort,
  loadDaemonInfo,
  loadDaemonState,
  saveDaemonInfo,
  saveDaemonState,
  type AimuxDaemonInfo,
  type EnsureDaemonRunningOptions,
  type ProjectServiceState,
  type StoppedDaemonInfo,
} from "./daemon-state.js";

const DAEMON_STARTUP_TIMEOUT_MS = 10_000;
const DAEMON_HEALTH_PROBE_TIMEOUT_MS = 2_500;
const DAEMON_HEALTH_KIND = "aimux-daemon";
const DAEMON_START_LOCK_STALE_MS = 30_000;
const DAEMON_PORT_TERMINATION_TIMEOUT_MS = 7_000;

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

function isAimuxDaemonHealth(json: any): boolean {
  return json?.kind === DAEMON_HEALTH_KIND && Number.isInteger(json?.pid) && json.pid > 0;
}

function isMatchingDaemonHealth(json: any): boolean {
  return isAimuxDaemonHealth(json) && manifestsMatch(getProjectServiceManifest(), json?.serviceInfo);
}

/**
 * Build stamps lead with the artifact mtime (`<mtimeMs>.<mtimeMs>-<hash>`), so the
 * leading number orders two local installs against each other.
 */
export function buildStampGeneration(stamp: unknown): number | null {
  const lead = String(stamp ?? "").split(".")[0] ?? "";
  const value = Number(lead);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** True when the daemon we found was built after the process asking about it. */
export function isStaleAgainstDaemon(daemonStamp: unknown, ownStamp: unknown): boolean {
  const daemon = buildStampGeneration(daemonStamp);
  const own = buildStampGeneration(ownStamp);
  if (daemon === null || own === null) return false;
  return daemon > own;
}

/**
 * Raised instead of replacing a daemon that is newer than this process.
 *
 * Replacing it can never converge: the replacement launches through the stable shim
 * and so comes back newer again, while this process keeps seeing a mismatch. Left
 * unguarded that is an unbounded restart loop, and every cycle tears down the
 * project service — which owns the Exposé socket, so the popup dies with it. The
 * stale side has to reload itself; it must not keep killing the daemon.
 */
export class StaleClientBuildError extends Error {
  constructor(
    readonly daemonBuildStamp: string,
    readonly clientBuildStamp: string,
  ) {
    super(
      `aimux daemon is a newer build (${daemonBuildStamp}) than this process (${clientBuildStamp}); ` +
        "reload this client instead of restarting the daemon",
    );
    this.name = "StaleClientBuildError";
  }
}

function assertNotStaleAgainstDaemon(json: any): void {
  const ownStamp = getProjectServiceManifest().buildStamp;
  const daemonStamp = json?.serviceInfo?.buildStamp;
  if (!isStaleAgainstDaemon(daemonStamp, ownStamp)) return;
  log.warn("refusing to replace a newer aimux daemon", "daemon", {
    pid: json?.pid,
    daemonBuildStamp: String(daemonStamp),
    clientBuildStamp: ownStamp,
  });
  throw new StaleClientBuildError(String(daemonStamp), ownStamp);
}

/**
 * Whether an unreachable daemon should be kept rather than replaced.
 *
 * Unreachable is not the same answer as gone. A health probe that times out says
 * only that the daemon did not answer inside its budget — and one slow request
 * blocks its whole event loop, so every client probing during it reaches the same
 * verdict and each starts a replacement. The replacement takes over, is equally
 * busy, and the next probe repeats it: a stall becomes a restart loop, and every
 * cycle tears down the project service.
 *
 * A live process is the evidence that settles it. Replacing one is for a daemon
 * that is actually gone, or for someone asking in so many words — `aimux restart`
 * passes `adoptExisting: false` and must still be able to stop a busy daemon.
 */
export function shouldKeepUnresponsiveDaemon(
  options: Pick<EnsureDaemonRunningOptions, "adoptExisting">,
  daemonPidAlive: boolean,
): boolean {
  return options.adoptExisting !== false && daemonPidAlive;
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

function isLockStale(lockPath: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return true;
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
  if (pid && isPidAlive(pid) && !isLockStale(lockPath, DAEMON_START_LOCK_STALE_MS)) return null;
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
      // Before the adopt/terminate split: a stale client must not take either branch.
      assertNotStaleAgainstDaemon(json);
      if (options.adoptExisting === false) {
        log.warn("terminating daemon on default port instead of adopting", "daemon", { pid: json.pid });
        await terminateDaemonOnDefaultPort(json.pid);
        clearDaemonInfo();
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
      saveDaemonInfo(adopted);
      log.info("adopted existing daemon on default port", "daemon", { ...adopted });
      return adopted;
    }
  } catch (error) {
    if (error instanceof StaleClientBuildError) throw error;
    if (error instanceof Error && error.message.includes("different local build")) {
      throw error;
    }
    log.debug("default daemon health probe failed", "daemon", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

async function readDefaultDaemonHealth(): Promise<any | null> {
  try {
    const { status, json } = await requestJson(`${getDaemonBaseUrl()}/health`, {
      timeoutMs: DAEMON_HEALTH_PROBE_TIMEOUT_MS,
    });
    if (status >= 200 && status < 300 && json?.ok !== false && isAimuxDaemonHealth(json)) return json;
  } catch {}
  return null;
}

async function terminateDaemonOnDefaultPort(pid: number): Promise<void> {
  const deadline = Date.now() + DAEMON_PORT_TERMINATION_TIMEOUT_MS;
  let targetPid = pid;
  while (Date.now() < deadline) {
    try {
      process.kill(targetPid, "SIGTERM");
    } catch {}
    if (!(await waitForPidExit(targetPid, 1_500))) {
      try {
        process.kill(targetPid, "SIGKILL");
      } catch {}
      await waitForPidExit(targetPid, 1_500);
    }
    const health = await readDefaultDaemonHealth();
    if (!health) return;
    targetPid = health.pid;
    await sleep(100);
  }
  throw new Error(`timed out terminating aimux daemon on default port pid=${targetPid}`);
}

export async function stopDaemonInfo(
  info: AimuxDaemonInfo,
  state = loadDaemonState(),
  signal: NodeJS.Signals = "SIGTERM",
): Promise<StoppedDaemonInfo> {
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
  saveDaemonState({
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: {},
  });
  clearDaemonInfo();
  return { ...info, stoppedProjectServices };
}

export async function stopDaemon(signal: NodeJS.Signals = "SIGTERM"): Promise<StoppedDaemonInfo | null> {
  const info = loadDaemonInfo();
  if (!info) return null;
  // A control-plane restart stops the daemon before it starts one, so this — not
  // ensureDaemonRunning — is the first place a stale client reaches a newer daemon.
  // Guarding only the start side let the kill through and then found nothing left to
  // refuse, which is the restart loop with an extra step.
  try {
    const health = await requestDaemonJson("/health", { timeoutMs: DAEMON_HEALTH_PROBE_TIMEOUT_MS });
    if (isAimuxDaemonHealth(health)) assertNotStaleAgainstDaemon(health);
  } catch (error) {
    // An unreachable daemon is not a reason to keep it; only a newer one is.
    if (error instanceof StaleClientBuildError) throw error;
  }
  return stopDaemonInfo(info, loadDaemonState(), signal);
}

export async function ensureDaemonRunning(options: EnsureDaemonRunningOptions = {}): Promise<AimuxDaemonInfo> {
  const existing = loadDaemonInfo();
  if (existing) {
    try {
      let health: any;
      try {
        health = await requestDaemonJson("/health", { timeoutMs: DAEMON_HEALTH_PROBE_TIMEOUT_MS });
      } catch (error) {
        if (shouldKeepUnresponsiveDaemon(options, isPidAlive(existing.pid))) {
          log.warn("keeping unresponsive daemon: its process is alive", "daemon", {
            pid: existing.pid,
            error: error instanceof Error ? error.message : String(error),
          });
          return existing;
        }
        throw error;
      }
      if (!isAimuxDaemonHealth(health)) {
        throw new Error("stored daemon health response does not identify Aimux");
      }
      if (health.pid !== existing.pid) {
        throw new Error(`stored daemon pid ${existing.pid} does not match live pid ${health?.pid ?? "unknown"}`);
      }
      assertNotStaleAgainstDaemon(health);
      if (options.adoptExisting === false) {
        log.warn("terminating stored daemon instead of adopting", "daemon", { pid: existing.pid });
        await terminateDaemonOnDefaultPort(existing.pid);
        clearDaemonInfo();
      } else if (!isMatchingDaemonHealth(health)) {
        throw new Error("stored daemon health response does not match this Aimux build");
      } else {
        return existing;
      }
    } catch (error) {
      // Falling through here starts a replacement daemon, which is exactly what a
      // stale client must not do.
      if (error instanceof StaleClientBuildError) throw error;
      log.warn("stored daemon info failed health check", "daemon", {
        pid: existing.pid,
        error: error instanceof Error ? error.message : String(error),
      });
      clearDaemonInfo();
    }
  }

  const probed = await probeDefaultDaemon(options);
  if (probed) return probed;

  let lockPath = tryAcquireDaemonStartLock();
  if (!lockPath) {
    const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // Adopt while waiting, even when the caller asked for a fresh daemon. The
      // point of waiting on this lock is to let the holder start one; carrying
      // `adoptExisting: false` in here instead terminates whatever it just started,
      // so the holder restarts, and the wait can only ever end in the timeout. The
      // daemon the caller wanted replaced was already stopped before we got here.
      const adopted = await probeDefaultDaemon({ ...options, adoptExisting: true });
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
      const launch = getAimuxDaemonLaunchCommand();
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
