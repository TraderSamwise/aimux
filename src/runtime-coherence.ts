import { execFileSync } from "node:child_process";
import { getDashboardCommandSpec } from "./dashboard/command-spec.js";
import { loadDaemonInfo, loadDaemonState, type AimuxDaemonInfo, type ProjectServiceState } from "./daemon.js";
import { requestJson } from "./http-client.js";
import { loadMetadataEndpoint, type MetadataApiEndpoint } from "./metadata-store.js";
import { getProjectServiceManifest, manifestsMatch, type ProjectServiceManifest } from "./project-service-manifest.js";
import { getRuntimeOwnerId, TMUX_DASHBOARD_OWNER_OPTION, TMUX_RUNTIME_OWNER_OPTION } from "./runtime-owner.js";
import { isDashboardWindowName, TmuxRuntimeManager, type TmuxTarget } from "./tmux/runtime-manager.js";
import { AIMUX_VERSION } from "./version.js";
import { getAimuxCliLaunchCommand, type AimuxCliLaunchCommand } from "./cli-launcher.js";

export type RuntimeCoherenceStatus = "ok" | "missing" | "mismatch" | "unreachable";
export type RuntimeCoherenceProjectStatus = "ok" | "needs-restart";
export type RuntimeCoherenceSource = "daemon-state" | "tmux";

export interface RuntimeCoherenceDashboardReport {
  sessionName: string;
  windowId: string;
  windowIndex: number;
  windowName: string;
  alive: boolean;
  buildStamp: string | null;
  owner: string | null;
  runtimeOwner: string | null;
  process: RuntimeCoherenceProcessReport | null;
  status: RuntimeCoherenceStatus;
}

export interface RuntimeCoherenceProcessReport {
  pid: number | null;
  argsPreview: string | null;
  pathHints: string[];
  staleNativePath: boolean;
  error: string | null;
}

export interface RuntimeCoherenceProjectReport {
  projectRoot: string;
  sources: RuntimeCoherenceSource[];
  expectedDashboardBuildStamp: string;
  service: {
    status: RuntimeCoherenceStatus;
    daemonState: ProjectServiceState | null;
    endpoint: MetadataApiEndpoint | null;
    pid: number | null;
    process: RuntimeCoherenceProcessReport | null;
    serviceInfo: Partial<ProjectServiceManifest> | null;
    error: string | null;
  };
  dashboards: RuntimeCoherenceDashboardReport[];
  status: RuntimeCoherenceProjectStatus;
}

export interface RuntimeCoherenceReport {
  generatedAt: string;
  cliVersion: string;
  cliLaunch: AimuxCliLaunchCommand;
  expected: {
    projectService: ProjectServiceManifest;
    runtimeOwner: string;
  };
  daemon: {
    running: boolean;
    info: AimuxDaemonInfo | null;
    process: RuntimeCoherenceProcessReport | null;
    projectCount: number;
  };
  tmux: {
    available: boolean;
    version: string | null;
    sessionCount: number;
  };
  projects: RuntimeCoherenceProjectReport[];
  staleHookProcesses: RuntimeCoherenceProcessReport[];
  summary: {
    projects: number;
    ok: number;
    needsRestart: number;
  };
}

interface RuntimeCoherenceDaemonState {
  projects: Record<string, ProjectServiceState>;
}

type RuntimeCoherenceTmux = Pick<
  TmuxRuntimeManager,
  | "getProjectSession"
  | "getSessionOption"
  | "getVersion"
  | "isAvailable"
  | "isManagedSessionName"
  | "isWindowAlive"
  | "listSessionNames"
  | "listWindows"
  | "getWindowOption"
  | "displayMessage"
>;

export interface BuildRuntimeCoherenceReportOptions {
  tmux?: RuntimeCoherenceTmux;
  now?: () => Date;
  loadDaemonInfo?: () => AimuxDaemonInfo | null;
  loadDaemonState?: () => RuntimeCoherenceDaemonState;
  loadMetadataEndpoint?: (projectRoot?: string) => MetadataApiEndpoint | null;
  requestJson?: typeof requestJson;
  readProcessArgs?: (pid: number) => string | null;
  listProcessArgs?: () => Array<{ pid: number; args: string }>;
  getAimuxCliLaunchCommand?: typeof getAimuxCliLaunchCommand;
  getDashboardBuildStamp?: (projectRoot: string) => string;
  getProjectServiceManifest?: () => ProjectServiceManifest;
  getRuntimeOwnerId?: () => string;
}

interface KnownProject {
  projectRoot: string;
  sources: Set<RuntimeCoherenceSource>;
}

function sortedSources(sources: Set<RuntimeCoherenceSource>): RuntimeCoherenceSource[] {
  return [...sources].sort();
}

function addKnownProject(
  projects: Map<string, KnownProject>,
  projectRoot: string | null,
  source: RuntimeCoherenceSource,
) {
  const normalized = projectRoot?.trim();
  if (!normalized) return;
  const entry = projects.get(normalized) ?? { projectRoot: normalized, sources: new Set<RuntimeCoherenceSource>() };
  entry.sources.add(source);
  projects.set(normalized, entry);
}

function collectKnownProjects(input: {
  daemonState: RuntimeCoherenceDaemonState;
  tmux: RuntimeCoherenceTmux;
  tmuxAvailable: boolean;
  sessionNames: string[];
}): KnownProject[] {
  const projects = new Map<string, KnownProject>();
  for (const entry of Object.values(input.daemonState.projects)) {
    addKnownProject(projects, entry.projectRoot, "daemon-state");
  }
  if (input.tmuxAvailable) {
    for (const sessionName of input.sessionNames) {
      if (!input.tmux.isManagedSessionName(sessionName)) continue;
      addKnownProject(projects, input.tmux.getSessionOption(sessionName, "@aimux-project-root"), "tmux");
    }
  }
  return [...projects.values()].sort((a, b) => a.projectRoot.localeCompare(b.projectRoot));
}

function findProjectDaemonState(
  daemonState: RuntimeCoherenceDaemonState,
  projectRoot: string,
): ProjectServiceState | null {
  return Object.values(daemonState.projects).find((entry) => entry.projectRoot === projectRoot) ?? null;
}

async function readProjectServiceHealth(input: {
  endpoint: MetadataApiEndpoint | null;
  requestJsonImpl: typeof requestJson;
  expected: ProjectServiceManifest;
}): Promise<RuntimeCoherenceProjectReport["service"]> {
  if (!input.endpoint) {
    return {
      status: "missing",
      daemonState: null,
      endpoint: null,
      pid: null,
      process: null,
      serviceInfo: null,
      error: null,
    };
  }

  const healthUrl = `http://${input.endpoint.host}:${input.endpoint.port}/health`;
  let latestError: unknown = null;
  for (const timeoutMs of [1000, 4000]) {
    try {
      const { status, json } = await input.requestJsonImpl(healthUrl, { timeoutMs });
      if (status < 200 || status >= 300 || json?.ok === false) {
        throw new Error(json?.error || `health request failed: ${status}`);
      }
      const serviceInfo =
        json?.serviceInfo && typeof json.serviceInfo === "object"
          ? (json.serviceInfo as Partial<ProjectServiceManifest>)
          : null;
      return {
        status: manifestsMatch(input.expected, serviceInfo) ? "ok" : "mismatch",
        daemonState: null,
        endpoint: input.endpoint,
        pid: typeof json?.pid === "number" ? json.pid : input.endpoint.pid,
        process: null,
        serviceInfo,
        error: null,
      };
    } catch (error) {
      latestError = error;
    }
  }

  return {
    status: "unreachable",
    daemonState: null,
    endpoint: input.endpoint,
    pid: input.endpoint.pid,
    process: null,
    serviceInfo: null,
    error: latestError instanceof Error ? latestError.message : String(latestError),
  };
}

function listDashboardReports(input: {
  tmux: RuntimeCoherenceTmux;
  tmuxAvailable: boolean;
  sessionNames: string[];
  projectRoot: string;
  expectedDashboardBuildStamp: string;
  expectedRuntimeOwner: string;
  cliLaunch: AimuxCliLaunchCommand;
}): RuntimeCoherenceDashboardReport[] {
  if (!input.tmuxAvailable) return [];

  const hostSession = input.tmux.getProjectSession(input.projectRoot).sessionName;
  const candidates = input.sessionNames.filter((sessionName) => {
    if (sessionName === hostSession || sessionName.startsWith(`${hostSession}-client-`)) return true;
    return input.tmux.getSessionOption(sessionName, "@aimux-project-root") === input.projectRoot;
  });
  const seen = new Set<string>();
  const dashboards: RuntimeCoherenceDashboardReport[] = [];

  for (const sessionName of candidates) {
    const runtimeOwner = input.tmux.getSessionOption(sessionName, TMUX_RUNTIME_OWNER_OPTION);
    for (const window of input.tmux.listWindows(sessionName)) {
      if (!isDashboardWindowName(window.name) || seen.has(window.id)) continue;
      seen.add(window.id);
      const target: TmuxTarget = {
        sessionName,
        windowId: window.id,
        windowIndex: window.index,
        windowName: window.name,
      };
      const alive = input.tmux.isWindowAlive(target);
      const buildStamp = input.tmux.getWindowOption(target, "@aimux-dashboard-build");
      const owner = input.tmux.getWindowOption(target, TMUX_DASHBOARD_OWNER_OPTION);
      const process = buildProcessReport({
        pid: null,
        args: input.tmux.displayMessage("#{pane_start_command}", window.id),
        cliLaunch: input.cliLaunch,
      });
      const status =
        alive &&
        buildStamp === input.expectedDashboardBuildStamp &&
        owner === input.expectedRuntimeOwner &&
        runtimeOwner === input.expectedRuntimeOwner
          ? "ok"
          : "mismatch";
      dashboards.push({
        sessionName,
        windowId: window.id,
        windowIndex: window.index,
        windowName: window.name,
        alive,
        buildStamp,
        owner,
        runtimeOwner,
        process,
        status,
      });
    }
  }

  return dashboards.sort((a, b) =>
    a.sessionName === b.sessionName ? a.windowIndex - b.windowIndex : a.sessionName.localeCompare(b.sessionName),
  );
}

function preview(value: string | null | undefined, max = 260): string | null {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function nativePathHints(args: string | null | undefined): string[] {
  if (!args) return [];
  return [...new Set(args.match(/\S*\.aimux\/native\/\S+/g) ?? [])].slice(0, 8);
}

function currentNativeInstallRoot(cliLaunch: AimuxCliLaunchCommand): string | null {
  const marker = ".aimux/native/";
  const index = cliLaunch.currentEntryPath.indexOf(marker);
  if (index < 0) return null;
  const prefixEnd = index + marker.length;
  const versionEnd = cliLaunch.currentEntryPath.indexOf("/", prefixEnd);
  if (versionEnd < 0) return null;
  return cliLaunch.currentEntryPath.slice(0, versionEnd + 1);
}

function hasStaleNativePath(args: string | null | undefined, cliLaunch: AimuxCliLaunchCommand): boolean {
  const currentRoot = currentNativeInstallRoot(cliLaunch);
  return nativePathHints(args).some((path) => {
    if (path.includes(cliLaunch.currentEntryPath)) return false;
    if (currentRoot && path.includes(currentRoot)) return false;
    return true;
  });
}

function buildProcessReport(input: {
  pid: number | null;
  args: string | null;
  cliLaunch: AimuxCliLaunchCommand;
  error?: string | null;
}): RuntimeCoherenceProcessReport | null {
  if (!input.args && !input.error && input.pid === null) return null;
  return {
    pid: input.pid,
    argsPreview: preview(input.args),
    pathHints: nativePathHints(input.args),
    staleNativePath: hasStaleNativePath(input.args, input.cliLaunch),
    error: input.error ?? null,
  };
}

function defaultReadProcessArgs(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function defaultListProcessArgs(): Array<{ pid: number; args: string }> {
  try {
    const raw = execFileSync("ps", ["-axo", "pid=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw
      .split("\n")
      .map((line) => line.match(/^\s*(\d+)\s+(.+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => ({ pid: Number(match[1]), args: match[2] ?? "" }))
      .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0 && entry.args.trim());
  } catch {
    return [];
  }
}

function listStaleHookProcesses(input: {
  listProcessArgs: () => Array<{ pid: number; args: string }>;
  cliLaunch: AimuxCliLaunchCommand;
}): RuntimeCoherenceProcessReport[] {
  return input
    .listProcessArgs()
    .filter((entry) => entry.args.includes("claude-hook") || entry.args.includes("codex-hook"))
    .map((entry) => buildProcessReport({ pid: entry.pid, args: entry.args, cliLaunch: input.cliLaunch }))
    .filter((entry): entry is RuntimeCoherenceProcessReport => Boolean(entry?.staleNativePath));
}

function projectStatus(
  project: Pick<RuntimeCoherenceProjectReport, "service" | "dashboards">,
): RuntimeCoherenceProjectStatus {
  if (project.service.status !== "ok") return "needs-restart";
  return project.dashboards.some((dashboard) => dashboard.status !== "ok") ? "needs-restart" : "ok";
}

export async function buildRuntimeCoherenceReport(
  options: BuildRuntimeCoherenceReportOptions = {},
): Promise<RuntimeCoherenceReport> {
  const tmux = options.tmux ?? new TmuxRuntimeManager();
  const daemonInfo = (options.loadDaemonInfo ?? loadDaemonInfo)();
  const daemonState = (options.loadDaemonState ?? loadDaemonState)();
  const expectedService = (options.getProjectServiceManifest ?? getProjectServiceManifest)();
  const expectedRuntimeOwner = (options.getRuntimeOwnerId ?? getRuntimeOwnerId)();
  const cliLaunch = (options.getAimuxCliLaunchCommand ?? getAimuxCliLaunchCommand)();
  const readProcessArgs = options.readProcessArgs ?? defaultReadProcessArgs;
  const listProcessArgs = options.listProcessArgs ?? defaultListProcessArgs;
  const tmuxAvailable = tmux.isAvailable();
  const sessionNames = tmuxAvailable ? tmux.listSessionNames() : [];
  const knownProjects = collectKnownProjects({ daemonState, tmux, tmuxAvailable, sessionNames });
  const projects: RuntimeCoherenceProjectReport[] = [];

  for (const knownProject of knownProjects) {
    const expectedDashboardBuildStamp =
      options.getDashboardBuildStamp?.(knownProject.projectRoot) ??
      getDashboardCommandSpec(knownProject.projectRoot).dashboardBuildStamp;
    const endpoint = (options.loadMetadataEndpoint ?? loadMetadataEndpoint)(knownProject.projectRoot);
    const service = await readProjectServiceHealth({
      endpoint,
      requestJsonImpl: options.requestJson ?? requestJson,
      expected: expectedService,
    });
    service.daemonState = findProjectDaemonState(daemonState, knownProject.projectRoot);
    service.process = buildProcessReport({
      pid: service.pid,
      args: service.pid ? readProcessArgs(service.pid) : null,
      cliLaunch,
    });
    if (!service.endpoint && service.daemonState) {
      service.status = "unreachable";
      service.pid = service.daemonState.pid;
      service.error = "daemon state exists but project service endpoint is missing";
    }

    const dashboards = listDashboardReports({
      tmux,
      tmuxAvailable,
      sessionNames,
      projectRoot: knownProject.projectRoot,
      expectedDashboardBuildStamp,
      expectedRuntimeOwner,
      cliLaunch,
    });
    const project = {
      projectRoot: knownProject.projectRoot,
      sources: sortedSources(knownProject.sources),
      expectedDashboardBuildStamp,
      service,
      dashboards,
      status: "ok" as RuntimeCoherenceProjectStatus,
    };
    project.status = projectStatus(project);
    projects.push(project);
  }

  const ok = projects.filter((project) => project.status === "ok").length;
  return {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    cliVersion: AIMUX_VERSION,
    cliLaunch,
    expected: {
      projectService: expectedService,
      runtimeOwner: expectedRuntimeOwner,
    },
    daemon: {
      running: Boolean(daemonInfo),
      info: daemonInfo,
      process: buildProcessReport({
        pid: daemonInfo?.pid ?? null,
        args: daemonInfo?.pid ? readProcessArgs(daemonInfo.pid) : null,
        cliLaunch,
      }),
      projectCount: Object.keys(daemonState.projects).length,
    },
    tmux: {
      available: tmuxAvailable,
      version: tmuxAvailable ? tmux.getVersion() : null,
      sessionCount: sessionNames.length,
    },
    projects,
    staleHookProcesses: listStaleHookProcesses({ listProcessArgs, cliLaunch }),
    summary: {
      projects: projects.length,
      ok,
      needsRestart: projects.length - ok,
    },
  };
}

function formatManifest(manifest: Partial<ProjectServiceManifest> | null): string {
  if (!manifest) return "(unknown)";
  return `api=${manifest.apiVersion ?? "?"} build=${manifest.buildStamp ?? "?"}`;
}

function formatEndpoint(endpoint: MetadataApiEndpoint | null): string {
  return endpoint ? `${endpoint.host}:${endpoint.port}` : "(none)";
}

function renderProcess(label: string, process: RuntimeCoherenceProcessReport | null): string[] {
  if (!process) return [`    ${label}: (unknown)`];
  const stale = process.staleNativePath ? " stale-native-path=yes" : "";
  const lines = [`    ${label}: pid=${process.pid ?? "(unknown)"}${stale}`];
  if (process.argsPreview) lines.push(`      args: ${process.argsPreview}`);
  if (process.pathHints.length > 0) lines.push(`      native paths: ${process.pathHints.join(", ")}`);
  if (process.error) lines.push(`      error: ${process.error}`);
  return lines;
}

export function renderRuntimeCoherenceReport(report: RuntimeCoherenceReport): string {
  const lines = [
    "Aimux Versions",
    `  cli version: ${report.cliVersion}`,
    `  cli launcher: ${report.cliLaunch.source} ${report.cliLaunch.command} ${report.cliLaunch.args.join(" ")}`.trim(),
    `  cli current entry: ${report.cliLaunch.currentEntryPath}`,
    `  cli stable shim: ${report.cliLaunch.stableShimPath}`,
    `  expected project service: ${formatManifest(report.expected.projectService)}`,
    `  expected runtime owner: ${report.expected.runtimeOwner}`,
    `  daemon: ${report.daemon.running ? `running pid=${report.daemon.info?.pid}` : "not running"}`,
    ...renderProcess("daemon process", report.daemon.process),
    `  daemon projects: ${report.daemon.projectCount}`,
    `  tmux: ${report.tmux.available ? (report.tmux.version ?? "available") : "unavailable"}`,
    `  tmux sessions: ${report.tmux.sessionCount}`,
    `  projects: ${report.summary.projects} (${report.summary.ok} ok, ${report.summary.needsRestart} need restart)`,
  ];

  for (const project of report.projects) {
    lines.push("");
    lines.push(`Project ${project.status === "ok" ? "ok" : "needs-restart"}: ${project.projectRoot}`);
    lines.push(`  sources: ${project.sources.join(", ") || "(none)"}`);
    lines.push(
      `  service: ${project.service.status} endpoint=${formatEndpoint(project.service.endpoint)} pid=${project.service.pid ?? "(unknown)"}`,
    );
    lines.push(...renderProcess("process", project.service.process));
    lines.push(`    running: ${formatManifest(project.service.serviceInfo)}`);
    lines.push(`    expected: ${formatManifest(report.expected.projectService)}`);
    if (project.service.error) lines.push(`    error: ${project.service.error}`);
    if (project.dashboards.length === 0) {
      lines.push("  dashboards: none");
      continue;
    }
    lines.push("  dashboards:");
    for (const dashboard of project.dashboards) {
      lines.push(
        `    ${dashboard.status} ${dashboard.sessionName}:${dashboard.windowId} ${dashboard.windowName} alive=${dashboard.alive ? "yes" : "no"}`,
      );
      if (dashboard.process) {
        lines.push(...renderProcess("process", dashboard.process).map((line) => `  ${line}`));
      }
      lines.push(`      build: ${dashboard.buildStamp ?? "(missing)"} expected=${project.expectedDashboardBuildStamp}`);
      lines.push(
        `      owner: ${dashboard.owner ?? "(missing)"} runtimeOwner=${dashboard.runtimeOwner ?? "(missing)"}`,
      );
    }
  }

  if (report.staleHookProcesses.length > 0) {
    lines.push("");
    lines.push(`Stale hook processes: ${report.staleHookProcesses.length}`);
    for (const process of report.staleHookProcesses.slice(0, 10)) {
      lines.push(...renderProcess("hook process", process).map((line) => line.replace(/^ {4}/, "  ")));
    }
  }

  return lines.join("\n");
}
