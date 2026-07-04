import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { type AimuxDaemonInfo, type ProjectServiceState, type StoppedDaemonInfo } from "./daemon-state.js";
import { resolveDashboardTarget } from "./dashboard/targets.js";
import {
  buildRuntimeCoherenceReport,
  renderRuntimeCoherenceReport,
  type BuildRuntimeCoherenceReportOptions,
  type RuntimeCoherenceReport,
} from "./runtime-coherence.js";
import {
  AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
  TMUX_RUNTIME_CONTRACT_OPTION,
  TMUX_RUNTIME_REBUILD_REQUIRED_OPTION,
  TMUX_RUNTIME_OWNER_OPTION,
} from "./runtime-owner.js";
import { isDashboardWindowName, TmuxRuntimeManager, type TmuxTarget } from "./tmux/runtime-manager.js";
import { isTmuxClientSessionForHost } from "./tmux/session-names.js";
import { defaultRepairNotifier, type RepairEvent, type RepairNotifier } from "./repair-events.js";
import { getGlobalAimuxDir } from "./paths.js";
import {
  isAimuxProjectServiceProcess as defaultIsAimuxProjectServiceProcess,
  isPidAlive as defaultIsPidAlive,
  type ProjectServiceProcessIdentity,
} from "./process-inspector.js";

export { isExitedProcessState } from "./process-inspector.js";

export type RuntimeRestartStepStatus = "ensured" | "reloaded" | "repaired" | "skipped" | "failed";
const RUNTIME_RESTART_LOCK_STALE_MS = 120_000;

export interface RuntimeRestartProjectResult {
  projectRoot: string;
  runtimeRebuildRequired: boolean;
  runtime: {
    status: RuntimeRestartStepStatus;
    error: string | null;
  };
  service: {
    status: RuntimeRestartStepStatus;
    state: ProjectServiceState | null;
    error: string | null;
  };
  dashboard: {
    status: RuntimeRestartStepStatus;
    sessionName: string | null;
    target: TmuxTarget | null;
    error: string | null;
  };
}

export interface RuntimeRestartResult {
  startedAt: string;
  finishedAt: string;
  before: RuntimeCoherenceReport;
  verification: {
    status: "ok" | "failed" | "skipped";
    after: RuntimeCoherenceReport | null;
    error: string | null;
  };
  daemon: {
    previous: AimuxDaemonInfo | null;
    current: AimuxDaemonInfo;
  };
  projects: RuntimeRestartProjectResult[];
  summary: {
    projects: number;
    servicesEnsured: number;
    runtimeRepairs: number;
    dashboardsReloaded: number;
    runtimeRebuildRequired: number;
    failures: number;
  };
}

type RuntimeRestartTmux = Pick<TmuxRuntimeManager, "isAvailable"> &
  Partial<
    Pick<
      TmuxRuntimeManager,
      | "getProjectSession"
      | "hasWindow"
      | "listSessionNames"
      | "listWindows"
      | "linkWindowToSession"
      | "killWindow"
      | "selectWindow"
      | "setSessionOption"
      | "getSessionOption"
      | "configureManagedSession"
      | "unlinkWindow"
    >
  >;

interface RuntimeRestartDashboardTarget {
  dashboardSession: { sessionName: string };
  dashboardTarget: TmuxTarget;
}

const POST_RESTART_VERIFICATION_TIMEOUT_MS = 15_000;

export interface RestartAimuxControlPlaneOptions {
  projectRoot?: string;
  now?: () => Date;
  coherence?: BuildRuntimeCoherenceReportOptions;
  buildRuntimeCoherenceReport?: typeof buildRuntimeCoherenceReport;
  stopDaemon?: StopDaemonFn;
  ensureDaemonRunning?: EnsureDaemonRunningFn;
  ensureProjectService?: EnsureProjectServiceFn;
  stopProjectService?: StopProjectServiceFn;
  createTmux?: () => RuntimeRestartTmux;
  resolveDashboardTarget?: (
    projectRoot: string,
    tmux: RuntimeRestartTmux,
    options: { forceReload: true; openInHostSession: true },
  ) => RuntimeRestartDashboardTarget;
  isPidAlive?: (pid: number) => boolean;
  isAimuxProjectServiceProcess?: (pid: number, expected?: ProjectServiceIdentity) => boolean;
  sleep?: (ms: number) => Promise<void>;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  daemonExitTimeoutMs?: number;
  serviceExitTimeoutMs?: number;
  killGraceMs?: number;
  verifyAfterRestart?: boolean;
  verificationTimeoutMs?: number;
  verificationIntervalMs?: number;
  repairNotifier?: RepairNotifier | null;
  reloadDashboards?: boolean;
  verifyDashboards?: boolean;
  abortSignal?: AbortSignal;
}

type StopDaemonFn = () => Promise<StoppedDaemonInfo | null>;
type EnsureDaemonRunningFn = () => Promise<AimuxDaemonInfo>;
type EnsureProjectServiceFn = (projectRoot: string) => Promise<ProjectServiceState>;
type StopProjectServiceFn = (projectRoot: string) => Promise<ProjectServiceState | null>;

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restartAbortError(): Error {
  return new Error("aimux restart aborted");
}

async function defaultStopDaemon(): Promise<StoppedDaemonInfo | null> {
  const { stopDaemon } = await import("./daemon-supervisor.js");
  return stopDaemon();
}

async function defaultEnsureDaemonRunning(): Promise<AimuxDaemonInfo> {
  const { ensureDaemonRunning } = await import("./daemon-supervisor.js");
  return ensureDaemonRunning();
}

async function defaultEnsureProjectService(projectRoot: string): Promise<ProjectServiceState> {
  const { ensureProjectService } = await import("./daemon-supervisor.js");
  return ensureProjectService(projectRoot);
}

async function defaultStopProjectService(projectRoot: string): Promise<ProjectServiceState | null> {
  const { stopProjectService } = await import("./daemon-supervisor.js");
  return stopProjectService(projectRoot);
}

function throwIfRestartAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw restartAbortError();
}

function runtimeRestartLockPath(): string {
  return pathResolve(getGlobalAimuxDir(), "locks", "restart");
}

function runtimeRestartStealLockPath(): string {
  return pathResolve(getGlobalAimuxDir(), "locks", "restart.steal");
}

function readRuntimeRestartLockPid(lockPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(joinLockOwnerPath(lockPath), "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

function tryAcquireRuntimeRestartStealLock(): string | null {
  const stealPath = runtimeRestartStealLockPath();
  const writeOwner = (): boolean => {
    try {
      writeFileSync(
        joinLockOwnerPath(stealPath),
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      );
      return true;
    } catch {
      rmSync(stealPath, { recursive: true, force: true });
      return false;
    }
  };
  try {
    mkdirSync(stealPath, { recursive: false });
    if (!writeOwner()) return null;
    return stealPath;
  } catch {
    try {
      if (Date.now() - statSync(stealPath).mtimeMs > RUNTIME_RESTART_LOCK_STALE_MS) {
        rmSync(stealPath, { recursive: true, force: true });
        mkdirSync(stealPath, { recursive: false });
        if (!writeOwner()) return null;
        return stealPath;
      }
    } catch {
      if (!existsSync(stealPath)) return tryAcquireRuntimeRestartStealLock();
    }
    return null;
  }
}

function tryAcquireRuntimeRestartLock(isPidAlive: (pid: number) => boolean): string | null {
  const lockPath = runtimeRestartLockPath();
  const acquire = (): string | null => {
    try {
      mkdirSync(pathResolve(getGlobalAimuxDir(), "locks"), { recursive: true });
      mkdirSync(lockPath, { recursive: false });
      try {
        writeFileSync(
          joinLockOwnerPath(lockPath),
          `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        );
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return lockPath;
    } catch {
      return null;
    }
  };
  const acquired = acquire();
  if (acquired) return acquired;
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > RUNTIME_RESTART_LOCK_STALE_MS) {
      const stealPath = tryAcquireRuntimeRestartStealLock();
      if (!stealPath) return null;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs <= RUNTIME_RESTART_LOCK_STALE_MS) return null;
        const ownerPid = readRuntimeRestartLockPid(lockPath);
        if (ownerPid !== null && isPidAlive(ownerPid)) return null;
        rmSync(lockPath, { recursive: true, force: true });
        return acquire();
      } finally {
        rmSync(stealPath, { recursive: true, force: true });
      }
    }
  } catch {
    if (!existsSync(lockPath)) return acquire();
  }
  return null;
}

function joinLockOwnerPath(lockPath: string): string {
  return pathResolve(lockPath, "owner.json");
}

function releaseRuntimeRestartLock(lockPath: string | null): void {
  if (!lockPath) return;
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {}
}

function emptyProjectResult(projectRoot: string): RuntimeRestartProjectResult {
  return {
    projectRoot,
    runtimeRebuildRequired: false,
    runtime: {
      status: "skipped",
      error: null,
    },
    service: {
      status: "skipped",
      state: null,
      error: null,
    },
    dashboard: {
      status: "skipped",
      sessionName: null,
      target: null,
      error: null,
    },
  };
}

function reconcileProjectResultsWithVerification(
  projects: RuntimeRestartProjectResult[],
  verification: RuntimeRestartResult["verification"],
): void {
  if (verification.status !== "ok" || !verification.after) return;
  for (const result of projects) {
    if (result.service.status !== "failed") continue;
    const verifiedProject = verification.after.projects.find((project) => project.projectRoot === result.projectRoot);
    if (verifiedProject?.service.status !== "ok") continue;
    result.service.status = "ensured";
    result.service.state = verifiedProject.service.daemonState ?? result.service.state;
    result.service.error = null;
  }
}

function selectProjectRoots(before: RuntimeCoherenceReport, projectRoot?: string): string[] {
  if (projectRoot) return uniqueSorted([projectRoot]);
  const roots = before.projects.map((project) => project.projectRoot);
  return uniqueSorted(roots);
}

function projectNeedsCurrentRuntimeRepair(
  project: RuntimeCoherenceReport["projects"][number],
  options: { verifyDashboards: boolean },
): boolean {
  if (project.runtime.rebuildRequired) return true;
  if (project.service.status !== "ok") return true;
  if (!options.verifyDashboards) return false;
  return project.dashboards.some((dashboard) => dashboard.status !== "ok");
}

function selectDashboardProjectRoots(before: RuntimeCoherenceReport, projectRoot?: string): Set<string> {
  if (projectRoot) return new Set([projectRoot]);
  return new Set(
    before.projects
      .filter(
        (project) =>
          (project.dashboards.length === 0 && project.sources.includes("tmux")) || project.dashboards.length > 0,
      )
      .map((project) => project.projectRoot),
  );
}

function selectRuntimeRepairProjectRoots(before: RuntimeCoherenceReport): Set<string> {
  return new Set(
    before.projects.filter((project) => project.runtime.rebuildRequired).map((project) => project.projectRoot),
  );
}

export function cleanupStaleDashboardLinks(
  tmux: Pick<TmuxRuntimeManager, "listWindows" | "unlinkWindow"> & Partial<Pick<TmuxRuntimeManager, "killWindow">>,
  sessionName: string,
  linkedDashboard: TmuxTarget,
): string[] {
  const errors: string[] = [];
  for (const window of tmux.listWindows(sessionName)) {
    if (!isDashboardWindowName(window.name) || window.id === linkedDashboard.windowId) continue;
    const staleTarget = {
      sessionName,
      windowId: window.id,
      windowIndex: window.index,
      windowName: window.name,
    };
    try {
      tmux.unlinkWindow(staleTarget);
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes("only linked to one session") && tmux.killWindow) {
        try {
          tmux.killWindow(staleTarget);
          continue;
        } catch (killError) {
          errors.push(`${window.id}: ${errorMessage(killError)}`);
          continue;
        }
      }
      errors.push(`${window.id}: ${errorMessage(error)}`);
    }
  }
  return errors;
}

function relinkDashboardToClientSessions(
  projectRoot: string,
  tmux: RuntimeRestartTmux,
  dashboardTarget: TmuxTarget,
): string[] {
  if (
    !tmux.isAvailable() ||
    !tmux.getProjectSession ||
    !tmux.listSessionNames ||
    !tmux.listWindows ||
    !tmux.linkWindowToSession
  ) {
    return [];
  }
  const hostSession = tmux.getProjectSession(projectRoot).sessionName;
  const errors: string[] = [];
  for (const sessionName of tmux.listSessionNames()) {
    if (!isTmuxClientSessionForHost(sessionName, hostSession)) continue;
    try {
      const linked = tmux.linkWindowToSession(sessionName, dashboardTarget, 0);
      if (linked.windowIndex !== 0) {
        throw new Error(`dashboard linked at index ${linked.windowIndex}, expected 0`);
      }
      if (tmux.unlinkWindow) {
        const cleanupErrors = cleanupStaleDashboardLinks(tmux as TmuxRuntimeManager, sessionName, linked);
        if (cleanupErrors.length > 0) throw new Error(`stale dashboard cleanup failed for ${cleanupErrors.join("; ")}`);
      }
    } catch (indexedError) {
      errors.push(`${sessionName}: indexed=${errorMessage(indexedError)}`);
    }
  }
  return errors;
}

function cleanupHostDashboardSession(
  tmux: RuntimeRestartTmux,
  hostSessionName: string,
  dashboardTarget: TmuxTarget,
): string[] {
  if (!tmux.isAvailable() || !tmux.listWindows || !tmux.unlinkWindow) return [];
  return cleanupStaleDashboardLinks(tmux as TmuxRuntimeManager, hostSessionName, dashboardTarget);
}

function captureActiveNonDashboardWindows(projectRoot: string, tmux: RuntimeRestartTmux): TmuxTarget[] {
  if (!tmux.isAvailable() || !tmux.getProjectSession || !tmux.listSessionNames || !tmux.listWindows) return [];
  const hostSession = tmux.getProjectSession(projectRoot).sessionName;
  return tmux
    .listSessionNames()
    .filter((sessionName) => sessionName === hostSession || isTmuxClientSessionForHost(sessionName, hostSession))
    .map((sessionName) => {
      const active = tmux.listWindows!(sessionName).find(
        (window) => window.active && !window.name.startsWith("dashboard"),
      );
      return active
        ? {
            sessionName,
            windowId: active.id,
            windowIndex: active.index,
            windowName: active.name,
          }
        : null;
    })
    .filter((target): target is TmuxTarget => Boolean(target));
}

function restoreActiveWindows(tmux: RuntimeRestartTmux, targets: TmuxTarget[]): void {
  if (!tmux.isAvailable() || !tmux.hasWindow || !tmux.selectWindow) return;
  for (const target of targets) {
    try {
      if (tmux.hasWindow(target)) tmux.selectWindow(target);
    } catch {}
  }
}

function repairRuntimeContract(input: {
  projectRoot: string;
  tmux: RuntimeRestartTmux;
  required: boolean;
  expectedRuntimeOwner: string;
}): RuntimeRestartProjectResult["runtime"] {
  if (!input.tmux.isAvailable() || !input.tmux.getProjectSession || !input.tmux.setSessionOption) {
    return input.required
      ? { status: "failed", error: "tmux runtime repair is unavailable" }
      : { status: "skipped", error: null };
  }

  const hostSession = input.tmux.getProjectSession(input.projectRoot).sessionName;
  try {
    const runtimeOwner = input.tmux.getSessionOption?.(hostSession, TMUX_RUNTIME_OWNER_OPTION);
    if (runtimeOwner && runtimeOwner !== input.expectedRuntimeOwner) {
      return { status: "skipped", error: null };
    }
    const repairedSessions = [hostSession];
    if (input.required) {
      if (!input.tmux.configureManagedSession) {
        throw new Error("tmux runtime reconfiguration is unavailable");
      }
      input.tmux.configureManagedSession(hostSession, input.projectRoot);
      if (input.tmux.listSessionNames) {
        for (const sessionName of input.tmux.listSessionNames()) {
          if (isTmuxClientSessionForHost(sessionName, hostSession)) {
            input.tmux.configureManagedSession(sessionName, input.projectRoot);
            repairedSessions.push(sessionName);
          }
        }
      }
    }
    try {
      for (const sessionName of repairedSessions) {
        if (input.required) {
          input.tmux.setSessionOption(sessionName, TMUX_RUNTIME_CONTRACT_OPTION, AIMUX_TMUX_RUNTIME_CONTRACT_VERSION);
        }
        input.tmux.setSessionOption(sessionName, TMUX_RUNTIME_REBUILD_REQUIRED_OPTION, "0");
      }
    } catch (error) {
      if (input.required) throw error;
    }
    return input.required ? { status: "repaired", error: null } : { status: "skipped", error: null };
  } catch (error) {
    return { status: "failed", error: errorMessage(error) };
  }
}

type ProjectServiceIdentity = ProjectServiceProcessIdentity;

interface ProjectServiceIdentityWithPid extends ProjectServiceIdentity {
  pid: number;
}

async function waitForPidExit(input: {
  pid: number;
  timeoutMs: number;
  killGraceMs: number;
  isPidAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (!input.isPidAlive(input.pid)) return;
    await input.sleep(100);
  }
  if (!input.isPidAlive(input.pid)) return;
  input.killPid(input.pid, "SIGKILL");
  const killDeadline = Date.now() + input.killGraceMs;
  while (Date.now() < killDeadline) {
    if (!input.isPidAlive(input.pid)) return;
    await input.sleep(100);
  }
  if (input.isPidAlive(input.pid)) {
    throw new Error(`pid ${input.pid} did not exit within ${input.timeoutMs + input.killGraceMs}ms`);
  }
}

function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {}
}

async function waitForPidsExit(input: {
  pids: number[];
  timeoutMs: number;
  killGraceMs: number;
  isPidAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
}): Promise<void> {
  for (const pid of [...new Set(input.pids)].filter((pid) => Number.isInteger(pid) && pid > 0)) {
    await waitForPidExit({ ...input, pid });
  }
}

async function verifyPostRestartCoherence(input: {
  buildRuntimeCoherenceReport: typeof buildRuntimeCoherenceReport;
  coherence: BuildRuntimeCoherenceReportOptions | undefined;
  ensureProjectService?: EnsureProjectServiceFn;
  projectRoots: Set<string>;
  verifyDashboards: boolean;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  intervalMs: number;
}): Promise<RuntimeRestartResult["verification"]> {
  const intervalMs = Math.max(1, input.intervalMs);
  const attempts = Math.max(1, Math.floor(Math.max(0, input.timeoutMs) / intervalMs) + 1);
  let latestAfter: RuntimeCoherenceReport | null = null;
  let latestError: string | null = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const after = await input.buildRuntimeCoherenceReport(input.coherence);
      latestAfter = after;
      const afterProjectRoots = new Set(after.projects.map((project) => project.projectRoot));
      const missingProjects = [...input.projectRoots].filter((projectRoot) => !afterProjectRoots.has(projectRoot));
      const failedProjects = after.projects
        .filter((project) => input.projectRoots.has(project.projectRoot))
        .filter((project) => {
          return projectNeedsCurrentRuntimeRepair(project, { verifyDashboards: input.verifyDashboards });
        })
        .map((project) => project.projectRoot);
      const unhealthyProjects = [...missingProjects, ...failedProjects];
      latestError =
        unhealthyProjects.length === 0 ? null : `post-restart version check failed for ${unhealthyProjects.join(", ")}`;
      if (!latestError) {
        return {
          status: "ok",
          after,
          error: null,
        };
      }
      if (input.ensureProjectService && attempt < attempts - 1) {
        for (const projectRoot of unhealthyProjects) {
          try {
            await input.ensureProjectService(projectRoot);
          } catch (error) {
            latestError = `post-restart service repair failed for ${projectRoot}: ${errorMessage(error)}`;
          }
        }
      }
    } catch (error) {
      latestError = errorMessage(error);
    }

    if (attempt < attempts - 1) {
      await input.sleep(intervalMs);
    }
  }

  return {
    status: "failed",
    after: latestAfter,
    error: latestError,
  };
}

export async function restartAimuxControlPlane(
  options: RestartAimuxControlPlaneOptions = {},
): Promise<RuntimeRestartResult> {
  throwIfRestartAborted(options.abortSignal);
  const lockPath = tryAcquireRuntimeRestartLock(options.isPidAlive ?? defaultIsPidAlive);
  if (!lockPath) {
    throw new Error("aimux restart is already running");
  }
  try {
    return await restartAimuxControlPlaneUnlocked(options);
  } finally {
    releaseRuntimeRestartLock(lockPath);
  }
}

async function restartAimuxControlPlaneUnlocked(
  options: RestartAimuxControlPlaneOptions = {},
): Promise<RuntimeRestartResult> {
  const now = options.now ?? (() => new Date());
  const before = await (options.buildRuntimeCoherenceReport ?? buildRuntimeCoherenceReport)(options.coherence);
  throwIfRestartAborted(options.abortSignal);
  const projectRoots = selectProjectRoots(before, options.projectRoot);
  const reloadDashboards = options.reloadDashboards ?? true;
  const verifyDashboards = options.verifyDashboards ?? reloadDashboards;
  const dashboardProjectRoots = reloadDashboards
    ? selectDashboardProjectRoots(before, options.projectRoot)
    : new Set<string>();
  const verificationProjectRoots = options.projectRoot ? new Set([options.projectRoot]) : new Set(projectRoots);
  const runtimeRepairProjectRoots = selectRuntimeRepairProjectRoots(before);
  const beforeServices = before.projects.flatMap((project): ProjectServiceIdentityWithPid[] => {
    const pid = project.service.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return [];
    return [
      {
        pid,
        projectId: project.service.daemonState?.projectId,
        projectRoot: project.service.daemonState?.projectRoot ?? project.projectRoot,
      },
    ];
  });
  const tmux = (options.createTmux ?? (() => new TmuxRuntimeManager()))();
  const previousDaemon = await (options.stopDaemon ?? defaultStopDaemon)();
  throwIfRestartAborted(options.abortSignal);
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const isAimuxProjectServiceProcess = options.isAimuxProjectServiceProcess ?? defaultIsAimuxProjectServiceProcess;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const killPid = options.killPid ?? defaultKillPid;
  let stoppedServicePids: number[] = [];
  if (previousDaemon) {
    await waitForPidExit({
      pid: previousDaemon.pid,
      timeoutMs: options.daemonExitTimeoutMs ?? 5000,
      killGraceMs: options.killGraceMs ?? 2000,
      isPidAlive,
      sleep,
      killPid,
    });
    stoppedServicePids = previousDaemon.stoppedProjectServices.map((service) => service.pid);
  }
  const signaledServicePids = new Set(stoppedServicePids);
  const verifiedBeforeServices = beforeServices.filter((service) => isAimuxProjectServiceProcess(service.pid, service));
  const beforeServicePids = beforeServices.map((service) => service.pid);
  const verifiedBeforeServicePids = verifiedBeforeServices.map((service) => service.pid);
  const verifiedBeforeServicePidSet = new Set(verifiedBeforeServicePids);
  for (const pid of beforeServicePids) {
    if (signaledServicePids.has(pid)) continue;
    if (!verifiedBeforeServicePidSet.has(pid)) continue;
    try {
      killPid(pid, "SIGTERM");
    } catch {}
  }
  await waitForPidsExit({
    pids: [...new Set([...stoppedServicePids, ...verifiedBeforeServicePids])],
    timeoutMs: options.serviceExitTimeoutMs ?? 5000,
    killGraceMs: options.killGraceMs ?? 2000,
    isPidAlive,
    sleep,
    killPid,
  });
  const currentDaemon = await (options.ensureDaemonRunning ?? defaultEnsureDaemonRunning)();
  throwIfRestartAborted(options.abortSignal);
  const ensureService = options.ensureProjectService ?? defaultEnsureProjectService;
  const stopService =
    options.stopProjectService ?? (options.ensureProjectService ? async () => null : defaultStopProjectService);
  const resolveDashboard =
    options.resolveDashboardTarget ??
    ((projectRoot, tmux, resolveOptions) =>
      resolveDashboardTarget(projectRoot, tmux as TmuxRuntimeManager, resolveOptions));
  const tmuxAvailable = tmux.isAvailable();
  const projects: RuntimeRestartProjectResult[] = [];

  for (const projectRoot of projectRoots) {
    throwIfRestartAborted(options.abortSignal);
    const result = emptyProjectResult(projectRoot);
    result.runtimeRebuildRequired = runtimeRepairProjectRoots.has(projectRoot);
    result.runtime = repairRuntimeContract({
      projectRoot,
      tmux,
      required: runtimeRepairProjectRoots.has(projectRoot),
      expectedRuntimeOwner: before.expected.runtimeOwner,
    });
    try {
      await stopService(projectRoot);
      result.service.state = await ensureService(projectRoot);
      result.service.status = "ensured";
    } catch (error) {
      result.service.status = "failed";
      result.service.error = errorMessage(error);
    }

    if (!dashboardProjectRoots.has(projectRoot)) {
      result.dashboard.status = "skipped";
    } else if (!tmuxAvailable) {
      result.dashboard.status = "failed";
      result.dashboard.error = "tmux is not installed or not available in PATH";
    } else {
      try {
        const activeWindows = captureActiveNonDashboardWindows(projectRoot, tmux);
        let resolved: RuntimeRestartDashboardTarget | null = null;
        let relinkErrors: string[] = [];
        try {
          const resolvedTarget = resolveDashboard(projectRoot, tmux, { forceReload: true, openInHostSession: true });
          resolved = resolvedTarget;
          relinkErrors = [
            ...cleanupHostDashboardSession(
              tmux,
              resolvedTarget.dashboardSession.sessionName,
              resolvedTarget.dashboardTarget,
            ),
            ...relinkDashboardToClientSessions(projectRoot, tmux, resolvedTarget.dashboardTarget),
          ];
        } finally {
          restoreActiveWindows(tmux, activeWindows);
        }
        if (!resolved) {
          throw new Error("dashboard target was not resolved");
        }
        if (relinkErrors.length > 0) {
          throw new Error(`dashboard relink failed for ${relinkErrors.join("; ")}`);
        }
        result.dashboard.status = "reloaded";
        result.dashboard.sessionName = resolved.dashboardSession.sessionName;
        result.dashboard.target = resolved.dashboardTarget;
      } catch (error) {
        result.dashboard.status = "failed";
        result.dashboard.error = errorMessage(error);
      }
    }

    projects.push(result);
  }

  const shouldVerifyAfterRestart = options.verifyAfterRestart ?? !options.buildRuntimeCoherenceReport;
  let verification: RuntimeRestartResult["verification"] = {
    status: "skipped",
    after: null,
    error: null,
  };
  if (shouldVerifyAfterRestart) {
    verification = await verifyPostRestartCoherence({
      buildRuntimeCoherenceReport: options.buildRuntimeCoherenceReport ?? buildRuntimeCoherenceReport,
      coherence: options.coherence,
      ensureProjectService: ensureService,
      projectRoots: verificationProjectRoots,
      verifyDashboards,
      sleep,
      timeoutMs: options.verificationTimeoutMs ?? POST_RESTART_VERIFICATION_TIMEOUT_MS,
      intervalMs: options.verificationIntervalMs ?? 250,
    });
  }
  reconcileProjectResultsWithVerification(projects, verification);
  const projectFailures = projects.filter(
    (project) =>
      project.runtime.status === "failed" ||
      project.service.status === "failed" ||
      project.dashboard.status === "failed",
  ).length;
  const failures = projectFailures + (verification.status === "failed" ? 1 : 0);
  const result: RuntimeRestartResult = {
    startedAt: before.generatedAt,
    finishedAt: now().toISOString(),
    before,
    verification,
    daemon: {
      previous: previousDaemon,
      current: currentDaemon,
    },
    projects,
    summary: {
      projects: projects.length,
      servicesEnsured: projects.filter((project) => project.service.status === "ensured").length,
      runtimeRepairs: projects.filter((project) => project.runtime.status === "repaired").length,
      dashboardsReloaded: projects.filter((project) => project.dashboard.status === "reloaded").length,
      runtimeRebuildRequired: projects.filter((project) => project.runtimeRebuildRequired).length,
      failures,
    },
  };
  emitRepairDiagnostics(result, options.repairNotifier === undefined ? defaultRepairNotifier : options.repairNotifier);
  return result;
}

function emitRepairDiagnostics(result: RuntimeRestartResult, notifier: RepairNotifier | null): void {
  if (!notifier) return;
  const events = buildRepairEvents(result);
  for (const event of events) {
    try {
      notifier.record(event);
    } catch {}
  }
  if (events.length === 0) return;
  const repaired = events.filter((event) => event.status === "repaired").length;
  const failed = events.filter((event) => event.status === "failed").length;
  const message =
    failed > 0 ? `${repaired} repair steps completed, ${failed} failed.` : `${repaired} repair steps completed.`;
  try {
    notifier.notify(failed > 0 ? "Aimux repair needs attention" : "Aimux repaired itself", message);
  } catch {}
}

function buildRepairEvents(result: RuntimeRestartResult): RepairEvent[] {
  const events: RepairEvent[] = [];
  const controlStatus = result.summary.failures > 0 ? "failed" : "repaired";
  for (const project of result.projects) {
    events.push({
      ts: result.finishedAt,
      projectRoot: project.projectRoot,
      action: "control-plane-restart",
      reason: result.daemon.previous ? "daemon restarted" : "daemon started",
      status: controlStatus,
      details: {
        previousDaemonPid: result.daemon.previous?.pid ?? null,
        currentDaemonPid: result.daemon.current.pid,
      },
    });
    if (project.runtime.status === "repaired" || project.runtime.status === "failed") {
      events.push({
        ts: result.finishedAt,
        projectRoot: project.projectRoot,
        action: "tmux-runtime-repair",
        reason: project.runtimeRebuildRequired ? "runtime contract drift" : "runtime marker cleanup",
        status: project.runtime.status,
        details: { error: project.runtime.error },
      });
    }
    if (project.service.status === "ensured" || project.service.status === "failed") {
      const beforeProject = result.before.projects.find((entry) => entry.projectRoot === project.projectRoot);
      events.push({
        ts: result.finishedAt,
        projectRoot: project.projectRoot,
        action: "project-service-ensure",
        reason: `pre-restart service status: ${beforeProject?.service.status ?? "unknown"}`,
        status: project.service.status === "ensured" ? "repaired" : "failed",
        details: {
          previousPid: beforeProject?.service.pid ?? null,
          currentPid: project.service.state?.pid ?? null,
          error: project.service.error,
        },
      });
    }
    if (project.dashboard.status === "reloaded" || project.dashboard.status === "failed") {
      events.push({
        ts: result.finishedAt,
        projectRoot: project.projectRoot,
        action: "dashboard-reload",
        reason: "dashboard process resync",
        status: project.dashboard.status === "reloaded" ? "repaired" : "failed",
        details: {
          sessionName: project.dashboard.sessionName,
          target: project.dashboard.target,
          error: project.dashboard.error,
        },
      });
    }
  }
  return events;
}

export function renderRuntimeRestartResult(result: RuntimeRestartResult): string {
  const lines = [
    "Aimux Restart",
    `  daemon: ${result.daemon.previous ? `restarted pid=${result.daemon.previous.pid}` : "started"} -> pid=${result.daemon.current.pid}`,
    `  projects: ${result.summary.projects}`,
    `  services ensured: ${result.summary.servicesEnsured}`,
    `  runtime repaired: ${result.summary.runtimeRepairs}`,
    `  dashboards reloaded: ${result.summary.dashboardsReloaded}`,
    `  failures: ${result.summary.failures}`,
  ];

  if (result.summary.runtimeRebuildRequired > 0) {
    lines.push("");
    lines.push("Runtime repaired:");
    for (const project of result.projects.filter((entry) => entry.runtimeRebuildRequired)) {
      lines.push(`  ${project.projectRoot}`);
    }
  }

  for (const project of result.projects) {
    lines.push("");
    lines.push(`Project: ${project.projectRoot}`);
    lines.push(`  runtime: ${project.runtime.status}${project.runtime.error ? ` (${project.runtime.error})` : ""}`);
    lines.push(`  service: ${project.service.status}${project.service.error ? ` (${project.service.error})` : ""}`);
    lines.push(
      `  dashboard: ${project.dashboard.status}${project.dashboard.target ? ` ${project.dashboard.sessionName}:${project.dashboard.target.windowId}` : ""}${project.dashboard.error ? ` (${project.dashboard.error})` : ""}`,
    );
  }

  if (result.summary.failures > 0) {
    lines.push("");
    if (result.verification.status === "failed") {
      lines.push(`Post-restart verification failed: ${result.verification.error ?? "unknown error"}`);
      if (result.verification.after) {
        lines.push("After restart:");
        lines.push(renderRuntimeCoherenceReport(result.verification.after));
      }
      lines.push("");
    }
    lines.push("Before restart:");
    lines.push(renderRuntimeCoherenceReport(result.before));
  }

  return lines.join("\n");
}
