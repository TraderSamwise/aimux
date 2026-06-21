import { execFileSync } from "node:child_process";
import { resolve as pathResolve } from "node:path";
import {
  ensureDaemonRunning,
  ensureProjectService,
  stopDaemon,
  type AimuxDaemonInfo,
  type ProjectServiceState,
} from "./daemon.js";
import { resolveDashboardTarget } from "./dashboard/targets.js";
import {
  buildRuntimeCoherenceReport,
  renderRuntimeCoherenceReport,
  type BuildRuntimeCoherenceReportOptions,
  type RuntimeCoherenceReport,
} from "./runtime-coherence.js";
import { TmuxRuntimeManager, type TmuxTarget } from "./tmux/runtime-manager.js";
import { commandArgValueMatches } from "./process-args.js";

export type RuntimeRestartStepStatus = "ensured" | "reloaded" | "skipped" | "failed";

export interface RuntimeRestartProjectResult {
  projectRoot: string;
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
    dashboardsReloaded: number;
    failures: number;
  };
}

type RuntimeRestartTmux = Pick<TmuxRuntimeManager, "isAvailable"> &
  Partial<
    Pick<
      TmuxRuntimeManager,
      | "getProjectSession"
      | "hasWindow"
      | "killWindow"
      | "listSessionNames"
      | "listWindows"
      | "linkWindowToSession"
      | "selectWindow"
    >
  >;

export interface RestartAimuxControlPlaneOptions {
  projectRoot?: string;
  now?: () => Date;
  coherence?: BuildRuntimeCoherenceReportOptions;
  buildRuntimeCoherenceReport?: typeof buildRuntimeCoherenceReport;
  stopDaemon?: typeof stopDaemon;
  ensureDaemonRunning?: typeof ensureDaemonRunning;
  ensureProjectService?: typeof ensureProjectService;
  createTmux?: () => RuntimeRestartTmux;
  resolveDashboardTarget?: (
    projectRoot: string,
    tmux: RuntimeRestartTmux,
    options: { forceReload: true; openInHostSession: true },
  ) => {
    dashboardSession: { sessionName: string };
    dashboardTarget: TmuxTarget;
  };
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
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyProjectResult(projectRoot: string): RuntimeRestartProjectResult {
  return {
    projectRoot,
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

function selectProjectRoots(before: RuntimeCoherenceReport, projectRoot?: string): string[] {
  const roots = before.projects.map((project) => project.projectRoot);
  if (projectRoot) roots.push(projectRoot);
  return uniqueSorted(roots);
}

function selectDashboardProjectRoots(before: RuntimeCoherenceReport, projectRoot?: string): Set<string> {
  if (projectRoot) return new Set([projectRoot]);
  return new Set(
    before.projects.filter((project) => project.dashboards.length > 0).map((project) => project.projectRoot),
  );
}

function stopPreRestartDashboards(before: RuntimeCoherenceReport, tmux: RuntimeRestartTmux): void {
  if (!tmux.isAvailable() || !tmux.killWindow || !tmux.hasWindow) return;
  const seen = new Set<string>();
  for (const dashboard of before.projects.flatMap((project) => project.dashboards)) {
    if (seen.has(dashboard.windowId)) continue;
    seen.add(dashboard.windowId);
    const target: TmuxTarget = {
      sessionName: dashboard.sessionName,
      windowId: dashboard.windowId,
      windowIndex: dashboard.windowIndex,
      windowName: dashboard.windowName,
    };
    try {
      if (tmux.hasWindow(target)) tmux.killWindow(target);
    } catch {}
  }
}

function relinkDashboardToClientSessions(
  projectRoot: string,
  tmux: RuntimeRestartTmux,
  dashboardTarget: TmuxTarget,
): void {
  if (
    !tmux.isAvailable() ||
    !tmux.getProjectSession ||
    !tmux.listSessionNames ||
    !tmux.listWindows ||
    !tmux.linkWindowToSession
  ) {
    return;
  }
  const hostSession = tmux.getProjectSession(projectRoot).sessionName;
  for (const sessionName of tmux.listSessionNames()) {
    if (!sessionName.startsWith(`${hostSession}-client-`)) continue;
    const windows = tmux.listWindows(sessionName);
    const alreadyLinked = windows.some((window) => window.id === dashboardTarget.windowId);
    const missingDashboard = !windows.some((window) => window.name.startsWith("dashboard"));
    if (alreadyLinked) continue;
    let linked: TmuxTarget;
    try {
      linked = tmux.linkWindowToSession(sessionName, dashboardTarget, 0);
    } catch {
      linked = tmux.linkWindowToSession(sessionName, dashboardTarget);
    }
    if (missingDashboard && tmux.selectWindow) {
      try {
        tmux.selectWindow(linked);
      } catch {}
    }
  }
}

export function isExitedProcessState(state: string): boolean {
  return state.trim().startsWith("Z");
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "win32") {
    try {
      const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (isExitedProcessState(state)) return false;
    } catch {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
    }
  }
  return true;
}

interface ProjectServiceIdentity {
  projectId?: string;
  projectRoot?: string;
}

interface ProjectServiceIdentityWithPid extends ProjectServiceIdentity {
  pid: number;
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

function defaultIsAimuxProjectServiceProcess(pid: number, expected: ProjectServiceIdentity = {}): boolean {
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
      const failedProjects = after.projects
        .filter((project) => project.status !== "ok")
        .map((project) => project.projectRoot);
      latestError =
        failedProjects.length === 0 ? null : `post-restart version check failed for ${failedProjects.join(", ")}`;
      if (!latestError) {
        return {
          status: "ok",
          after,
          error: null,
        };
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
  const now = options.now ?? (() => new Date());
  const before = await (options.buildRuntimeCoherenceReport ?? buildRuntimeCoherenceReport)(options.coherence);
  const projectRoots = selectProjectRoots(before, options.projectRoot);
  const dashboardProjectRoots = selectDashboardProjectRoots(before, options.projectRoot);
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
  stopPreRestartDashboards(before, tmux);
  const previousDaemon = await (options.stopDaemon ?? stopDaemon)();
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
  const currentDaemon = await (options.ensureDaemonRunning ?? ensureDaemonRunning)({ adoptExisting: false });
  const ensureService = options.ensureProjectService ?? ensureProjectService;
  const resolveDashboard =
    options.resolveDashboardTarget ??
    ((projectRoot, tmux, resolveOptions) =>
      resolveDashboardTarget(projectRoot, tmux as TmuxRuntimeManager, resolveOptions));
  const tmuxAvailable = tmux.isAvailable();
  const projects: RuntimeRestartProjectResult[] = [];

  for (const projectRoot of projectRoots) {
    const result = emptyProjectResult(projectRoot);
    try {
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
        const resolved = resolveDashboard(projectRoot, tmux, { forceReload: true, openInHostSession: true });
        relinkDashboardToClientSessions(projectRoot, tmux, resolved.dashboardTarget);
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

  const projectFailures = projects.filter(
    (project) => project.service.status === "failed" || project.dashboard.status === "failed",
  ).length;
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
      sleep,
      timeoutMs: options.verificationTimeoutMs ?? 5000,
      intervalMs: options.verificationIntervalMs ?? 250,
    });
  }
  const failures = projectFailures + (verification.status === "failed" ? 1 : 0);
  return {
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
      dashboardsReloaded: projects.filter((project) => project.dashboard.status === "reloaded").length,
      failures,
    },
  };
}

export function renderRuntimeRestartResult(result: RuntimeRestartResult): string {
  const lines = [
    "Aimux Restart",
    `  daemon: ${result.daemon.previous ? `restarted pid=${result.daemon.previous.pid}` : "started"} -> pid=${result.daemon.current.pid}`,
    `  projects: ${result.summary.projects}`,
    `  services ensured: ${result.summary.servicesEnsured}`,
    `  dashboards reloaded: ${result.summary.dashboardsReloaded}`,
    `  failures: ${result.summary.failures}`,
  ];

  for (const project of result.projects) {
    lines.push("");
    lines.push(`Project: ${project.projectRoot}`);
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
