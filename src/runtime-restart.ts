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

type RuntimeRestartTmux = Pick<TmuxRuntimeManager, "isAvailable">;

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
    options: { forceReload: true },
  ) => {
    dashboardSession: { sessionName: string };
    dashboardTarget: TmuxTarget;
  };
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
  if (projectRoot) return [projectRoot];
  return uniqueSorted(before.projects.map((project) => project.projectRoot));
}

function selectDashboardProjectRoots(before: RuntimeCoherenceReport, projectRoot?: string): Set<string> {
  if (projectRoot) return new Set([projectRoot]);
  return new Set(
    before.projects.filter((project) => project.dashboards.length > 0).map((project) => project.projectRoot),
  );
}

export async function restartAimuxControlPlane(
  options: RestartAimuxControlPlaneOptions = {},
): Promise<RuntimeRestartResult> {
  const now = options.now ?? (() => new Date());
  const before = await (options.buildRuntimeCoherenceReport ?? buildRuntimeCoherenceReport)(options.coherence);
  const projectRoots = selectProjectRoots(before, options.projectRoot);
  const dashboardProjectRoots = selectDashboardProjectRoots(before, options.projectRoot);
  const previousDaemon = await (options.stopDaemon ?? stopDaemon)();
  const currentDaemon = await (options.ensureDaemonRunning ?? ensureDaemonRunning)();
  const ensureService = options.ensureProjectService ?? ensureProjectService;
  const tmux = (options.createTmux ?? (() => new TmuxRuntimeManager()))();
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
        const resolved = resolveDashboard(projectRoot, tmux, { forceReload: true });
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

  const failures = projects.filter(
    (project) => project.service.status === "failed" || project.dashboard.status === "failed",
  ).length;
  return {
    startedAt: before.generatedAt,
    finishedAt: now().toISOString(),
    before,
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
    lines.push("Before restart:");
    lines.push(renderRuntimeCoherenceReport(result.before));
  }

  return lines.join("\n");
}
