import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import { ensureProjectPaths, getProjectIdFor, initPaths } from "./paths.js";
import { listRegisteredDesktopProjects } from "./project-scanner.js";
import { loadMetadataEndpointByProjectId, removeMetadataEndpoint } from "./metadata-store.js";
import { requestJson } from "./http-client.js";
import { log } from "./debug.js";
import { RelayClient, type RelayNotificationPush, type RelayStatusSnapshot } from "./relay-client.js";
import { MobilePushThrottle } from "./mobile-push-throttle.js";
import { clearCredentials, loadCredentials, setRemoteEnabled } from "./credentials.js";
import { loadConfig } from "./config.js";
import { assertRemoteAccessAllowed, parseRemoteActor } from "./remote-access.js";
import { PROJECT_API_ROUTES } from "./project-api-contract.js";
import {
  CORE_API_ROUTES,
  CORE_COMMAND_NAMES,
  assertNeverCoreCommand,
  isCoreCommandName,
  type CoreCommandEnvelope,
  type CoreCommandName,
  type CoreCommandResponse,
  type CoreRelaySnapshot,
  type CoreRestartResult,
  type CoreStatusProject,
} from "./core-command-contract.js";
import {
  renderCoreDaemonProjectsLines,
  renderCoreDaemonStatusLines,
  renderCoreAgentInputLines,
  renderCoreAgentMigrateLines,
  renderCoreAgentPsLines,
  renderCoreAgentRenameLines,
  renderCoreHostStatusLines,
  renderCoreLifecycleForkLines,
  renderCoreLifecycleKillLines,
  renderCoreLifecycleSpawnLines,
  renderCoreLifecycleStopLines,
  renderCoreLoopAddLines,
  renderCoreLoopBlockLines,
  renderCoreLoopDoneLines,
  renderCoreLoopRemoveLines,
  renderCoreLoginLines,
  renderCoreLogoutLines,
  renderCoreHandoffMutationLines,
  renderCoreHandoffSendLines,
  renderCoreMessageSendLines,
  renderCoreNotificationClearLines,
  renderCoreNotificationReadLines,
  renderCoreNotificationsListLines,
  renderCoreNotificationSendLines,
  renderCoreOverseerClearLines,
  renderCoreOverseerStartLines,
  renderCoreProjectEnsureLines,
  renderCoreProjectKillLines,
  renderCoreProjectRestartLines,
  renderCoreProjectServeLines,
  renderCoreProjectStopLines,
  renderCoreProjectsListLines,
  renderCoreTeamAddLines,
  renderCoreTeamDefaultLines,
  renderCoreTeamInitLines,
  renderCoreTeamRemoveLines,
  renderCoreTeamShowLines,
  renderCoreReviewRequestChangesLines,
  renderCoreRemoteDisableLines,
  renderCoreRemoteEnableLines,
  renderCoreRemoteStatusLines,
  renderCoreSecurityUnlockLines,
  renderCoreTaskListLines,
  renderCoreTaskMutationLines,
  renderCoreTaskShowLines,
  renderCoreThreadListLines,
  renderCoreThreadMarkSeenLines,
  renderCoreThreadOpenLines,
  renderCoreThreadSendLines,
  renderCoreThreadShowLines,
  renderCoreThreadStatusLines,
  renderCoreGraveyardAgentLines,
  renderCoreGraveyardCleanupLines,
  renderCoreGraveyardLines,
  renderCoreWorktreeCreateLines,
  renderCoreWorktreeDeleteGraveyardLines,
  renderCoreWorktreeGraveyardLines,
  renderCoreWorktreeListLines,
  renderCoreWorktreeRemoveLines,
  renderCoreWorktreeResurrectLines,
  renderCoreWhoamiLines,
  coreWhoamiJson,
  type CoreDaemonStatusTextPayload,
  type CoreAgentInputTextPayload,
  type CoreAgentMigrateTextPayload,
  type CoreAgentRenameTextPayload,
  type CoreAgentSummaryTextPayload,
  type CoreGraveyardAgentTextPayload,
  type CoreGraveyardCleanupTextPayload,
  type CoreGraveyardTextPayload,
  type CoreHandoffMutationTextPayload,
  type CoreHandoffSendTextPayload,
  type CoreHostStatusTextPayload,
  type CoreLifecycleForkTextPayload,
  type CoreLifecycleKillTextPayload,
  type CoreLifecycleSpawnTextPayload,
  type CoreLifecycleStopTextPayload,
  type CoreLoopTextPayload,
  type CoreMessageSendTextPayload,
  type CoreNotificationClearTextPayload,
  type CoreNotificationReadTextPayload,
  type CoreNotificationsListTextPayload,
  type CoreOverseerTextPayload,
  type CoreProjectRestartTextPayload,
  type CoreProjectServiceMutationTextPayload,
  type CoreRemoteStatusTextPayload,
  type CoreReviewRequestChangesTextPayload,
  type CoreTaskListTextPayload,
  type CoreTaskMutationTextPayload,
  type CoreTaskShowTextPayload,
  type CoreTeamTextPayload,
  type CoreThreadListTextPayload,
  type CoreThreadOpenTextPayload,
  type CoreThreadSendTextPayload,
  type CoreThreadShowTextPayload,
  type CoreThreadStatusTextPayload,
  type CoreWorktreeCreateTextPayload,
  type CoreWorktreePathTextPayload,
  type CoreWorktreeSummaryTextPayload,
  type CoreWhoamiTextPayload,
} from "./core-text.js";
import { runLoginFlow } from "./login-flow.js";
import { getProjectServiceManifest } from "./project-service-manifest.js";
import { buildRuntimeCoherenceReport, renderRuntimeCoherenceReport } from "./runtime-coherence.js";
import { renderRuntimeRestartResult, restartAimuxControlPlane } from "./runtime-restart.js";
import { resolveDashboardTarget } from "./dashboard/targets.js";
import { isAimuxProjectServiceProcess, isPidAlive } from "./process-inspector.js";
import { reconcileOfflineBackendSessionIds } from "./runtime-core/backend-id-reconcile.js";
import { CoreProjectActor } from "./core-project-actor.js";
import { findMainRepo } from "./worktree.js";
import {
  buildTmuxDoctorReport,
  renderTmuxDoctorReport,
  renderTmuxRepairResult,
  repairTmuxRuntime,
} from "./tmux/doctor.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import {
  clearDaemonInfo,
  getDaemonBaseUrl,
  getDaemonHost,
  getDaemonPort,
  loadDaemonInfo,
  loadDaemonState,
  saveDaemonInfo,
  saveDaemonState,
  type AimuxDaemonInfo,
  type DaemonState,
  type ProjectServiceState,
} from "./daemon-state.js";
import { createAgentOutputSseTextHandler } from "./agent-output-stream.js";
import { clearLogFile, parseLineCount, readLastLogLines, selectedLogPath } from "./logs.js";
import { parseRuntimeMetadataCliArgs } from "./metadata-cli-routing.js";

const PROJECT_SERVICE_TERM_GRACE_MS = 2_000;
const PROJECT_SERVICE_KILL_GRACE_MS = 3_000;
const PROJECT_SERVICE_EXIT_POLL_MS = 50;
const PROXY_TIMEOUT_MS = 10_000;
const CLI_PROJECT_MUTATION_TIMEOUT_MS = 120_000;
const DAEMON_HEALTH_KIND = "aimux-daemon";
const AUTH_FLOW_TTL_MS = 10 * 60 * 1000;
const LOCAL_AUTH_ROUTES = new Set<string>([
  CORE_API_ROUTES.loginStartText,
  CORE_API_ROUTES.loginWaitText,
  CORE_API_ROUTES.loginText,
  CORE_API_ROUTES.securityUnlockStartText,
  CORE_API_ROUTES.securityUnlockWaitText,
  CORE_API_ROUTES.securityUnlockText,
]);
const LOCAL_CLI_TEXT_ROUTES = new Set<string>([
  CORE_API_ROUTES.doctorTmuxText,
  CORE_API_ROUTES.doctorVersionsText,
  CORE_API_ROUTES.graveyardCleanupText,
  CORE_API_ROUTES.graveyardListText,
  CORE_API_ROUTES.graveyardResurrectText,
  CORE_API_ROUTES.graveyardSendText,
  CORE_API_ROUTES.handoffAcceptText,
  CORE_API_ROUTES.handoffCompleteText,
  CORE_API_ROUTES.handoffSendText,
  CORE_API_ROUTES.agentInputText,
  CORE_API_ROUTES.agentMigrateText,
  CORE_API_ROUTES.agentPsText,
  CORE_API_ROUTES.agentRenameText,
  CORE_API_ROUTES.hostAgentReadText,
  CORE_API_ROUTES.hostAgentStreamText,
  CORE_API_ROUTES.lifecycleForkText,
  CORE_API_ROUTES.lifecycleKillText,
  CORE_API_ROUTES.lifecycleSpawnText,
  CORE_API_ROUTES.lifecycleStopText,
  CORE_API_ROUTES.logsClearText,
  CORE_API_ROUTES.logsPathText,
  CORE_API_ROUTES.logsTailText,
  CORE_API_ROUTES.metadataText,
  CORE_API_ROUTES.loopAddText,
  CORE_API_ROUTES.loopBlockText,
  CORE_API_ROUTES.loopDoneText,
  CORE_API_ROUTES.loopRemoveText,
  CORE_API_ROUTES.messageSendText,
  CORE_API_ROUTES.notificationClearText,
  CORE_API_ROUTES.notificationListText,
  CORE_API_ROUTES.notificationReadText,
  CORE_API_ROUTES.notificationSendText,
  CORE_API_ROUTES.overseerClearText,
  CORE_API_ROUTES.overseerStartText,
  CORE_API_ROUTES.projectEnsureText,
  CORE_API_ROUTES.teamAddText,
  CORE_API_ROUTES.teamDefaultText,
  CORE_API_ROUTES.teamInitText,
  CORE_API_ROUTES.teamRemoveText,
  CORE_API_ROUTES.teamShowText,
  CORE_API_ROUTES.projectKillText,
  CORE_API_ROUTES.projectRestartText,
  CORE_API_ROUTES.projectServeText,
  CORE_API_ROUTES.projectStopText,
  CORE_API_ROUTES.repairText,
  CORE_API_ROUTES.restartText,
  CORE_API_ROUTES.reviewApproveText,
  CORE_API_ROUTES.reviewRequestChangesText,
  CORE_API_ROUTES.taskAcceptText,
  CORE_API_ROUTES.taskAssignText,
  CORE_API_ROUTES.taskBlockText,
  CORE_API_ROUTES.taskCompleteText,
  CORE_API_ROUTES.taskListText,
  CORE_API_ROUTES.taskReopenText,
  CORE_API_ROUTES.taskShowText,
  CORE_API_ROUTES.threadListText,
  CORE_API_ROUTES.threadMarkSeenText,
  CORE_API_ROUTES.threadOpenText,
  CORE_API_ROUTES.threadSendText,
  CORE_API_ROUTES.threadShowText,
  CORE_API_ROUTES.threadStatusText,
  CORE_API_ROUTES.threadsListText,
  CORE_API_ROUTES.worktreeCreateText,
  CORE_API_ROUTES.worktreeDeleteGraveyardText,
  CORE_API_ROUTES.worktreeGraveyardText,
  CORE_API_ROUTES.worktreeListText,
  CORE_API_ROUTES.worktreeRemoveText,
  CORE_API_ROUTES.worktreeResurrectText,
]);
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

type ProjectsRouteProject = ReturnType<typeof listRegisteredDesktopProjects>[number] & {
  service: ProjectServiceState | null;
  serviceAlive: boolean;
  serviceEndpoint: ReturnType<typeof loadMetadataEndpointByProjectId>;
};

interface DaemonRouteResponse {
  status: number;
  body: unknown;
  contentType?: string;
}

type ProjectServiceJson = Record<string, unknown> & { ok?: boolean; error?: unknown };
type ProjectServiceJsonResult =
  | { ok: true; projectRoot: string; json: ProjectServiceJson }
  | { ok: false; response: DaemonRouteResponse };

type AuthAction = "security-unlock" | undefined;

interface DaemonAuthFlow {
  promise: Promise<{ userId: string; relay: CoreRelaySnapshot }>;
  startedAt: number;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  const contentType = String(req.headers["content-type"] ?? "");
  if (body && contentType.startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(body).entries());
  }
  return body ? JSON.parse(body) : {};
}

function requestHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
  }
  return headers;
}

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = contentType.startsWith("text/") ? String(body) : JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", contentType);
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

export class AimuxDaemon {
  private server: Server | null = null;
  private relayClient: RelayClient | null = null;
  private readonly pushThrottle = new MobilePushThrottle();
  private readonly projectActors = new Map<string, CoreProjectActor>();
  private readonly projectEnsurePromises = new Map<string, Promise<ProjectServiceState>>();
  private readonly authFlows = new Map<string, DaemonAuthFlow>();
  private state: DaemonState = loadDaemonState();

  async start(): Promise<void> {
    if (this.server) return;
    saveDaemonInfo({
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

  private enableRelayBestEffort(): CoreRelaySnapshot {
    try {
      return this.enableRelay();
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      const relay = this.getRelayStatus();
      if (relay.status === "off") return { status: "disconnected", relayUrl: "", lastConnectedAt: null, lastError };
      return { ...relay, lastError };
    }
  }

  disableRelay(): { status: "off" } {
    setRemoteEnabled(false);
    this.relayClient?.disconnect();
    this.relayClient = null;
    return { status: "off" };
  }

  stop(): void {
    log.info("daemon stopping project actors", "daemon", { projectCount: Object.keys(this.state.projects).length });
    this.relayClient?.disconnect();
    this.relayClient = null;
    for (const actor of this.projectActors.values()) {
      void actor.stop().catch((error: unknown) => {
        log.warn("project actor stop failed during daemon shutdown", "daemon", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    this.projectActors.clear();
    this.state = {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {},
    };
    saveDaemonState(this.state);
    clearDaemonInfo();
    this.server?.close();
    this.server = null;
  }

  private refreshState(): void {
    const nextProjects: Record<string, ProjectServiceState> = { ...this.state.projects };
    for (const [projectId, actor] of this.projectActors.entries()) {
      if (actor.isRunning()) {
        nextProjects[projectId] = actor.getState();
      }
    }
    for (const [projectId, entry] of Object.entries(this.state.projects)) {
      if (this.projectActors.has(projectId)) continue;
      nextProjects[projectId] = entry;
    }
    this.state = {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: nextProjects,
    };
    saveDaemonState(this.state);
    saveDaemonInfo({
      pid: process.pid,
      port: getDaemonPort(),
      startedAt: loadDaemonInfo()?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies AimuxDaemonInfo);
  }

  private isProjectServiceLive(entry: ProjectServiceState): boolean {
    const actor = this.projectActors.get(entry.projectId);
    return entry.pid === process.pid && Boolean(actor?.isRunning());
  }

  private listProjectsForRoute(): ProjectsRouteProject[] {
    const servicesById = this.state.projects;
    return listRegisteredDesktopProjects().map((project) => {
      const service = servicesById[project.id] ?? null;
      const serviceAlive = service ? this.isProjectServiceLive(service) : false;
      return {
        ...project,
        service: serviceAlive ? service : null,
        serviceAlive,
        serviceEndpoint: loadMetadataEndpointByProjectId(project.id),
      };
    });
  }

  private daemonStatusTextPayload(
    projects: CoreStatusProject[] = this.listProjectsForRoute(),
  ): CoreDaemonStatusTextPayload {
    const serviceAliveById = new Map(projects.map((project) => [project.id, project.serviceAlive]));
    const daemon = this.currentDaemonInfo(new Date().toISOString());
    return {
      daemon: { ...daemon, serviceInfo: getProjectServiceManifest() },
      projects: Object.values(this.state.projects).map((project) => ({
        ...project,
        serviceAlive: serviceAliveById.get(project.projectId) ?? false,
      })),
      relay: this.getRelayStatus(),
    };
  }

  private daemonEnsurePayload(issuedAt: string): { daemon: AimuxDaemonInfo & { serviceInfo: unknown } } {
    return {
      daemon: { ...this.currentDaemonInfo(issuedAt), serviceInfo: getProjectServiceManifest() },
    };
  }

  private remoteStatusTextPayload(): CoreRemoteStatusTextPayload {
    const credentials = loadCredentials();
    return {
      credentials: credentials ? { relayUrl: credentials.relayUrl, remoteEnabled: credentials.remoteEnabled } : null,
      relay: this.getRelayStatus(),
    };
  }

  private whoamiTextPayload(): CoreWhoamiTextPayload {
    const credentials = loadCredentials();
    return {
      credentials: credentials
        ? {
            userId: credentials.userId,
            relayUrl: credentials.relayUrl,
            remoteEnabled: credentials.remoteEnabled,
          }
        : null,
    };
  }

  private hostStatusPayload(
    cwd: string,
    issuedAt: string,
  ): { payload: CoreHostStatusTextPayload; knownProject: boolean } {
    const projectRoot = this.resolveProjectRoot(cwd);
    const project = this.findProjectForRoot(projectRoot);
    const daemon = { ...this.currentDaemonInfo(issuedAt), serviceInfo: getProjectServiceManifest() };
    return {
      payload: {
        projectRoot,
        sessionName: project?.dashboardSessionName ?? null,
        daemon,
        projectService: project?.service ?? null,
        serviceAlive: project?.serviceAlive ?? false,
        metadataEndpoint: project?.serviceEndpoint ?? null,
        expectedServiceManifest: daemon.serviceInfo,
      },
      knownProject: Boolean(project),
    };
  }

  private resolveProjectRoot(cwd: string): string {
    try {
      return findMainRepo(cwd);
    } catch {
      return cwd;
    }
  }

  private findProjectForRoot(projectRoot: string): CoreStatusProject | null {
    const resolvedRoot = pathResolve(projectRoot);
    return this.listProjectsForRoute().find((project) => pathResolve(project.path) === resolvedRoot) ?? null;
  }

  private textOrJsonLines(routeUrl: URL, json: unknown, lines: string[]): DaemonRouteResponse {
    if (routeUrl.searchParams.get("json") === "1") {
      return { status: 200, body: `${JSON.stringify(json, null, 2)}\n`, contentType: "text/plain; charset=utf-8" };
    }
    return { status: 200, body: `${lines.join("\n")}\n`, contentType: "text/plain; charset=utf-8" };
  }

  private textError(status: number, message: string): DaemonRouteResponse {
    return { status, body: `${message}\n`, contentType: "text/plain; charset=utf-8" };
  }

  private logSelectionOptions(routeUrl: URL): { daemon: boolean; project?: string } {
    return {
      daemon: routeUrl.searchParams.get("daemon") === "1",
      project: routeUrl.searchParams.get("project") ?? undefined,
    };
  }

  private logsPathTextRoute(routeUrl: URL): DaemonRouteResponse {
    try {
      const path = selectedLogPath(this.logSelectionOptions(routeUrl));
      return { status: 200, body: `${path}\n`, contentType: "text/plain; charset=utf-8" };
    } catch (error) {
      return this.textError(500, `Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private logsTailTextRoute(routeUrl: URL): DaemonRouteResponse {
    try {
      const path = selectedLogPath(this.logSelectionOptions(routeUrl));
      const output = readLastLogLines(path, parseLineCount(routeUrl.searchParams.get("lines") ?? undefined));
      if (!output) return this.textError(404, `No log entries at ${path}`);
      return { status: 200, body: `${output}\n`, contentType: "text/plain; charset=utf-8" };
    } catch (error) {
      return this.textError(500, `Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private logsClearTextRoute(routeUrl: URL): DaemonRouteResponse {
    try {
      const path = selectedLogPath(this.logSelectionOptions(routeUrl));
      clearLogFile(path);
      return { status: 200, body: `Cleared ${path}\n`, contentType: "text/plain; charset=utf-8" };
    } catch (error) {
      return this.textError(500, `Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private projectRootTextParam(routeUrl: URL, body: unknown): string | DaemonRouteResponse {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    return this.resolveProjectRoot(project);
  }

  private async projectServeTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const projectRoot = this.projectRootTextParam(routeUrl, body);
    if (typeof projectRoot !== "string") return projectRoot;
    const project = await this.ensureProject(projectRoot);
    const payload = { project };
    return this.textOrJsonLines(routeUrl, payload, renderCoreProjectServeLines(payload));
  }

  private async projectStopTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const projectRoot = this.projectRootTextParam(routeUrl, body);
    if (typeof projectRoot !== "string") return projectRoot;
    const project = await this.stopProject(projectRoot);
    const payload: CoreProjectServiceMutationTextPayload = { projectRoot, project };
    return this.textOrJsonLines(routeUrl, payload, renderCoreProjectStopLines(payload));
  }

  private async projectKillTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const projectRoot = this.projectRootTextParam(routeUrl, body);
    if (typeof projectRoot !== "string") return projectRoot;
    const project = await this.stopProject(projectRoot, { force: true });
    const payload: CoreProjectServiceMutationTextPayload = { projectRoot, project };
    return this.textOrJsonLines(routeUrl, payload, renderCoreProjectKillLines(payload));
  }

  private async projectRestartTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const projectRoot = this.projectRootTextParam(routeUrl, body);
    if (typeof projectRoot !== "string") return projectRoot;
    const serveOnly = this.booleanParam(routeUrl, body, "serve", false);
    await this.stopProject(projectRoot);
    const project = await this.ensureProject(projectRoot);
    let dashboardSessionName: string | undefined;
    if (!serveOnly) {
      const tmux = new TmuxRuntimeManager();
      const { dashboardSession } = resolveDashboardTarget(projectRoot, tmux, { forceReload: true });
      dashboardSessionName = dashboardSession.sessionName;
    }
    const payload: CoreProjectRestartTextPayload = { projectRoot, project, dashboardSessionName };
    return this.textOrJsonLines(routeUrl, payload, renderCoreProjectRestartLines(payload));
  }

  private async metadataTextRoute(routeUrl: URL): Promise<DaemonRouteResponse> {
    const project = routeUrl.searchParams.get("project");
    if (!project) return this.textError(400, "project query is required");
    const rawArgs = routeUrl.searchParams.getAll("arg");
    const argsText = routeUrl.searchParams.get("args");
    const args = rawArgs.length > 0 ? rawArgs : (argsText?.split("\n").filter(Boolean) ?? []);
    const parsed = parseRuntimeMetadataCliArgs(args);
    if (!parsed.ok) return this.textError(400, parsed.error);
    const projectRoot = this.resolveProjectRoot(project);
    if (parsed.command === "endpoint") {
      await this.ensureProject(projectRoot);
      const endpoint = loadMetadataEndpointByProjectId(getProjectIdFor(projectRoot));
      if (!endpoint) return this.textError(503, `Error: project service unavailable for ${projectRoot}`);
      return {
        status: 200,
        body: `http://${endpoint.host}:${endpoint.port}\n`,
        contentType: "text/plain; charset=utf-8",
      };
    }
    const result = await this.postProjectServiceJson(projectRoot, parsed.routePath, parsed.body);
    if (!result.ok) return result.response;
    return { status: 200, body: "", contentType: "text/plain; charset=utf-8" };
  }

  private isRouteResponse(value: unknown): value is DaemonRouteResponse {
    return Boolean(
      value &&
      typeof value === "object" &&
      typeof (value as { status?: unknown }).status === "number" &&
      "body" in value,
    );
  }

  private stringParam(routeUrl: URL, body: unknown, name: string): string | undefined {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const bodyValue = record[name];
    if (typeof bodyValue === "string") return bodyValue;
    return routeUrl.searchParams.get(name) ?? undefined;
  }

  private requiredParam(routeUrl: URL, body: unknown, name: string): string | DaemonRouteResponse {
    const value = this.stringParam(routeUrl, body, name);
    if (!value?.trim()) return this.textError(400, `${name} is required`);
    return value;
  }

  private booleanParam(routeUrl: URL, body: unknown, name: string, defaultValue: boolean): boolean {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const bodyValue = record[name];
    if (typeof bodyValue === "boolean") return bodyValue;
    if (typeof bodyValue === "number") return bodyValue !== 0;
    const value = this.stringParam(routeUrl, body, name);
    if (value === undefined) return defaultValue;
    return value !== "0" && value !== "false";
  }

  private integerParam(
    routeUrl: URL,
    body: unknown,
    name: string,
    defaultValue: number,
    flagName = name,
  ): number | DaemonRouteResponse {
    const raw = this.stringParam(routeUrl, body, name);
    if (raw === undefined || raw.trim() === "") return defaultValue;
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) return this.textError(400, `Error: --${flagName} must be an integer`);
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value)) return this.textError(400, `Error: --${flagName} must be a safe integer`);
    return value;
  }

  private resolveLifecycleWorktree(projectRoot: string, worktreePath: string | undefined): string | undefined {
    if (!worktreePath) return undefined;
    return worktreePath.startsWith("/") ? pathResolve(worktreePath) : pathResolve(projectRoot, worktreePath);
  }

  private requiredProjectServiceString(
    json: ProjectServiceJson,
    action: string,
    field: string,
  ): string | DaemonRouteResponse {
    const value = json[field];
    if (typeof value === "string" && value.trim()) return value;
    return this.textError(502, `Error: project service returned invalid ${action} response: ${field} is required`);
  }

  private requiredProjectServiceArray(
    json: ProjectServiceJson,
    action: string,
    field: string,
  ): unknown[] | DaemonRouteResponse {
    const value = json[field];
    if (Array.isArray(value)) return value;
    return this.textError(502, `Error: project service returned invalid ${action} response: ${field} is required`);
  }

  private requiredProjectServiceObject(
    json: ProjectServiceJson,
    action: string,
    field: string,
  ): Record<string, unknown> | DaemonRouteResponse {
    const value = json[field];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    return this.textError(502, `Error: project service returned invalid ${action} response: ${field} is required`);
  }

  private csvParam(routeUrl: URL, body: unknown, name: string): string[] | undefined {
    const value = this.stringParam(routeUrl, body, name);
    if (value === undefined) return undefined;
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private notificationIdsParam(routeUrl: URL, body: unknown): string[] | DaemonRouteResponse | undefined {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (Object.prototype.hasOwnProperty.call(record, "ids")) {
      const value = record.ids;
      if (Array.isArray(value) && value.every((id) => typeof id === "string")) {
        return value.map((id) => id.trim()).filter(Boolean);
      }
      if (typeof value === "string")
        return value
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
      return this.textError(400, "ids must be an array of strings");
    }
    const queryValues = routeUrl.searchParams.getAll("ids");
    if (queryValues.length === 0) return undefined;
    return queryValues.flatMap((value) =>
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    );
  }

  private notificationMutationPayload(routeUrl: URL, body: unknown): Record<string, unknown> | DaemonRouteResponse {
    const payload: Record<string, unknown> = {};
    const id = this.stringParam(routeUrl, body, "id")?.trim();
    const ids = this.notificationIdsParam(routeUrl, body);
    if (this.isRouteResponse(ids)) return ids;
    const sessionId = this.stringParam(routeUrl, body, "sessionId")?.trim();
    if (id) payload.id = id;
    if (ids !== undefined) payload.ids = ids;
    if (sessionId) payload.sessionId = sessionId;
    return payload;
  }

  private async getProjectServiceJson(
    projectRoot: string,
    routePath: string,
    opts: { ensureProject?: boolean } = {},
  ): Promise<ProjectServiceJsonResult> {
    return await this.requestProjectServiceJson(projectRoot, routePath, opts);
  }

  private async postProjectServiceJson(
    projectRoot: string,
    routePath: string,
    body: Record<string, unknown>,
    opts: { ensureProject?: boolean; timeoutMs?: number } = {},
  ): Promise<ProjectServiceJsonResult> {
    return await this.requestProjectServiceJson(projectRoot, routePath, { ...opts, method: "POST", body });
  }

  private async requestProjectServiceJson(
    projectRoot: string,
    routePath: string,
    opts: { ensureProject?: boolean; method?: string; body?: Record<string, unknown>; timeoutMs?: number } = {},
  ): Promise<ProjectServiceJsonResult> {
    const resolvedRoot = this.resolveProjectRoot(projectRoot);
    try {
      if (opts.ensureProject !== false) await this.ensureProject(resolvedRoot);
      const endpoint = loadMetadataEndpointByProjectId(getProjectIdFor(resolvedRoot));
      if (!endpoint) {
        return { ok: false, response: this.textError(503, `Error: project service unavailable for ${resolvedRoot}`) };
      }
      const { status, json } = await requestJson<ProjectServiceJson>(
        `http://${endpoint.host}:${endpoint.port}${routePath}`,
        {
          ...(opts.method ? { method: opts.method } : {}),
          ...(opts.body ? { headers: { "content-type": "application/json" }, body: opts.body } : {}),
          timeoutMs: opts.timeoutMs ?? PROXY_TIMEOUT_MS,
        },
      );
      if (status < 200 || status >= 300 || json?.ok === false) {
        return {
          ok: false,
          response: this.textError(
            status || 502,
            `Error: ${json?.error ? String(json.error) : `project service returned ${status}`}`,
          ),
        };
      }
      return { ok: true, projectRoot: resolvedRoot, json };
    } catch (error) {
      return {
        ok: false,
        response: this.textError(502, `Error: ${error instanceof Error ? error.message : String(error)}`),
      };
    }
  }

  private resolveProjectRelativePath(projectRoot: string, targetPath: string): string {
    return targetPath.startsWith("/") ? pathResolve(targetPath) : pathResolve(projectRoot, targetPath);
  }

  private async worktreeListTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const result = await this.getProjectServiceJson(project, PROJECT_API_ROUTES.worktrees);
    if (!result.ok) return result.response;
    const worktrees = this.requiredProjectServiceArray(result.json, "worktree list", "worktrees");
    if (!Array.isArray(worktrees)) return worktrees;
    const payload: CoreWorktreeSummaryTextPayload = { worktrees };
    return this.textOrJsonLines(routeUrl, worktrees, renderCoreWorktreeListLines(payload));
  }

  private async hostAgentReadTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const sessionId = this.requiredParam(routeUrl, body, "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const startLine = this.integerParam(routeUrl, body, "startLine", -120, "start-line");
    if (typeof startLine !== "number") return startLine;

    const params = new URLSearchParams({ sessionId, startLine: String(startLine) });
    const result = await this.getProjectServiceJson(project, `${PROJECT_API_ROUTES.livePane.output}?${params}`);
    if (!result.ok) return result.response;
    const output = typeof result.json.output === "string" ? result.json.output : "";
    return {
      status: 200,
      body: output.length > 0 && !output.endsWith("\n") ? `${output}\n` : output,
      contentType: "text/plain; charset=utf-8",
    };
  }

  private async resolveHostAgentStreamTextRoute(
    routeUrl: URL,
    headers?: Record<string, string>,
  ): Promise<{ ok: true; url: string; sessionId: string } | { ok: false; response: DaemonRouteResponse }> {
    this.refreshState();
    const pathname = routeUrl.pathname;
    const actor = parseRemoteActor(headers);
    const access = assertRemoteAccessAllowed(actor, "GET", pathname, routeUrl.searchParams);
    if (!access.ok) {
      return {
        ok: false,
        response: { status: access.status ?? 403, body: { ok: false, error: access.error ?? "remote access denied" } },
      };
    }
    if (actor) {
      return { ok: false, response: this.textError(403, "core text routes are loopback-only") };
    }
    if (headers?.origin || headers?.Origin) {
      return { ok: false, response: this.textError(403, "core text routes are cli-only") };
    }

    const project = this.requiredParam(routeUrl, undefined, "project");
    if (typeof project !== "string") return { ok: false, response: project };
    const sessionId = this.requiredParam(routeUrl, undefined, "sessionId");
    if (typeof sessionId !== "string") return { ok: false, response: sessionId };
    const startLine = this.integerParam(routeUrl, undefined, "startLine", -120, "start-line");
    if (typeof startLine !== "number") return { ok: false, response: startLine };
    const intervalMs = this.integerParam(routeUrl, undefined, "intervalMs", 500, "interval-ms");
    if (typeof intervalMs !== "number") return { ok: false, response: intervalMs };
    if (intervalMs < 100) {
      return { ok: false, response: this.textError(400, "Error: --interval-ms must be an integer >= 100") };
    }

    const projectRoot = this.resolveProjectRoot(project);
    try {
      await this.ensureProject(projectRoot);
      const endpoint = loadMetadataEndpointByProjectId(getProjectIdFor(projectRoot));
      if (!endpoint) {
        return {
          ok: false,
          response: this.textError(503, `Error: project service unavailable for ${projectRoot}`),
        };
      }
      const params = new URLSearchParams({ sessionId, startLine: String(startLine), intervalMs: String(intervalMs) });
      return {
        ok: true,
        sessionId,
        url: `http://${endpoint.host}:${endpoint.port}${PROJECT_API_ROUTES.agents.outputStream}?${params}`,
      };
    } catch (error) {
      return {
        ok: false,
        response: this.textError(502, `Error: ${error instanceof Error ? error.message : String(error)}`),
      };
    }
  }

  private async pipeHostAgentStreamText(upstreamUrl: string, sessionId: string, res: ServerResponse): Promise<void> {
    const controller = new AbortController();
    let downstreamClosed = false;
    const abortUpstream = () => {
      downstreamClosed = true;
      controller.abort();
    };
    res.once("close", abortUpstream);
    res.once("error", abortUpstream);
    try {
      const upstream = await fetch(upstreamUrl, {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => "");
        const message = text.trim() || `request failed: ${upstream.status}`;
        send(res, upstream.status || 502, `${message}\n`, "text/plain; charset=utf-8");
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("connection", "close");
      const decoder = new TextDecoder();
      const textHandler = createAgentOutputSseTextHandler(sessionId, (text) => {
        if (!res.writableEnded) res.write(text);
      });
      for await (const chunk of upstream.body) {
        textHandler.pushChunkText(decoder.decode(chunk, { stream: true }));
      }
      if (!res.writableEnded) res.end();
    } catch (error) {
      if (downstreamClosed || (error instanceof Error && error.name === "AbortError")) return;
      if (!res.headersSent) {
        send(res, 502, `${error instanceof Error ? error.message : String(error)}\n`, "text/plain; charset=utf-8");
        return;
      }
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    } finally {
      res.off("close", abortUpstream);
      res.off("error", abortUpstream);
    }
  }

  private async worktreeCreateTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const name = this.requiredParam(routeUrl, body, "name");
    if (typeof name !== "string") return name;
    const result = await this.postProjectServiceJson(project, PROJECT_API_ROUTES.worktreeActions.create, { name });
    if (!result.ok) return result.response;
    const path = this.requiredProjectServiceString(result.json, "worktree create", "path");
    if (typeof path !== "string") return path;
    const payload: CoreWorktreeCreateTextPayload = {
      ok: true,
      name,
      path,
      status: result.json.status === "creating" ? "creating" : "created",
      projectRoot: result.projectRoot,
    };
    return this.textOrJsonLines(routeUrl, payload, renderCoreWorktreeCreateLines(payload));
  }

  private async worktreePathTextRoute(
    routeUrl: URL,
    body: unknown,
    input: { action: string; routePath: string; render: (payload: CoreWorktreePathTextPayload) => string[] },
  ): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const targetPath = this.requiredParam(routeUrl, body, "path");
    if (typeof targetPath !== "string") return targetPath;
    const projectRoot = this.resolveProjectRoot(project);
    const resolvedPath = this.resolveProjectRelativePath(projectRoot, targetPath);
    const result = await this.postProjectServiceJson(
      projectRoot,
      input.routePath,
      { path: resolvedPath },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    const returnedPath = this.requiredProjectServiceString(result.json, input.action, "path");
    if (typeof returnedPath !== "string") return returnedPath;
    const status = this.requiredProjectServiceString(result.json, input.action, "status");
    if (typeof status !== "string") return status;
    const payload: CoreWorktreePathTextPayload = {
      ok: true,
      projectRoot: result.projectRoot,
      path: returnedPath,
      status,
    };
    return this.textOrJsonLines(routeUrl, payload, input.render(payload));
  }

  private async graveyardListTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const result = await this.getProjectServiceJson(project, PROJECT_API_ROUTES.graveyard);
    if (!result.ok) return result.response;
    const entries = this.requiredProjectServiceArray(result.json, "graveyard list", "entries");
    if (!Array.isArray(entries)) return entries;
    const worktrees = Array.isArray(result.json.worktrees) ? result.json.worktrees : [];
    const payload: CoreGraveyardTextPayload = { entries, worktrees };
    return this.textOrJsonLines(routeUrl, payload, renderCoreGraveyardLines(payload));
  }

  private async graveyardAgentTextRoute(
    routeUrl: URL,
    body: unknown,
    input: { action: "graveyard send" | "graveyard resurrect"; routePath: string; statusFallback?: string },
  ): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const sessionId = this.requiredParam(routeUrl, body, "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const result = await this.postProjectServiceJson(
      project,
      input.routePath,
      { sessionId },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    const returnedSessionId = this.requiredProjectServiceString(result.json, input.action, "sessionId");
    if (typeof returnedSessionId !== "string") return returnedSessionId;
    const status = typeof result.json.status === "string" ? result.json.status : input.statusFallback;
    if (!status)
      return this.textError(
        502,
        `Error: project service returned invalid ${input.action} response: status is required`,
      );
    const payload: CoreGraveyardAgentTextPayload = {
      ok: true,
      projectRoot: result.projectRoot,
      sessionId: returnedSessionId,
      status,
      ...(typeof result.json.previousStatus === "string" ? { previousStatus: result.json.previousStatus } : {}),
    };
    return this.textOrJsonLines(routeUrl, payload, renderCoreGraveyardAgentLines(payload));
  }

  private async graveyardCleanupTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const dryRun = this.booleanParam(routeUrl, body, "dryRun", false);
    const result = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.graveyardActions.cleanup,
      { dryRun },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    const cleanupResult = result.json.result ?? result.json;
    if (!cleanupResult || typeof cleanupResult !== "object") {
      return this.textError(
        502,
        "Error: project service returned invalid graveyard cleanup response: result is required",
      );
    }
    const payload: CoreGraveyardCleanupTextPayload = {
      ok: true,
      projectRoot: result.projectRoot,
      result: cleanupResult,
    };
    if (routeUrl.searchParams.get("json") === "1") {
      return this.textOrJsonLines(routeUrl, { ok: true, projectRoot: result.projectRoot, ...cleanupResult }, []);
    }
    return this.textOrJsonLines(routeUrl, payload, renderCoreGraveyardCleanupLines(payload));
  }

  private async threadListTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const session = this.stringParam(routeUrl, body, "session")?.trim();
    const routePath = session
      ? `${PROJECT_API_ROUTES.threads.list}?session=${encodeURIComponent(session)}`
      : PROJECT_API_ROUTES.threads.list;
    const result = await this.getProjectServiceJson(project, routePath);
    if (!result.ok) return result.response;
    if (!Array.isArray(result.json)) {
      return this.textError(502, "Error: project service returned invalid thread list response");
    }
    const payload: CoreThreadListTextPayload = { summaries: result.json };
    return this.textOrJsonLines(routeUrl, result.json, renderCoreThreadListLines(payload));
  }

  private async threadShowTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const threadId = this.requiredParam(routeUrl, body, "threadId");
    if (typeof threadId !== "string") return threadId;
    const result = await this.getProjectServiceJson(
      project,
      `${PROJECT_API_ROUTES.threads.list}/${encodeURIComponent(threadId)}`,
    );
    if (!result.ok) {
      if (result.response.status === 404) return this.textError(404, `aimux: thread not found: ${threadId}`);
      return result.response;
    }
    const thread = this.requiredProjectServiceObject(result.json, "thread show", "thread");
    if (this.isRouteResponse(thread)) return thread;
    if (typeof thread.id !== "string")
      return this.textError(502, "Error: project service returned invalid thread show response: thread.id is required");
    const messages = this.requiredProjectServiceArray(result.json, "thread show", "messages");
    if (!Array.isArray(messages)) return messages;
    const payload: CoreThreadShowTextPayload = { thread, messages };
    return this.textOrJsonLines(routeUrl, { thread, messages }, renderCoreThreadShowLines(payload));
  }

  private async threadOpenTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const title = this.requiredParam(routeUrl, body, "title");
    if (typeof title !== "string") return title;
    const from = this.requiredParam(routeUrl, body, "from");
    if (typeof from !== "string") return from;
    const participants = this.csvParam(routeUrl, body, "participants");
    if (!participants || participants.length === 0) return this.textError(400, "participants is required");
    const kind = this.stringParam(routeUrl, body, "kind") || "conversation";
    const result = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.threads.open,
      { title, from, participants, kind },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    const thread = this.requiredProjectServiceObject(result.json, "thread open", "thread");
    if (this.isRouteResponse(thread)) return thread;
    if (typeof thread.id !== "string")
      return this.textError(502, "Error: project service returned invalid thread open response: thread.id is required");
    const payload: CoreThreadOpenTextPayload = { thread };
    return this.textOrJsonLines(routeUrl, { thread }, renderCoreThreadOpenLines(payload));
  }

  private async threadSendTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const threadId = this.requiredParam(routeUrl, body, "threadId");
    if (typeof threadId !== "string") return threadId;
    const messageBody = this.requiredParam(routeUrl, body, "body");
    if (typeof messageBody !== "string") return messageBody;
    const from = this.requiredParam(routeUrl, body, "from");
    if (typeof from !== "string") return from;
    const to = this.csvParam(routeUrl, body, "to");
    const kind = this.stringParam(routeUrl, body, "kind") || "note";
    const result = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.threads.send,
      { threadId, from, ...(to ? { to } : {}), kind, body: messageBody },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    const message = this.requiredProjectServiceObject(result.json, "thread send", "message");
    if (this.isRouteResponse(message)) return message;
    if (typeof message.id !== "string")
      return this.textError(
        502,
        "Error: project service returned invalid thread send response: message.id is required",
      );
    const payload: CoreThreadSendTextPayload = { message };
    return this.textOrJsonLines(routeUrl, { message }, renderCoreThreadSendLines(payload));
  }

  private async threadMarkSeenTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const threadId = this.requiredParam(routeUrl, body, "threadId");
    if (typeof threadId !== "string") return threadId;
    const session = this.requiredParam(routeUrl, body, "session");
    if (typeof session !== "string") return session;
    const result = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.threads.markSeen,
      { threadId, session },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    return this.textOrJsonLines(routeUrl, result.json, renderCoreThreadMarkSeenLines());
  }

  private async threadStatusTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const threadId = this.requiredParam(routeUrl, body, "threadId");
    if (typeof threadId !== "string") return threadId;
    const status = this.requiredParam(routeUrl, body, "status");
    if (typeof status !== "string") return status;
    const owner = this.stringParam(routeUrl, body, "owner") || undefined;
    const waitingOn = this.csvParam(routeUrl, body, "waitingOn");
    const result = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.threads.status,
      { threadId, status, ...(owner ? { owner } : {}), ...(waitingOn ? { waitingOn } : {}) },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    const thread = this.requiredProjectServiceObject(result.json, "thread status", "thread");
    if (this.isRouteResponse(thread)) return thread;
    if (typeof thread.id !== "string" || typeof thread.status !== "string") {
      return this.textError(
        502,
        "Error: project service returned invalid thread status response: thread.id and thread.status are required",
      );
    }
    const payload: CoreThreadStatusTextPayload = { thread };
    return this.textOrJsonLines(routeUrl, { thread }, renderCoreThreadStatusLines(payload));
  }

  private async messageSendTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const messageBody = this.requiredParam(routeUrl, body, "body");
    if (typeof messageBody !== "string") return messageBody;
    const to = this.csvParam(routeUrl, body, "to");
    const assignee = this.stringParam(routeUrl, body, "assignee") || undefined;
    const tool = this.stringParam(routeUrl, body, "tool") || undefined;
    const threadId = this.stringParam(routeUrl, body, "thread") || undefined;
    const worktreePath = this.stringParam(routeUrl, body, "worktree") || undefined;
    const title = this.stringParam(routeUrl, body, "title") || undefined;
    if ((!to || to.length === 0) && !threadId && !assignee && !tool) {
      return this.textError(400, "aimux: message send requires --to, --assignee, or --tool");
    }
    const result = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.threads.send,
      {
        ...(threadId ? { threadId } : {}),
        from: this.stringParam(routeUrl, body, "from") || "user",
        ...(to ? { to } : {}),
        ...(assignee ? { assignee } : {}),
        ...(tool ? { tool } : {}),
        ...(worktreePath ? { worktreePath } : {}),
        kind: this.stringParam(routeUrl, body, "kind") || "request",
        body: messageBody,
        ...(title ? { title } : {}),
      },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    const thread = this.requiredProjectServiceObject(result.json, "message send", "thread");
    if (this.isRouteResponse(thread)) return thread;
    if (typeof thread.id !== "string")
      return this.textError(
        502,
        "Error: project service returned invalid message send response: thread.id is required",
      );
    const message = this.requiredProjectServiceObject(result.json, "message send", "message");
    if (this.isRouteResponse(message)) return message;
    if (typeof message.id !== "string")
      return this.textError(
        502,
        "Error: project service returned invalid message send response: message.id is required",
      );
    const payload: CoreMessageSendTextPayload = { thread, message, deliveredTo: result.json.deliveredTo };
    return this.textOrJsonLines(
      routeUrl,
      { thread, message, deliveredTo: result.json.deliveredTo },
      renderCoreMessageSendLines(payload),
    );
  }

  private async handoffSendTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const messageBody = this.requiredParam(routeUrl, body, "body");
    if (typeof messageBody !== "string") return messageBody;
    const to = this.csvParam(routeUrl, body, "to");
    const assignee = this.stringParam(routeUrl, body, "assignee") || undefined;
    const tool = this.stringParam(routeUrl, body, "tool") || undefined;
    const title = this.stringParam(routeUrl, body, "title") || undefined;
    const worktreePath = this.stringParam(routeUrl, body, "worktree") || undefined;
    if ((!to || to.length === 0) && !assignee && !tool) {
      return this.textError(400, "aimux: handoff send requires --to, --assignee, or --tool");
    }
    const result = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.handoff.send,
      {
        from: this.stringParam(routeUrl, body, "from") || "user",
        ...(to ? { to } : {}),
        ...(assignee ? { assignee } : {}),
        ...(tool ? { tool } : {}),
        body: messageBody,
        ...(title ? { title } : {}),
        ...(worktreePath ? { worktreePath } : {}),
      },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    const thread = this.requiredProjectServiceObject(result.json, "handoff send", "thread");
    if (this.isRouteResponse(thread)) return thread;
    const message = this.requiredProjectServiceObject(result.json, "handoff send", "message");
    if (this.isRouteResponse(message)) return message;
    if (typeof thread.id !== "string" || typeof message.id !== "string") {
      return this.textError(
        502,
        "Error: project service returned invalid handoff send response: thread.id and message.id are required",
      );
    }
    const payload: CoreHandoffSendTextPayload = { thread, message, deliveredTo: result.json.deliveredTo };
    return this.textOrJsonLines(routeUrl, result.json, renderCoreHandoffSendLines(payload));
  }

  private async handoffMutationTextRoute(
    routeUrl: URL,
    body: unknown,
    input: { action: string; routePath: string },
  ): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const threadId = this.requiredParam(routeUrl, body, "threadId");
    if (typeof threadId !== "string") return threadId;
    const bodyText = this.stringParam(routeUrl, body, "body") || undefined;
    const result = await this.postProjectServiceJson(
      project,
      input.routePath,
      {
        threadId,
        from: this.stringParam(routeUrl, body, "from") || "user",
        ...(bodyText ? { body: bodyText } : {}),
      },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    const thread = this.requiredProjectServiceObject(result.json, input.action, "thread");
    if (this.isRouteResponse(thread)) return thread;
    const message = this.requiredProjectServiceObject(result.json, input.action, "message");
    if (this.isRouteResponse(message)) return message;
    if (typeof thread.id !== "string" || typeof message.id !== "string") {
      return this.textError(
        502,
        `Error: project service returned invalid ${input.action} response: thread.id and message.id are required`,
      );
    }
    const payload: CoreHandoffMutationTextPayload = { thread, message };
    return this.textOrJsonLines(routeUrl, result.json, renderCoreHandoffMutationLines(payload));
  }

  private async taskListTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const params = new URLSearchParams();
    const session = this.stringParam(routeUrl, body, "session")?.trim();
    const status = this.stringParam(routeUrl, body, "status")?.trim();
    if (session) params.set("session", session);
    if (status) params.set("status", status);
    const query = params.toString();
    const result = await this.getProjectServiceJson(
      project,
      `${PROJECT_API_ROUTES.tasks.list}${query ? `?${query}` : ""}`,
    );
    if (!result.ok) return result.response;
    const tasks = this.requiredProjectServiceArray(result.json, "task list", "tasks");
    if (!Array.isArray(tasks)) return tasks;
    const payload: CoreTaskListTextPayload = { tasks };
    return this.textOrJsonLines(routeUrl, { tasks }, renderCoreTaskListLines(payload));
  }

  private async taskShowTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const taskId = this.requiredParam(routeUrl, body, "taskId");
    if (typeof taskId !== "string") return taskId;
    const result = await this.getProjectServiceJson(
      project,
      `${PROJECT_API_ROUTES.tasks.list}/${encodeURIComponent(taskId)}`,
    );
    if (!result.ok) {
      if (result.response.status === 404) return this.textError(404, `aimux: task not found: ${taskId}`);
      return result.response;
    }
    const task = this.requiredProjectServiceObject(result.json, "task show", "task");
    if (this.isRouteResponse(task)) return task;
    if (typeof task.id !== "string")
      return this.textError(502, "Error: project service returned invalid task show response: task.id is required");
    const messages = this.requiredProjectServiceArray(result.json, "task show", "messages");
    if (!Array.isArray(messages)) return messages;
    const payload: CoreTaskShowTextPayload = { task, thread: result.json.thread, messages };
    return this.textOrJsonLines(
      routeUrl,
      { task, thread: result.json.thread, messages },
      renderCoreTaskShowLines(payload),
    );
  }

  private async taskAssignTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const description = this.requiredParam(routeUrl, body, "description");
    if (typeof description !== "string") return description;
    const assignee = this.stringParam(routeUrl, body, "assignee") || undefined;
    const diff = this.stringParam(routeUrl, body, "diff") || undefined;
    const prompt = this.stringParam(routeUrl, body, "prompt") || undefined;
    const to = this.stringParam(routeUrl, body, "to") || undefined;
    const tool = this.stringParam(routeUrl, body, "tool") || undefined;
    const worktreePath = this.stringParam(routeUrl, body, "worktree") || undefined;
    const result = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.tasks.assign,
      {
        from: this.stringParam(routeUrl, body, "from") || "user",
        ...(to ? { to } : {}),
        ...(assignee ? { assignee } : {}),
        ...(tool ? { tool } : {}),
        description,
        ...(prompt ? { prompt } : {}),
        type: this.stringParam(routeUrl, body, "type") || "task",
        ...(diff ? { diff } : {}),
        ...(worktreePath ? { worktreePath } : {}),
      },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    return this.taskMutationResponse(routeUrl, result.json, "task assign", renderCoreTaskMutationLines);
  }

  private async taskMutationTextRoute(
    routeUrl: URL,
    body: unknown,
    input: { action: string; routePath: string },
  ): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const taskId = this.requiredParam(routeUrl, body, "taskId");
    if (typeof taskId !== "string") return taskId;
    const bodyText = this.stringParam(routeUrl, body, "body") || undefined;
    const result = await this.postProjectServiceJson(
      project,
      input.routePath,
      {
        taskId,
        from: this.stringParam(routeUrl, body, "from") || "user",
        ...(bodyText ? { body: bodyText } : {}),
      },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    return this.taskMutationResponse(routeUrl, result.json, input.action, renderCoreTaskMutationLines);
  }

  private async reviewRequestChangesTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const taskId = this.requiredParam(routeUrl, body, "taskId");
    if (typeof taskId !== "string") return taskId;
    const bodyText = this.stringParam(routeUrl, body, "body") || undefined;
    const result = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.reviews.requestChanges,
      {
        taskId,
        from: this.stringParam(routeUrl, body, "from") || "user",
        ...(bodyText ? { body: bodyText } : {}),
      },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    return this.taskMutationResponse(
      routeUrl,
      result.json,
      "review request changes",
      renderCoreReviewRequestChangesLines,
    );
  }

  private taskMutationResponse(
    routeUrl: URL,
    json: ProjectServiceJson,
    action: string,
    render: (payload: CoreTaskMutationTextPayload | CoreReviewRequestChangesTextPayload) => string[],
  ): DaemonRouteResponse {
    const task = this.requiredProjectServiceObject(json, action, "task");
    if (this.isRouteResponse(task)) return task;
    if (typeof task.id !== "string")
      return this.textError(502, `Error: project service returned invalid ${action} response: task.id is required`);
    const payload: CoreReviewRequestChangesTextPayload = {
      task,
      ...(json.thread && typeof json.thread === "object" ? { thread: json.thread } : {}),
      ...(json.followUpTask && typeof json.followUpTask === "object" ? { followUpTask: json.followUpTask } : {}),
    };
    return this.textOrJsonLines(routeUrl, json, render(payload));
  }

  private async lifecycleSpawnTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const tool = this.requiredParam(routeUrl, body, "tool");
    if (typeof tool !== "string") return tool;
    const projectRoot = this.resolveProjectRoot(project);
    const worktreePath = this.resolveLifecycleWorktree(projectRoot, this.stringParam(routeUrl, body, "worktreePath"));
    const open = this.booleanParam(routeUrl, body, "open", true);
    const result = await this.postProjectServiceJson(project, PROJECT_API_ROUTES.agents.spawn, {
      tool,
      ...(worktreePath ? { worktreePath } : {}),
      open,
    });
    if (!result.ok) return result.response;
    const sessionId = this.requiredProjectServiceString(result.json, "spawn", "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const payload: CoreLifecycleSpawnTextPayload = {
      ok: true,
      projectRoot: result.projectRoot,
      sessionId,
      tool,
      worktreePath: worktreePath ?? result.projectRoot,
      opened: open,
    };
    return this.textOrJsonLines(routeUrl, payload, renderCoreLifecycleSpawnLines(payload));
  }

  private async lifecycleStopTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const sessionId = this.requiredParam(routeUrl, body, "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const result = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.agents.stop,
      { sessionId },
      { ensureProject: false },
    );
    if (!result.ok) return result.response;
    const returnedSessionId = this.requiredProjectServiceString(result.json, "stop", "sessionId");
    if (typeof returnedSessionId !== "string") return returnedSessionId;
    const status = this.requiredProjectServiceString(result.json, "stop", "status");
    if (typeof status !== "string") return status;
    const payload: CoreLifecycleStopTextPayload = {
      ok: true,
      projectRoot: result.projectRoot,
      sessionId: returnedSessionId,
      status,
    };
    return this.textOrJsonLines(routeUrl, payload, renderCoreLifecycleStopLines(payload));
  }

  private async lifecycleKillTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const sessionId = this.requiredParam(routeUrl, body, "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const result = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.agents.kill,
      { sessionId },
      { ensureProject: false },
    );
    if (!result.ok) return result.response;
    const returnedSessionId = this.requiredProjectServiceString(result.json, "kill", "sessionId");
    if (typeof returnedSessionId !== "string") return returnedSessionId;
    const status = this.requiredProjectServiceString(result.json, "kill", "status");
    if (typeof status !== "string") return status;
    const previousStatus = this.requiredProjectServiceString(result.json, "kill", "previousStatus");
    if (typeof previousStatus !== "string") return previousStatus;
    const payload: CoreLifecycleKillTextPayload = {
      ok: true,
      projectRoot: result.projectRoot,
      sessionId: returnedSessionId,
      status,
      previousStatus,
    };
    return this.textOrJsonLines(routeUrl, payload, renderCoreLifecycleKillLines(payload));
  }

  private async lifecycleForkTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const sourceSessionId = this.requiredParam(routeUrl, body, "sourceSessionId");
    if (typeof sourceSessionId !== "string") return sourceSessionId;
    const tool = this.requiredParam(routeUrl, body, "tool");
    if (typeof tool !== "string") return tool;
    const instruction = this.stringParam(routeUrl, body, "instruction") || undefined;
    const projectRoot = this.resolveProjectRoot(project);
    const worktreePath = this.resolveLifecycleWorktree(projectRoot, this.stringParam(routeUrl, body, "worktreePath"));
    const open = this.booleanParam(routeUrl, body, "open", true);
    const result = await this.postProjectServiceJson(project, PROJECT_API_ROUTES.agents.fork, {
      sourceSessionId,
      tool,
      ...(instruction ? { instruction } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      open,
    });
    if (!result.ok) return result.response;
    const sessionId = this.requiredProjectServiceString(result.json, "fork", "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const threadId = this.requiredProjectServiceString(result.json, "fork", "threadId");
    if (typeof threadId !== "string") return threadId;
    const payload: CoreLifecycleForkTextPayload = {
      ok: true,
      projectRoot: result.projectRoot,
      sourceSessionId,
      sessionId,
      threadId,
      tool,
      worktreePath: worktreePath ?? result.projectRoot,
      opened: open,
    };
    return this.textOrJsonLines(routeUrl, payload, renderCoreLifecycleForkLines(payload));
  }

  private async agentInputTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const sessionId = this.requiredParam(routeUrl, body, "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const text = this.requiredParam(routeUrl, body, "text");
    if (typeof text !== "string") return text;
    const result = await this.postProjectServiceJson(project, PROJECT_API_ROUTES.agents.input, { sessionId, text });
    if (!result.ok) return result.response;
    const payload: CoreAgentInputTextPayload = { ok: true, projectRoot: result.projectRoot, sessionId };
    return this.textOrJsonLines(routeUrl, payload, renderCoreAgentInputLines(payload));
  }

  private async agentPsTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const result = await this.getProjectServiceJson(project, PROJECT_API_ROUTES.agents.list);
    if (!result.ok) return result.response;
    const agents = this.requiredProjectServiceArray(result.json, "agent ps", "agents");
    if (!Array.isArray(agents)) return agents;
    if (agents.some((agent) => !agent || typeof agent !== "object" || Array.isArray(agent))) {
      return this.textError(
        502,
        "Error: project service returned invalid agent ps response: agents entries are invalid",
      );
    }
    const payload: CoreAgentSummaryTextPayload = {
      agents: agents as CoreAgentSummaryTextPayload["agents"],
    };
    return this.textOrJsonLines(routeUrl, agents, renderCoreAgentPsLines(payload));
  }

  private async agentRenameTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const sessionId = this.requiredParam(routeUrl, body, "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const bodyRecord = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const hasLabel = Object.prototype.hasOwnProperty.call(bodyRecord, "label") || routeUrl.searchParams.has("label");
    const label = this.stringParam(routeUrl, body, "label");
    if (!hasLabel || label === undefined) return this.textError(400, "label is required");
    const result = await this.postProjectServiceJson(project, PROJECT_API_ROUTES.agents.rename, { sessionId, label });
    if (!result.ok) return result.response;
    const returnedSessionId = this.requiredProjectServiceString(result.json, "rename", "sessionId");
    if (typeof returnedSessionId !== "string") return returnedSessionId;
    const returnedLabel = typeof result.json.label === "string" ? result.json.label : undefined;
    const payload: CoreAgentRenameTextPayload = {
      ok: true,
      projectRoot: result.projectRoot,
      sessionId: returnedSessionId,
      ...(returnedLabel !== undefined ? { label: returnedLabel } : {}),
    };
    return this.textOrJsonLines(routeUrl, payload, renderCoreAgentRenameLines(payload));
  }

  private async agentMigrateTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const sessionId = this.requiredParam(routeUrl, body, "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const worktreePath = this.requiredParam(routeUrl, body, "worktreePath");
    if (typeof worktreePath !== "string") return worktreePath;
    const projectRoot = this.resolveProjectRoot(project);
    const resolvedWorktreePath = this.resolveProjectRelativePath(projectRoot, worktreePath);
    const result = await this.postProjectServiceJson(projectRoot, PROJECT_API_ROUTES.agents.migrate, {
      sessionId,
      worktreePath: resolvedWorktreePath,
    });
    if (!result.ok) return result.response;
    const returnedSessionId = this.requiredProjectServiceString(result.json, "migrate", "sessionId");
    if (typeof returnedSessionId !== "string") return returnedSessionId;
    const returnedWorktreePath =
      typeof result.json.worktreePath === "string" && result.json.worktreePath.trim()
        ? result.json.worktreePath
        : resolvedWorktreePath;
    const payload: CoreAgentMigrateTextPayload = {
      ok: true,
      projectRoot: result.projectRoot,
      sessionId: returnedSessionId,
      worktreePath: returnedWorktreePath,
    };
    return this.textOrJsonLines(routeUrl, payload, renderCoreAgentMigrateLines(payload));
  }

  private async loopTextRoute(
    routeUrl: URL,
    body: unknown,
    input: { active: boolean; render: (payload: CoreLoopTextPayload) => string[] },
  ): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const sessionId = this.requiredParam(routeUrl, body, "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const goal = this.stringParam(routeUrl, body, "goal") || undefined;
    const result = await this.postProjectServiceJson(project, PROJECT_API_ROUTES.agents.loop, {
      sessionId,
      active: input.active,
      ...(goal ? { goal } : {}),
    });
    if (!result.ok) return result.response;
    const returnedSessionId = this.requiredProjectServiceString(result.json, "loop", "sessionId");
    if (typeof returnedSessionId !== "string") return returnedSessionId;
    const loop = result.json.loop && typeof result.json.loop === "object" ? result.json.loop : undefined;
    const payload: CoreLoopTextPayload = {
      ok: true,
      projectRoot: result.projectRoot,
      sessionId: returnedSessionId,
      active: input.active,
      goal: loop && typeof (loop as { goal?: unknown }).goal === "string" ? (loop as { goal: string }).goal : goal,
    };
    return this.textOrJsonLines(routeUrl, payload, input.render(payload));
  }

  private async loopExitTextRoute(
    routeUrl: URL,
    body: unknown,
    input: {
      event: (message: string) => Record<string, unknown>;
      render: (payload: CoreLoopTextPayload) => string[];
    },
  ): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const sessionId = this.requiredParam(routeUrl, body, "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const reason = this.stringParam(routeUrl, body, "reason") || undefined;
    const loopResult = await this.postProjectServiceJson(project, PROJECT_API_ROUTES.agents.loop, {
      sessionId,
      active: false,
    });
    if (!loopResult.ok) return loopResult.response;
    const returnedSessionId = this.requiredProjectServiceString(loopResult.json, "loop", "sessionId");
    if (typeof returnedSessionId !== "string") return returnedSessionId;
    let eventWarning: string | undefined;
    const eventResult = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.runtime.event,
      { session: returnedSessionId, event: input.event(reason ?? "") },
      { ensureProject: false },
    );
    if (!eventResult.ok) {
      eventWarning = `aimux: loop exited, but the status event could not be recorded: ${String(
        eventResult.response.body,
      ).trim()}`;
    }
    const payload: CoreLoopTextPayload = {
      ok: true,
      projectRoot: loopResult.projectRoot,
      sessionId: returnedSessionId,
      active: false,
      eventWarning,
    };
    return this.textOrJsonLines(routeUrl, payload, input.render(payload));
  }

  private async overseerStartTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const projectRoot = this.resolveProjectRoot(project);
    const explicitTool = this.stringParam(routeUrl, body, "tool") || undefined;
    const tool = explicitTool ?? loadConfig({ projectRoot }).defaultTool;
    const worktreePath = this.resolveLifecycleWorktree(projectRoot, this.stringParam(routeUrl, body, "worktreePath"));
    const open = this.booleanParam(routeUrl, body, "open", true);
    const result = await this.postProjectServiceJson(projectRoot, PROJECT_API_ROUTES.agents.spawn, {
      tool,
      ...(worktreePath ? { worktreePath } : {}),
      open,
      overseer: true,
    });
    if (!result.ok) return result.response;
    const sessionId = this.requiredProjectServiceString(result.json, "overseer start", "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const payload: CoreOverseerTextPayload = {
      ok: true,
      projectRoot: result.projectRoot,
      sessionId,
      tool,
      overseer: true,
    };
    return this.textOrJsonLines(routeUrl, payload, renderCoreOverseerStartLines(payload));
  }

  private async overseerClearTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const sessionId = this.requiredParam(routeUrl, body, "sessionId");
    if (typeof sessionId !== "string") return sessionId;
    const result = await this.postProjectServiceJson(project, PROJECT_API_ROUTES.agents.overseer, {
      sessionId,
      active: false,
    });
    if (!result.ok) return result.response;
    const returnedSessionId = this.requiredProjectServiceString(result.json, "overseer clear", "sessionId");
    if (typeof returnedSessionId !== "string") return returnedSessionId;
    const payload: CoreOverseerTextPayload = {
      ok: true,
      projectRoot: result.projectRoot,
      sessionId: returnedSessionId,
      overseer: false,
    };
    return this.textOrJsonLines(routeUrl, payload, renderCoreOverseerClearLines(payload));
  }

  private async notificationListTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const params = new URLSearchParams();
    if (this.booleanParam(routeUrl, body, "unread", false)) params.set("unread", "1");
    const sessionId = this.stringParam(routeUrl, body, "sessionId")?.trim();
    if (sessionId) params.set("sessionId", sessionId);
    const query = params.toString();
    const result = await this.getProjectServiceJson(
      project,
      `${PROJECT_API_ROUTES.notifications.list}${query ? `?${query}` : ""}`,
    );
    if (!result.ok) return result.response;
    const notifications = this.requiredProjectServiceArray(result.json, "notifications list", "notifications");
    if (this.isRouteResponse(notifications)) return notifications;
    const unreadCount = typeof result.json.unreadCount === "number" ? result.json.unreadCount : 0;
    const payload: CoreNotificationsListTextPayload = {
      notifications: notifications as CoreNotificationsListTextPayload["notifications"],
      unreadCount,
    };
    return this.textOrJsonLines(routeUrl, payload, renderCoreNotificationsListLines(payload));
  }

  private async notificationSendTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const title = this.requiredParam(routeUrl, body, "title");
    if (typeof title !== "string") return title;
    const message = this.stringParam(routeUrl, body, "body")?.trim() || title.trim();
    const result = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.runtime.notify,
      {
        title: title.trim(),
        subtitle: this.stringParam(routeUrl, body, "subtitle")?.trim() || undefined,
        message,
        sessionId: this.stringParam(routeUrl, body, "sessionId")?.trim() || undefined,
        kind: this.stringParam(routeUrl, body, "kind")?.trim() || "notification",
        force: true,
      },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    if (!result.ok) return result.response;
    return this.textOrJsonLines(routeUrl, { ok: true }, renderCoreNotificationSendLines({ title: title.trim() }));
  }

  private async notificationReadTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const mutationPayload = this.notificationMutationPayload(routeUrl, body);
    if (this.isRouteResponse(mutationPayload)) return mutationPayload;
    const result = await this.postProjectServiceJson(project, PROJECT_API_ROUTES.notifications.read, mutationPayload, {
      timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS,
    });
    if (!result.ok) return result.response;
    const responsePayload: CoreNotificationReadTextPayload = {
      ok: true,
      updated: typeof result.json.updated === "number" ? result.json.updated : 0,
    };
    return this.textOrJsonLines(routeUrl, responsePayload, renderCoreNotificationReadLines(responsePayload));
  }

  private async notificationClearTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const mutationPayload = this.notificationMutationPayload(routeUrl, body);
    if (this.isRouteResponse(mutationPayload)) return mutationPayload;
    const result = await this.postProjectServiceJson(project, PROJECT_API_ROUTES.notifications.clear, mutationPayload, {
      timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS,
    });
    if (!result.ok) return result.response;
    const responsePayload: CoreNotificationClearTextPayload = {
      ok: true,
      cleared: typeof result.json.cleared === "number" ? result.json.cleared : 0,
    };
    return this.textOrJsonLines(routeUrl, responsePayload, renderCoreNotificationClearLines(responsePayload));
  }

  private teamPayloadFromResult(
    result: ProjectServiceJsonResult,
    action: string,
    role?: string,
  ): CoreTeamTextPayload | DaemonRouteResponse {
    if (!result.ok) return result.response;
    const config = this.requiredProjectServiceObject(result.json, action, "config");
    if (this.isRouteResponse(config)) return config;
    const roles = config.roles;
    if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
      return this.textError(
        502,
        `Error: project service returned invalid ${action} response: config.roles is required`,
      );
    }
    const defaultRole = config.defaultRole;
    if (typeof defaultRole !== "string") {
      return this.textError(
        502,
        `Error: project service returned invalid ${action} response: config.defaultRole is required`,
      );
    }
    return {
      ok: true,
      projectRoot: result.projectRoot,
      config: { roles: roles as CoreTeamTextPayload["config"]["roles"], defaultRole },
      ...(role ? { role } : {}),
    };
  }

  private async teamShowTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const result = await this.getProjectServiceJson(project, PROJECT_API_ROUTES.team.config);
    const payload = this.teamPayloadFromResult(result, "team show");
    if (this.isRouteResponse(payload)) return payload;
    return this.textOrJsonLines(routeUrl, payload, renderCoreTeamShowLines(payload));
  }

  private async teamInitTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const result = await this.postProjectServiceJson(
      project,
      PROJECT_API_ROUTES.team.init,
      {},
      {
        timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS,
      },
    );
    const payload = this.teamPayloadFromResult(result, "team init");
    if (this.isRouteResponse(payload)) return payload;
    return this.textOrJsonLines(routeUrl, payload, renderCoreTeamInitLines(payload));
  }

  private async teamRoleTextRoute(
    routeUrl: URL,
    body: unknown,
    input: {
      action: string;
      routePath: string;
      extraBody?: (role: string) => Record<string, unknown>;
      render: (payload: CoreTeamTextPayload) => string[];
    },
  ): Promise<DaemonRouteResponse> {
    const project = this.requiredParam(routeUrl, body, "project");
    if (typeof project !== "string") return project;
    const role = this.requiredParam(routeUrl, body, "role");
    if (typeof role !== "string") return role;
    const result = await this.postProjectServiceJson(
      project,
      input.routePath,
      {
        role,
        ...(input.extraBody ? input.extraBody(role) : {}),
      },
      { timeoutMs: CLI_PROJECT_MUTATION_TIMEOUT_MS },
    );
    const payload = this.teamPayloadFromResult(result, input.action, role);
    if (this.isRouteResponse(payload)) return payload;
    return this.textOrJsonLines(routeUrl, payload, input.render(payload));
  }

  private async runAuthTextRoute(opts: {
    action?: "security-unlock";
    render: (payload: { userId: string; relay: CoreRelaySnapshot }) => string[];
  }): Promise<DaemonRouteResponse> {
    const messages: string[] = [];
    try {
      const { userId } = await runLoginFlow({
        action: opts.action,
        onMessage: (message) => messages.push(message),
      });
      const relay = this.enableRelayBestEffort();
      const lines = [...messages, ...opts.render({ userId, relay })];
      return {
        status: 200,
        body: `${lines.join("\n")}\n`,
        contentType: "text/plain; charset=utf-8",
      };
    } catch (error) {
      const prefix = opts.action === "security-unlock" ? "Security unlock failed" : "Login failed";
      const lines = [...messages, `${prefix}: ${error instanceof Error ? error.message : String(error)}`];
      return {
        status: 500,
        body: `${lines.join("\n")}\n`,
        contentType: "text/plain; charset=utf-8",
      };
    }
  }

  private async startAuthTextRoute(action: AuthAction): Promise<DaemonRouteResponse> {
    this.pruneAuthFlows();
    const id = randomUUID();
    const messages: string[] = [];
    let releaseMessages: () => void = () => {};
    const messagesReady = new Promise<void>((resolve) => {
      releaseMessages = resolve;
    });
    const promise = runLoginFlow({
      action,
      onMessage: (message) => {
        messages.push(message);
        if (messages.length >= 2) releaseMessages();
      },
    }).then(({ userId }) => ({ userId, relay: this.enableRelayBestEffort() }));
    this.authFlows.set(id, { promise, startedAt: Date.now() });
    await Promise.race([
      messagesReady,
      promise.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    return {
      status: 200,
      body: `auth-session: ${id}\n${messages.join("\n")}\n`,
      contentType: "text/plain; charset=utf-8",
    };
  }

  private async waitAuthTextRoute(
    routeUrl: URL,
    opts: { action?: "security-unlock"; render: (payload: { userId: string; relay: CoreRelaySnapshot }) => string[] },
  ): Promise<DaemonRouteResponse> {
    this.pruneAuthFlows();
    const id = routeUrl.searchParams.get("id");
    if (!id) return { status: 400, body: "auth session id is required\n", contentType: "text/plain; charset=utf-8" };
    const flow = this.authFlows.get(id);
    if (!flow) return { status: 404, body: "auth session not found\n", contentType: "text/plain; charset=utf-8" };
    this.authFlows.delete(id);
    try {
      const result = await flow.promise;
      return {
        status: 200,
        body: `${opts.render(result).join("\n")}\n`,
        contentType: "text/plain; charset=utf-8",
      };
    } catch (error) {
      const prefix = opts.action === "security-unlock" ? "Security unlock failed" : "Login failed";
      return {
        status: 500,
        body: `${prefix}: ${error instanceof Error ? error.message : String(error)}\n`,
        contentType: "text/plain; charset=utf-8",
      };
    }
  }

  private pruneAuthFlows(): void {
    const now = Date.now();
    for (const [id, flow] of this.authFlows.entries()) {
      if (now - flow.startedAt > AUTH_FLOW_TTL_MS) this.authFlows.delete(id);
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
    const actor = this.projectActors.get(projectId);
    if (actor?.isRunning()) {
      const state = actor.getState();
      this.state.projects[projectId] = state;
      this.refreshState();
      return state;
    }

    if (existing?.pid && existing.pid !== process.pid && isPidAlive(existing.pid)) {
      await this.terminateLegacyProjectService(existing);
    }

    const nextActor = actor ?? new CoreProjectActor(resolvedRoot);
    let state: ProjectServiceState;
    try {
      state = await nextActor.start();
    } catch (error) {
      if (this.projectActors.get(projectId) === nextActor) {
        this.projectActors.delete(projectId);
      }
      await nextActor.stop().catch((stopError: unknown) => {
        log.warn("failed to clean up project actor after start failure", "daemon", {
          projectId,
          projectRoot: resolvedRoot,
          error: stopError instanceof Error ? stopError.message : String(stopError),
        });
      });
      throw error;
    }
    this.projectActors.set(projectId, nextActor);
    this.state.projects[projectId] = state;
    this.refreshState();
    return state;
  }

  private async terminateLegacyProjectService(existing: ProjectServiceState): Promise<void> {
    if (!isAimuxProjectServiceProcess(existing.pid, existing)) {
      log.warn("skipping unverified legacy project service pid", "daemon", {
        projectId: existing.projectId,
        projectRoot: existing.projectRoot,
        pid: existing.pid,
      });
      return;
    }
    log.info("terminating legacy project service", "daemon", {
      projectId: existing.projectId,
      projectRoot: existing.projectRoot,
      pid: existing.pid,
    });
    try {
      process.kill(existing.pid, "SIGTERM");
    } catch {}
    if (await this.waitForProjectServiceExit(existing.pid, PROJECT_SERVICE_TERM_GRACE_MS)) return;
    log.warn("legacy project service did not stop after SIGTERM; killing", "daemon", {
      projectId: existing.projectId,
      projectRoot: existing.projectRoot,
      pid: existing.pid,
    });
    try {
      process.kill(existing.pid, "SIGKILL");
    } catch {}
    if (await this.waitForProjectServiceExit(existing.pid, PROJECT_SERVICE_KILL_GRACE_MS)) return;
    throw new Error(`legacy project service ${existing.pid} did not exit`);
  }

  private async waitForProjectServiceExit(pid: number, timeoutMs: number): Promise<boolean> {
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

      const interval = setInterval(() => {
        if (!isPidAlive(pid)) finish(true);
      }, PROJECT_SERVICE_EXIT_POLL_MS);
      cleanups.push(() => clearInterval(interval));
      const timeout = setTimeout(() => finish(!isPidAlive(pid)), timeoutMs);
      cleanups.push(() => clearTimeout(timeout));
    });
  }

  private async stopProject(projectRoot: string, opts?: { force?: boolean }): Promise<ProjectServiceState | null> {
    const projectId = getProjectIdFor(pathResolve(projectRoot));
    const existing = this.state.projects[projectId];
    if (!existing) return null;
    const actor = this.projectActors.get(projectId);
    if (actor) {
      if (opts?.force) {
        await actor.kill();
      } else {
        await actor.stop();
      }
      this.projectActors.delete(projectId);
    } else if (existing.pid !== process.pid && isPidAlive(existing.pid)) {
      await this.terminateLegacyProjectService(existing);
    }
    delete this.state.projects[projectId];
    removeMetadataEndpoint(existing.projectRoot);
    this.refreshState();
    return existing;
  }

  private requireProjectRoot(
    id: string,
    command: CoreCommandName,
    payload: { projectRoot?: unknown } | undefined,
  ): { ok: true; projectRoot: string } | { ok: false; response: { status: number; body: CoreCommandResponse } } {
    if (typeof payload?.projectRoot !== "string" || !payload.projectRoot.trim()) {
      return {
        ok: false,
        response: {
          status: 400,
          body: { ok: false, id, command, error: "projectRoot is required" },
        },
      };
    }
    return { ok: true, projectRoot: payload.projectRoot };
  }

  private optionalProjectRoot(
    id: string,
    command: CoreCommandName,
    payload: { projectRoot?: unknown } | undefined,
  ): { ok: true; projectRoot?: string } | { ok: false; response: { status: number; body: CoreCommandResponse } } {
    if (payload?.projectRoot === undefined) return { ok: true };
    if (typeof payload.projectRoot !== "string" || !payload.projectRoot.trim()) {
      return {
        ok: false,
        response: {
          status: 400,
          body: { ok: false, id, command, error: "projectRoot must be a non-empty string when provided" },
        },
      };
    }
    return { ok: true, projectRoot: pathResolve(payload.projectRoot) };
  }

  private currentDaemonInfo(issuedAt: string): AimuxDaemonInfo {
    const daemonInfo = loadDaemonInfo();
    return {
      pid: process.pid,
      port: getDaemonPort(),
      startedAt: daemonInfo?.startedAt ?? issuedAt,
      updatedAt: daemonInfo?.updatedAt ?? issuedAt,
    };
  }

  private async restartControlPlane(issuedAt: string, projectRoot?: string): Promise<CoreRestartResult> {
    const restart = await restartAimuxControlPlane({
      projectRoot,
      stopDaemon: async () => null,
      ensureDaemonRunning: async () => this.currentDaemonInfo(issuedAt),
      ensureProjectService: (root) => this.ensureProject(root),
      stopProjectService: (root) => this.stopProject(root),
      isAimuxProjectServiceProcess,
      retainDaemon: true,
    });
    return {
      restart,
      text: renderRuntimeRestartResult(restart),
    };
  }

  private async doctorVersionsTextRoute(routeUrl: URL): Promise<DaemonRouteResponse> {
    try {
      const report = await buildRuntimeCoherenceReport();
      return this.textOrJsonLines(routeUrl, report, renderRuntimeCoherenceReport(report).split("\n"));
    } catch (error) {
      return this.textError(500, `Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async doctorTmuxTextRoute(routeUrl: URL): Promise<DaemonRouteResponse> {
    const projectParam = routeUrl.searchParams.get("projectRoot");
    if (!projectParam) {
      return this.textError(400, "projectRoot query is required");
    }
    const projectRoot = this.resolveProjectRoot(pathResolve(projectParam));
    try {
      await initPaths(projectRoot);
      const tmux = new TmuxRuntimeManager();
      const report = buildTmuxDoctorReport(tmux, {
        projectRoot,
        sessionName: routeUrl.searchParams.get("session") ?? undefined,
        windowId: routeUrl.searchParams.get("windowId") ?? undefined,
      });
      return this.textOrJsonLines(routeUrl, report, renderTmuxDoctorReport(report).split("\n"));
    } catch (error) {
      return this.textError(500, `Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async repairTextRoute(routeUrl: URL, body: unknown): Promise<DaemonRouteResponse> {
    const projectParam = this.stringParam(routeUrl, body, "projectRoot");
    if (!projectParam) {
      return this.textError(400, "projectRoot query is required");
    }
    const projectRoot = this.resolveProjectRoot(pathResolve(projectParam));
    try {
      await initPaths(projectRoot);
      await this.ensureProject(projectRoot);
      const tmux = new TmuxRuntimeManager();
      const result = repairTmuxRuntime(tmux, { projectRoot });
      const backendReconcile = reconcileOfflineBackendSessionIds(projectRoot);
      if (this.booleanParam(routeUrl, body, "open", false)) {
        const { dashboardTarget } = resolveDashboardTarget(projectRoot, tmux);
        tmux.openTarget(dashboardTarget, { insideTmux: tmux.isInsideTmux(), alreadyResolved: true });
      }
      const lines = renderTmuxRepairResult(result).split("\n");
      if (backendReconcile.reconciled.length > 0) {
        lines.push(`Recovered backend session id for ${backendReconcile.reconciled.length} offline agent(s):`);
        for (const entry of backendReconcile.reconciled) {
          lines.push(`  ${entry.id} -> ${entry.backendSessionId}`);
        }
      }
      return this.textOrJsonLines(routeUrl, { ...result, backendReconcile }, lines);
    } catch (error) {
      return this.textError(500, `Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async routeCoreCommand(body: unknown): Promise<{ status: number; body: CoreCommandResponse }> {
    const envelope = body as CoreCommandEnvelope | undefined;
    const id =
      typeof envelope?.id === "string" && envelope.id.trim()
        ? envelope.id.trim()
        : `core-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const command = envelope?.command;
    if (!isCoreCommandName(command)) {
      return {
        status: 400,
        body: {
          ok: false,
          id,
          command: typeof command === "string" ? command : undefined,
          error: "unknown core command",
        },
      };
    }
    const issuedAt = new Date().toISOString();
    const payload = envelope?.payload as { projectRoot?: unknown } | undefined;
    const daemonInfo = loadDaemonInfo();
    switch (command) {
      case CORE_COMMAND_NAMES.ping:
        return { status: 200, body: { ok: true, id, command, issuedAt, result: { pong: true } } };
      case CORE_COMMAND_NAMES.status:
        return {
          status: 200,
          body: {
            ok: true,
            id,
            command,
            issuedAt,
            result: {
              daemon: {
                pid: process.pid,
                port: getDaemonPort(),
                startedAt: daemonInfo?.startedAt ?? issuedAt,
                updatedAt: daemonInfo?.updatedAt ?? issuedAt,
                serviceInfo: getProjectServiceManifest(),
              },
              projects: this.listProjectsForRoute(),
              relay: this.getRelayStatus(),
              updatedAt: this.state.updatedAt,
            },
          },
        };
      case CORE_COMMAND_NAMES.projectsList:
        return {
          status: 200,
          body: { ok: true, id, command, issuedAt, result: { projects: this.listProjectsForRoute() } },
        };
      case CORE_COMMAND_NAMES.projectEnsure: {
        const ensureProjectRoot = this.requireProjectRoot(id, command, payload);
        if (!ensureProjectRoot.ok) return ensureProjectRoot.response;
        return {
          status: 200,
          body: {
            ok: true,
            id,
            command,
            issuedAt,
            result: { project: await this.ensureProject(ensureProjectRoot.projectRoot) },
          },
        };
      }
      case CORE_COMMAND_NAMES.projectStop: {
        const stopProjectRoot = this.requireProjectRoot(id, command, payload);
        if (!stopProjectRoot.ok) return stopProjectRoot.response;
        return {
          status: 200,
          body: {
            ok: true,
            id,
            command,
            issuedAt,
            result: { project: await this.stopProject(stopProjectRoot.projectRoot) },
          },
        };
      }
      case CORE_COMMAND_NAMES.projectKill: {
        const killProjectRoot = this.requireProjectRoot(id, command, payload);
        if (!killProjectRoot.ok) return killProjectRoot.response;
        return {
          status: 200,
          body: {
            ok: true,
            id,
            command,
            issuedAt,
            result: { project: await this.stopProject(killProjectRoot.projectRoot, { force: true }) },
          },
        };
      }
      case CORE_COMMAND_NAMES.restart: {
        const restartProjectRoot = this.optionalProjectRoot(id, command, payload);
        if (!restartProjectRoot.ok) return restartProjectRoot.response;
        return {
          status: 200,
          body: {
            ok: true,
            id,
            command,
            issuedAt,
            result: await this.restartControlPlane(issuedAt, restartProjectRoot.projectRoot),
          },
        };
      }
      case CORE_COMMAND_NAMES.relayStatus:
        return {
          status: 200,
          body: { ok: true, id, command, issuedAt, result: { relay: this.getRelayStatus() } },
        };
      case CORE_COMMAND_NAMES.relayEnable:
        return {
          status: 200,
          body: { ok: true, id, command, issuedAt, result: { relay: this.enableRelay() } },
        };
      case CORE_COMMAND_NAMES.relayDisable:
        return {
          status: 200,
          body: { ok: true, id, command, issuedAt, result: { relay: this.disableRelay() } },
        };
      default:
        return assertNeverCoreCommand(command);
    }
  }

  async routeRequest(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<DaemonRouteResponse> {
    this.refreshState();
    const routeUrl = new URL(path, getDaemonBaseUrl());
    const pathname = routeUrl.pathname;
    const actor = parseRemoteActor(headers);
    const access = assertRemoteAccessAllowed(actor, method, pathname, routeUrl.searchParams);
    if (!access.ok) {
      return { status: access.status ?? 403, body: { ok: false, error: access.error ?? "remote access denied" } };
    }
    if (method === "POST" && LOCAL_AUTH_ROUTES.has(pathname) && actor) {
      return { status: 403, body: "auth routes are loopback-only\n", contentType: "text/plain; charset=utf-8" };
    }
    if (LOCAL_CLI_TEXT_ROUTES.has(pathname) && actor) {
      return {
        status: 403,
        body: "core text routes are loopback-only\n",
        contentType: "text/plain; charset=utf-8",
      };
    }
    if (LOCAL_CLI_TEXT_ROUTES.has(pathname) && (headers?.origin || headers?.Origin)) {
      return {
        status: 403,
        body: "core text routes are cli-only\n",
        contentType: "text/plain; charset=utf-8",
      };
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

    if (method === "POST" && pathname === CORE_API_ROUTES.commands) {
      return this.routeCoreCommand(body);
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.daemonEnsureText) {
      const payload = this.daemonEnsurePayload(new Date().toISOString());
      const line = `aimux daemon: pid ${payload.daemon.pid} on http://127.0.0.1:${payload.daemon.port}`;
      return this.textOrJsonLines(routeUrl, payload, [line]);
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.hostStatusText) {
      const project = routeUrl.searchParams.get("project");
      if (!project) {
        return { status: 400, body: "project query is required\n", contentType: "text/plain; charset=utf-8" };
      }
      ensureProjectPaths(project);
      const { payload, knownProject } = this.hostStatusPayload(project, new Date().toISOString());
      return this.textOrJsonLines(routeUrl, payload, renderCoreHostStatusLines(payload, knownProject));
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.hostAgentReadText) {
      return this.hostAgentReadTextRoute(routeUrl, body);
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.logsPathText) {
      return this.logsPathTextRoute(routeUrl);
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.logsTailText) {
      return this.logsTailTextRoute(routeUrl);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.logsClearText) {
      return this.logsClearTextRoute(routeUrl);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.metadataText) {
      return this.metadataTextRoute(routeUrl);
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.doctorVersionsText) {
      return this.doctorVersionsTextRoute(routeUrl);
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.doctorTmuxText) {
      return this.doctorTmuxTextRoute(routeUrl);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.repairText) {
      return this.repairTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.restartText) {
      const issuedAt = new Date().toISOString();
      try {
        const projectParam = routeUrl.searchParams.get("project");
        const projectRoot = projectParam ? this.resolveProjectRoot(projectParam) : undefined;
        const result = await this.restartControlPlane(issuedAt, projectRoot);
        const response = this.textOrJsonLines(routeUrl, result.restart, result.text.split("\n"));
        return { ...response, status: result.restart.summary.failures > 0 ? 500 : 200 };
      } catch (error) {
        return {
          status: 500,
          body: `${error instanceof Error ? error.message : String(error)}\n`,
          contentType: "text/plain; charset=utf-8",
        };
      }
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.projectEnsureText) {
      const projectParam = routeUrl.searchParams.get("project");
      if (!projectParam) {
        return { status: 400, body: "project query is required\n", contentType: "text/plain; charset=utf-8" };
      }
      const projectRoot = this.resolveProjectRoot(projectParam);
      const project = await this.ensureProject(projectRoot);
      const payload = { project };
      return this.textOrJsonLines(routeUrl, payload, renderCoreProjectEnsureLines(payload));
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.projectServeText) {
      return this.projectServeTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.projectStopText) {
      return this.projectStopTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.projectKillText) {
      return this.projectKillTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.projectRestartText) {
      return this.projectRestartTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.lifecycleSpawnText) {
      return this.lifecycleSpawnTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.lifecycleStopText) {
      return this.lifecycleStopTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.lifecycleKillText) {
      return this.lifecycleKillTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.lifecycleForkText) {
      return this.lifecycleForkTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.agentInputText) {
      return this.agentInputTextRoute(routeUrl, body);
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.agentPsText) {
      return this.agentPsTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.agentRenameText) {
      return this.agentRenameTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.agentMigrateText) {
      return this.agentMigrateTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.loopAddText) {
      return this.loopTextRoute(routeUrl, body, { active: true, render: renderCoreLoopAddLines });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.loopRemoveText) {
      return this.loopTextRoute(routeUrl, body, { active: false, render: renderCoreLoopRemoveLines });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.loopDoneText) {
      return this.loopExitTextRoute(routeUrl, body, {
        event: (message) => ({
          kind: "task_done",
          message: message || "Loop goal completed.",
          tone: "success",
          source: "loop",
        }),
        render: renderCoreLoopDoneLines,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.loopBlockText) {
      return this.loopExitTextRoute(routeUrl, body, {
        event: (message) => ({
          kind: "blocked",
          message: message || "Blocked beyond repair.",
          source: "loop",
        }),
        render: renderCoreLoopBlockLines,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.overseerStartText) {
      return this.overseerStartTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.overseerClearText) {
      return this.overseerClearTextRoute(routeUrl, body);
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.notificationListText) {
      return this.notificationListTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.notificationSendText) {
      return this.notificationSendTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.notificationReadText) {
      return this.notificationReadTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.notificationClearText) {
      return this.notificationClearTextRoute(routeUrl, body);
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.teamShowText) {
      return this.teamShowTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.teamInitText) {
      return this.teamInitTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.teamAddText) {
      return this.teamRoleTextRoute(routeUrl, body, {
        action: "team add",
        routePath: PROJECT_API_ROUTES.team.addRole,
        extraBody: () => {
          const description = this.stringParam(routeUrl, body, "description") || undefined;
          const reviewedBy = this.stringParam(routeUrl, body, "reviewedBy") || undefined;
          const canEdit = this.booleanParam(routeUrl, body, "canEdit", false);
          return {
            ...(description ? { description } : {}),
            ...(reviewedBy ? { reviewedBy } : {}),
            ...(canEdit ? { canEdit: true } : {}),
          };
        },
        render: renderCoreTeamAddLines,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.teamRemoveText) {
      return this.teamRoleTextRoute(routeUrl, body, {
        action: "team remove",
        routePath: PROJECT_API_ROUTES.team.removeRole,
        render: renderCoreTeamRemoveLines,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.teamDefaultText) {
      return this.teamRoleTextRoute(routeUrl, body, {
        action: "team default",
        routePath: PROJECT_API_ROUTES.team.defaultRole,
        render: renderCoreTeamDefaultLines,
      });
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.worktreeListText) {
      return this.worktreeListTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.worktreeCreateText) {
      return this.worktreeCreateTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.worktreeRemoveText) {
      return this.worktreePathTextRoute(routeUrl, body, {
        action: "worktree remove",
        routePath: PROJECT_API_ROUTES.worktreeActions.remove,
        render: renderCoreWorktreeRemoveLines,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.worktreeGraveyardText) {
      return this.worktreePathTextRoute(routeUrl, body, {
        action: "worktree graveyard",
        routePath: PROJECT_API_ROUTES.worktreeActions.graveyard,
        render: renderCoreWorktreeGraveyardLines,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.worktreeResurrectText) {
      return this.worktreePathTextRoute(routeUrl, body, {
        action: "worktree resurrect",
        routePath: PROJECT_API_ROUTES.graveyardActions.resurrectWorktree,
        render: renderCoreWorktreeResurrectLines,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.worktreeDeleteGraveyardText) {
      return this.worktreePathTextRoute(routeUrl, body, {
        action: "worktree delete graveyard",
        routePath: PROJECT_API_ROUTES.graveyardActions.deleteWorktree,
        render: renderCoreWorktreeDeleteGraveyardLines,
      });
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.graveyardListText) {
      return this.graveyardListTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.graveyardSendText) {
      return this.graveyardAgentTextRoute(routeUrl, body, {
        action: "graveyard send",
        routePath: PROJECT_API_ROUTES.agents.kill,
        statusFallback: "graveyarded",
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.graveyardResurrectText) {
      return this.graveyardAgentTextRoute(routeUrl, body, {
        action: "graveyard resurrect",
        routePath: PROJECT_API_ROUTES.graveyardActions.resurrectAgent,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.graveyardCleanupText) {
      return this.graveyardCleanupTextRoute(routeUrl, body);
    }

    if (
      method === "GET" &&
      (pathname === CORE_API_ROUTES.threadsListText || pathname === CORE_API_ROUTES.threadListText)
    ) {
      return this.threadListTextRoute(routeUrl, body);
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.threadShowText) {
      return this.threadShowTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.threadOpenText) {
      return this.threadOpenTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.threadSendText) {
      return this.threadSendTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.threadMarkSeenText) {
      return this.threadMarkSeenTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.threadStatusText) {
      return this.threadStatusTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.messageSendText) {
      return this.messageSendTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.handoffSendText) {
      return this.handoffSendTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.handoffAcceptText) {
      return this.handoffMutationTextRoute(routeUrl, body, {
        action: "handoff accept",
        routePath: PROJECT_API_ROUTES.handoff.accept,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.handoffCompleteText) {
      return this.handoffMutationTextRoute(routeUrl, body, {
        action: "handoff complete",
        routePath: PROJECT_API_ROUTES.handoff.complete,
      });
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.taskListText) {
      return this.taskListTextRoute(routeUrl, body);
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.taskShowText) {
      return this.taskShowTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.taskAssignText) {
      return this.taskAssignTextRoute(routeUrl, body);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.taskAcceptText) {
      return this.taskMutationTextRoute(routeUrl, body, {
        action: "task accept",
        routePath: PROJECT_API_ROUTES.tasks.accept,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.taskBlockText) {
      return this.taskMutationTextRoute(routeUrl, body, {
        action: "task block",
        routePath: PROJECT_API_ROUTES.tasks.block,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.taskCompleteText) {
      return this.taskMutationTextRoute(routeUrl, body, {
        action: "task complete",
        routePath: PROJECT_API_ROUTES.tasks.complete,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.taskReopenText) {
      return this.taskMutationTextRoute(routeUrl, body, {
        action: "task reopen",
        routePath: PROJECT_API_ROUTES.tasks.reopen,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.reviewApproveText) {
      return this.taskMutationTextRoute(routeUrl, body, {
        action: "review approve",
        routePath: PROJECT_API_ROUTES.reviews.approve,
      });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.reviewRequestChangesText) {
      return this.reviewRequestChangesTextRoute(routeUrl, body);
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.daemonStatusText) {
      const projects = this.listProjectsForRoute();
      const payload = this.daemonStatusTextPayload(projects);
      return this.textOrJsonLines(routeUrl, payload, renderCoreDaemonStatusLines(payload));
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.daemonProjectsText) {
      const projects = this.listProjectsForRoute();
      return this.textOrJsonLines(routeUrl, { projects }, renderCoreDaemonProjectsLines(projects));
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.projectsListText) {
      const projects = this.listProjectsForRoute();
      return this.textOrJsonLines(routeUrl, { projects }, renderCoreProjectsListLines(projects));
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.remoteStatusText) {
      const payload = this.remoteStatusTextPayload();
      const json = { loggedIn: Boolean(payload.credentials), relay: payload.relay };
      return this.textOrJsonLines(routeUrl, json, renderCoreRemoteStatusLines(payload));
    }

    if (method === "GET" && pathname === CORE_API_ROUTES.whoamiText) {
      const payload = this.whoamiTextPayload();
      return this.textOrJsonLines(routeUrl, coreWhoamiJson(payload), renderCoreWhoamiLines(payload));
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.remoteEnableText) {
      if (!loadCredentials()) {
        return {
          status: 401,
          body: "Not logged in. Run `aimux login` first.\n",
          contentType: "text/plain; charset=utf-8",
        };
      }
      const relay = this.enableRelay();
      return this.textOrJsonLines(routeUrl, { relay }, renderCoreRemoteEnableLines(relay));
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.remoteDisableText) {
      this.disableRelay();
      return this.textOrJsonLines(routeUrl, { relay: { status: "off" } }, renderCoreRemoteDisableLines(true));
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.loginStartText) {
      return this.startAuthTextRoute(undefined);
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.loginWaitText) {
      return this.waitAuthTextRoute(routeUrl, { render: renderCoreLoginLines });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.loginText) {
      return this.runAuthTextRoute({ render: renderCoreLoginLines });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.logoutText) {
      this.disableRelay();
      const result = clearCredentials();
      return {
        status: result === "failed" ? 500 : 200,
        body: `${renderCoreLogoutLines(result).join("\n")}\n`,
        contentType: "text/plain; charset=utf-8",
      };
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.securityUnlockStartText) {
      return this.startAuthTextRoute("security-unlock");
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.securityUnlockWaitText) {
      return this.waitAuthTextRoute(routeUrl, { action: "security-unlock", render: renderCoreSecurityUnlockLines });
    }

    if (method === "POST" && pathname === CORE_API_ROUTES.securityUnlockText) {
      return this.runAuthTextRoute({ action: "security-unlock", render: renderCoreSecurityUnlockLines });
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
      return { status: 200, body: { ok: true, projects: this.listProjectsForRoute() } };
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
      const project = await this.stopProject(b.projectRoot);
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
    if (req.method === "GET" && url.pathname === CORE_API_ROUTES.hostAgentStreamText) {
      const streamTarget = await this.resolveHostAgentStreamTextRoute(url, requestHeaders(req));
      if (!streamTarget.ok) {
        send(res, streamTarget.response.status, streamTarget.response.body, streamTarget.response.contentType);
        return;
      }
      await this.pipeHostAgentStreamText(streamTarget.url, streamTarget.sessionId, res);
      return;
    }

    const body =
      req.method === "POST" && url.pathname !== CORE_API_ROUTES.restartText ? await readJson(req) : undefined;
    const result = await this.routeRequest(
      req.method ?? "GET",
      `${url.pathname}${url.search}`,
      body,
      requestHeaders(req),
    );
    send(res, result.status, result.body, result.contentType);
  }
}
