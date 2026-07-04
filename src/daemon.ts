import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import { ensureProjectPaths, getProjectIdFor } from "./paths.js";
import { listRegisteredDesktopProjects } from "./project-scanner.js";
import { loadMetadataEndpointByProjectId, removeMetadataEndpoint } from "./metadata-store.js";
import { requestJson } from "./http-client.js";
import { log } from "./debug.js";
import { RelayClient, type RelayNotificationPush, type RelayStatusSnapshot } from "./relay-client.js";
import { MobilePushThrottle } from "./mobile-push-throttle.js";
import { clearCredentials, loadCredentials, setRemoteEnabled } from "./credentials.js";
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
  renderCoreHostStatusLines,
  renderCoreLifecycleForkLines,
  renderCoreLifecycleKillLines,
  renderCoreLifecycleSpawnLines,
  renderCoreLifecycleStopLines,
  renderCoreLoginLines,
  renderCoreLogoutLines,
  renderCoreProjectEnsureLines,
  renderCoreProjectsListLines,
  renderCoreRemoteDisableLines,
  renderCoreRemoteEnableLines,
  renderCoreRemoteStatusLines,
  renderCoreSecurityUnlockLines,
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
  type CoreGraveyardAgentTextPayload,
  type CoreGraveyardCleanupTextPayload,
  type CoreGraveyardTextPayload,
  type CoreHostStatusTextPayload,
  type CoreLifecycleForkTextPayload,
  type CoreLifecycleKillTextPayload,
  type CoreLifecycleSpawnTextPayload,
  type CoreLifecycleStopTextPayload,
  type CoreRemoteStatusTextPayload,
  type CoreWorktreeCreateTextPayload,
  type CoreWorktreePathTextPayload,
  type CoreWorktreeSummaryTextPayload,
  type CoreWhoamiTextPayload,
} from "./core-text.js";
import { runLoginFlow } from "./login-flow.js";
import { getProjectServiceManifest } from "./project-service-manifest.js";
import { renderRuntimeRestartResult, restartAimuxControlPlane } from "./runtime-restart.js";
import { isAimuxProjectServiceProcess, isPidAlive } from "./process-inspector.js";
import { CoreProjectActor } from "./core-project-actor.js";
import { findMainRepo } from "./worktree.js";
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
  CORE_API_ROUTES.graveyardCleanupText,
  CORE_API_ROUTES.graveyardListText,
  CORE_API_ROUTES.graveyardResurrectText,
  CORE_API_ROUTES.graveyardSendText,
  CORE_API_ROUTES.lifecycleForkText,
  CORE_API_ROUTES.lifecycleKillText,
  CORE_API_ROUTES.lifecycleSpawnText,
  CORE_API_ROUTES.lifecycleStopText,
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

  private async getProjectServiceJson(
    projectRoot: string,
    routePath: string,
    opts: { ensureProject?: boolean } = {},
  ): Promise<
    { ok: true; projectRoot: string; json: ProjectServiceJson } | { ok: false; response: DaemonRouteResponse }
  > {
    const resolvedRoot = this.resolveProjectRoot(projectRoot);
    try {
      if (opts.ensureProject !== false) await this.ensureProject(resolvedRoot);
      const endpoint = loadMetadataEndpointByProjectId(getProjectIdFor(resolvedRoot));
      if (!endpoint) {
        return { ok: false, response: this.textError(503, `Error: project service unavailable for ${resolvedRoot}`) };
      }
      const { status, json } = await requestJson<ProjectServiceJson>(
        `http://${endpoint.host}:${endpoint.port}${routePath}`,
        { timeoutMs: PROXY_TIMEOUT_MS },
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

  private async postProjectServiceJson(
    projectRoot: string,
    routePath: string,
    body: Record<string, unknown>,
    opts: { ensureProject?: boolean; timeoutMs?: number } = {},
  ): Promise<
    { ok: true; projectRoot: string; json: ProjectServiceJson } | { ok: false; response: DaemonRouteResponse }
  > {
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
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
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

    if (method === "POST" && pathname === CORE_API_ROUTES.restartText) {
      const issuedAt = new Date().toISOString();
      try {
        const result = await this.restartControlPlane(issuedAt);
        return {
          status: result.restart.summary.failures > 0 ? 500 : 200,
          body: `${result.text}\n`,
          contentType: "text/plain; charset=utf-8",
        };
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
