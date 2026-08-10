import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { getAimuxProjectServiceLaunchCommand } from "./cli-launcher.js";
import { initProject } from "./config.js";
import { getLoggingConfig, log } from "./debug.js";
import { removeMetadataEndpoint } from "./metadata-store.js";
import { ensureProjectPaths, getProjectIdFor, getProjectLogPathFor, withProjectPaths } from "./paths.js";
import { isPidAlive } from "./process-inspector.js";

const CORE_PROJECT_ACTOR_STOP_TIMEOUT_MS = 2_000;
const CORE_PROJECT_ACTOR_KILL_TIMEOUT_MS = 1_500;
const CORE_PROJECT_ACTOR_RESTART_INITIAL_MS = 250;
const CORE_PROJECT_ACTOR_RESTART_MAX_MS = 5_000;

export type CoreProjectActorStatus = "stopped" | "starting" | "running" | "restarting";

export interface CoreProjectActorExitState {
  at: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
}

export interface CoreProjectActorState {
  projectId: string;
  projectRoot: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  status: CoreProjectActorStatus;
  restartCount: number;
  lastRestartAt?: string;
  lastExit?: CoreProjectActorExitState;
}

export interface CoreProjectActorOptions {
  onStateChange?: (state: CoreProjectActorState) => void;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function childEnv(projectId: string, projectRoot: string): NodeJS.ProcessEnv {
  const logging = getLoggingConfig();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIMUX_PROJECT_ID: projectId,
    AIMUX_PROJECT_ROOT: projectRoot,
  };
  if (!logging.enabled) return env;
  return {
    ...env,
    AIMUX_LOG: "1",
    AIMUX_LOG_LEVEL: logging.level,
    AIMUX_LOG_CATEGORIES: logging.categories.join(","),
  };
}

function childStdio(path: string): { stdio: StdioOptions; close: () => void } {
  const logging = getLoggingConfig();
  if (!logging.enabled) return { stdio: "ignore", close: () => {} };
  try {
    ensureParent(path);
    const stdout = openSync(path, "a");
    const stderr = openSync(path, "a");
    let closed = false;
    return {
      stdio: ["ignore", stdout, stderr],
      close: () => {
        if (closed) return;
        closed = true;
        closeSync(stdout);
        closeSync(stderr);
      },
    };
  } catch {
    return { stdio: "ignore", close: () => {} };
  }
}

function restartDelayMs(restartCount: number): number {
  return Math.min(CORE_PROJECT_ACTOR_RESTART_MAX_MS, CORE_PROJECT_ACTOR_RESTART_INITIAL_MS * 2 ** restartCount);
}

function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (!isPidAlive(pid)) return Promise.resolve(true);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (!isPidAlive(pid)) finish(true);
      else if (Date.now() >= deadline) finish(!isPidAlive(pid));
    }, 50);
    const finish = (exited: boolean) => {
      clearInterval(interval);
      resolve(exited);
    };
  });
}

export class CoreProjectActor {
  private child: ChildProcess | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRun = false;
  private readonly state: CoreProjectActorState;
  private readonly onStateChange?: (state: CoreProjectActorState) => void;

  constructor(projectRoot: string, options: CoreProjectActorOptions = {}) {
    const resolvedRoot = pathResolve(projectRoot);
    const now = new Date().toISOString();
    this.state = {
      projectId: getProjectIdFor(resolvedRoot),
      projectRoot: resolvedRoot,
      pid: 0,
      startedAt: now,
      updatedAt: now,
      status: "stopped",
      restartCount: 0,
    };
    this.onStateChange = options.onStateChange;
  }

  getState(): CoreProjectActorState {
    return { ...this.state, updatedAt: new Date().toISOString() };
  }

  isRunning(): boolean {
    if (!this.child || !this.state.pid) return false;
    if (isPidAlive(this.state.pid)) return true;
    this.child = null;
    this.state.status = this.shouldRun ? "restarting" : "stopped";
    this.publishState();
    return false;
  }

  ensureEndpointPublished(): void {
    // The standalone project service owns endpoint publication.
  }

  async start(): Promise<CoreProjectActorState> {
    if (this.isRunning()) return this.getState();
    await withProjectPaths(this.state.projectRoot, async () => {
      ensureProjectPaths();
      initProject();
    });
    this.shouldRun = true;
    this.clearRestartTimer();
    this.spawnChild("start");
    return this.getState();
  }

  async stop(): Promise<void> {
    this.shouldRun = false;
    this.clearRestartTimer();
    await this.signalChild("SIGTERM", CORE_PROJECT_ACTOR_STOP_TIMEOUT_MS, true);
    this.child = null;
    this.state.pid = 0;
    this.state.status = "stopped";
    this.state.updatedAt = new Date().toISOString();
    removeMetadataEndpoint(this.state.projectRoot);
    this.publishState();
    log.info("stopped core project actor", "daemon", {
      projectId: this.state.projectId,
      projectRoot: this.state.projectRoot,
    });
  }

  async kill(): Promise<void> {
    this.shouldRun = false;
    this.clearRestartTimer();
    await this.signalChild("SIGKILL", CORE_PROJECT_ACTOR_KILL_TIMEOUT_MS, true);
    this.child = null;
    this.state.pid = 0;
    this.state.status = "stopped";
    this.state.updatedAt = new Date().toISOString();
    removeMetadataEndpoint(this.state.projectRoot);
    this.publishState();
    log.warn("force-stopped core project actor", "daemon", {
      projectId: this.state.projectId,
      projectRoot: this.state.projectRoot,
    });
  }

  private spawnChild(reason: "start" | "restart"): void {
    this.state.status = reason === "restart" ? "restarting" : "starting";
    this.state.updatedAt = new Date().toISOString();
    this.publishState();

    const launch = getAimuxProjectServiceLaunchCommand(this.state.projectId, this.state.projectRoot);
    const stdio = childStdio(getProjectLogPathFor(this.state.projectRoot));
    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: this.state.projectRoot,
        env: childEnv(this.state.projectId, this.state.projectRoot),
        stdio: stdio.stdio,
      });
    } catch (error) {
      stdio.close();
      this.state.status = "stopped";
      this.state.pid = 0;
      this.state.updatedAt = new Date().toISOString();
      removeMetadataEndpoint(this.state.projectRoot);
      this.publishState();
      throw error;
    }

    const pid = child.pid;
    if (!pid) {
      stdio.close();
      this.state.status = "stopped";
      this.state.pid = 0;
      this.state.updatedAt = new Date().toISOString();
      removeMetadataEndpoint(this.state.projectRoot);
      this.publishState();
      throw new Error("project service process did not expose a pid");
    }

    child.once("exit", stdio.close);
    child.once("exit", (code, signal) => this.onChildExit(child, code, signal));
    child.once("error", (error) => {
      log.warn("project service process emitted an error", "daemon", {
        projectId: this.state.projectId,
        projectRoot: this.state.projectRoot,
        pid,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.unref();

    const now = new Date().toISOString();
    this.child = child;
    this.state.pid = pid;
    this.state.status = "running";
    this.state.startedAt = now;
    this.state.updatedAt = now;
    if (reason === "restart") this.state.lastRestartAt = now;
    this.publishState();
    log.info("started core project actor", "daemon", {
      projectId: this.state.projectId,
      projectRoot: this.state.projectRoot,
      pid,
      reason,
    });
  }

  private onChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    const expected = !this.shouldRun;
    this.child = null;
    this.state.lastExit = {
      at: new Date().toISOString(),
      code,
      signal,
      expected,
    };
    this.state.updatedAt = this.state.lastExit.at;
    if (expected) {
      this.state.pid = 0;
      this.state.status = "stopped";
      this.publishState();
      return;
    }

    this.state.status = "restarting";
    this.state.restartCount += 1;
    removeMetadataEndpoint(this.state.projectRoot);
    this.publishState();
    const delayMs = restartDelayMs(this.state.restartCount - 1);
    log.warn("project service exited unexpectedly; scheduling restart", "daemon", {
      projectId: this.state.projectId,
      projectRoot: this.state.projectRoot,
      pid: this.state.pid,
      code,
      signal,
      restartCount: this.state.restartCount,
      delayMs,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.shouldRun || this.child) return;
      this.spawnChild("restart");
    }, delayMs);
  }

  private async signalChild(signal: NodeJS.Signals, timeoutMs: number, expected: boolean): Promise<void> {
    const pid = this.state.pid;
    if (!pid || !isPidAlive(pid)) return;
    try {
      process.kill(pid, signal);
    } catch {}
    const exited = await waitForExit(pid, timeoutMs);
    if (exited || signal === "SIGKILL") return;
    log.warn("project service did not stop after SIGTERM; killing", "daemon", {
      projectId: this.state.projectId,
      projectRoot: this.state.projectRoot,
      pid,
    });
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    await waitForExit(pid, CORE_PROJECT_ACTOR_KILL_TIMEOUT_MS);
    if (expected) {
      this.state.lastExit = {
        at: new Date().toISOString(),
        code: null,
        signal: "SIGKILL",
        expected,
      };
    }
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private publishState(): void {
    this.onStateChange?.(this.getState());
  }
}
