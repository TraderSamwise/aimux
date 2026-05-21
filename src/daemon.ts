import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { writeJsonAtomic } from "./atomic-write.js";
import { getDaemonInfoPath, getDaemonStatePath, getProjectIdFor } from "./paths.js";
import { listDesktopProjects } from "./project-scanner.js";
import { loadMetadataEndpoint } from "./metadata-store.js";
import { requestJson } from "./http-client.js";
import { AUTH_ENABLED, ApiError, verifyApiUser } from "./auth.js";
import { RelayClient, type RelayStatusSnapshot } from "./relay-client.js";
import { loadCredentials, setRemoteEnabled } from "./credentials.js";

const DAEMON_PORT = 43190;
const DAEMON_HOST = "127.0.0.1";
const DAEMON_STARTUP_TIMEOUT_MS = 10_000;
const PROJECT_SERVICE_STARTUP_GRACE_MS = 15_000;

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

interface DaemonState {
  version: 1;
  updatedAt: string;
  projects: Record<string, ProjectServiceState>;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
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

export function loadDaemonInfo(): AimuxDaemonInfo | null {
  const info = loadJson<AimuxDaemonInfo | null>(getDaemonInfoPath(), null);
  if (!info) return null;
  return isPidAlive(info.pid) ? info : null;
}

export async function stopDaemon(signal: NodeJS.Signals = "SIGTERM"): Promise<AimuxDaemonInfo | null> {
  const info = loadDaemonInfo();
  if (!info) return null;
  const state = loadDaemonState();
  for (const entry of Object.values(state.projects)) {
    try {
      process.kill(entry.pid, signal);
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
  return info;
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

export async function requestDaemonJson(path: string, init?: RequestInit): Promise<any> {
  const info = loadDaemonInfo();
  if (!info) {
    throw new Error("aimux daemon is not running");
  }
  const { status, json } = await requestJson(`http://${DAEMON_HOST}:${info.port}${path}`, {
    method: init?.method,
    headers: init?.headers as Record<string, string> | undefined,
    body: init?.body,
  });
  if (status < 200 || status >= 300 || json?.ok === false) {
    throw new Error(json?.error || `daemon request failed: ${status}`);
  }
  return json;
}

export async function ensureDaemonRunning(): Promise<AimuxDaemonInfo> {
  const existing = loadDaemonInfo();
  if (existing) {
    try {
      await requestDaemonJson("/health");
      return existing;
    } catch {
      clearFile(getDaemonInfoPath());
    }
  }

  try {
    const { status, json } = await requestJson(`http://${DAEMON_HOST}:${DAEMON_PORT}/health`);
    if (status >= 200 && status < 300 && json?.ok !== false && typeof json?.pid === "number") {
      const adopted: AimuxDaemonInfo = {
        pid: json.pid,
        port: typeof json?.port === "number" ? json.port : DAEMON_PORT,
        startedAt: loadDaemonInfo()?.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveJson(getDaemonInfoPath(), adopted);
      return adopted;
    }
  } catch {}

  const child = spawn(process.execPath, [process.argv[1]!, "daemon", "run"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = loadDaemonInfo();
    if (info) {
      try {
        await requestDaemonJson("/health");
        return info;
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("timed out waiting for aimux daemon to start");
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
  private readonly children = new Map<string, ChildProcess>();
  private state: DaemonState = loadDaemonState();

  async start(): Promise<void> {
    if (this.server) return;
    saveJson(getDaemonInfoPath(), {
      pid: process.pid,
      port: DAEMON_PORT,
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
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(DAEMON_PORT, DAEMON_HOST, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
    this.refreshState();
    this.connectRelayIfConfigured();
  }

  // Resolve relay config from stored credentials (`aimux login`), with env-var
  // overrides for advanced/CI use. Connects only when remote access is enabled.
  private connectRelayIfConfigured(): void {
    if (this.relayClient) return;
    const creds = loadCredentials();
    const relayUrl = process.env.AIMUX_RELAY_URL ?? creds?.relayUrl;
    const relayToken = process.env.AIMUX_RELAY_TOKEN ?? creds?.token;
    const enabled = creds ? creds.remoteEnabled : Boolean(process.env.AIMUX_RELAY_TOKEN);
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
    this.connectRelayIfConfigured();
    return this.getRelayStatus();
  }

  disableRelay(): { status: "off" } {
    setRemoteEnabled(false);
    this.relayClient?.disconnect();
    this.relayClient = null;
    return { status: "off" };
  }

  stop(): void {
    this.relayClient?.disconnect();
    this.relayClient = null;
    for (const entry of Object.values(this.state.projects)) {
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
      port: DAEMON_PORT,
      startedAt: loadDaemonInfo()?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies AimuxDaemonInfo);
  }

  private spawnProjectService(projectRoot: string, projectId: string): ProjectServiceState {
    const child = spawn(process.execPath, [process.argv[1]!, "__project-service-internal"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
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
    child.on("exit", () => {
      this.children.delete(projectId);
      const current = this.state.projects[projectId];
      if (current?.pid === state.pid) {
        delete this.state.projects[projectId];
        this.refreshState();
      }
    });
    this.refreshState();
    return state;
  }

  private async ensureProject(projectRoot: string): Promise<ProjectServiceState> {
    const resolvedRoot = pathResolve(projectRoot);
    const projectId = getProjectIdFor(resolvedRoot);
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
      const endpoint = loadMetadataEndpoint(resolvedRoot);
      if (!endpoint) {
        if (withinStartupGrace) {
          return refreshExisting();
        }
        try {
          process.kill(existing.pid, "SIGTERM");
        } catch {}
        delete this.state.projects[projectId];
        this.refreshState();
        return this.spawnProjectService(resolvedRoot, projectId);
      }
      try {
        const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}/health`, {
          timeoutMs: 1000,
        });
        if (status < 200 || status >= 300 || json?.ok === false) {
          throw new Error(json?.error || `health request failed: ${status}`);
        }
      } catch {
        if (withinStartupGrace) {
          return refreshExisting();
        }
        try {
          process.kill(existing.pid, "SIGTERM");
        } catch {}
        delete this.state.projects[projectId];
        this.refreshState();
        return this.spawnProjectService(resolvedRoot, projectId);
      }
      return refreshExisting();
    }
    return this.spawnProjectService(resolvedRoot, projectId);
  }

  private stopProject(projectRoot: string): ProjectServiceState | null {
    const projectId = getProjectIdFor(pathResolve(projectRoot));
    const existing = this.state.projects[projectId];
    if (!existing) return null;
    try {
      process.kill(existing.pid, "SIGTERM");
    } catch {}
    delete this.state.projects[projectId];
    this.children.delete(projectId);
    this.refreshState();
    return existing;
  }

  async routeRequest(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    this.refreshState();

    if (method === "GET" && path === "/health") {
      return { status: 200, body: { ok: true, pid: process.pid, port: DAEMON_PORT } };
    }

    if (method === "GET" && path === "/relay/status") {
      return { status: 200, body: { ok: true, relay: this.getRelayStatus() } };
    }

    if (method === "POST" && path === "/relay/enable") {
      return { status: 200, body: { ok: true, relay: this.enableRelay() } };
    }

    if (method === "POST" && path === "/relay/disable") {
      return { status: 200, body: { ok: true, relay: this.disableRelay() } };
    }

    if (method === "GET" && path === "/projects") {
      const liveById = this.state.projects;
      const projects = listDesktopProjects().map((project) => ({
        ...project,
        service: liveById[project.id] ?? null,
        serviceAlive: Boolean(liveById[project.id]),
        serviceEndpoint: project.path ? loadMetadataEndpoint(project.path) : null,
      }));
      return { status: 200, body: { ok: true, projects } };
    }

    if (method === "GET" && path.startsWith("/projects/")) {
      const projectId = decodeURIComponent(path.slice("/projects/".length));
      const project = this.state.projects[projectId] ?? null;
      return { status: 200, body: { ok: true, project } };
    }

    if (method === "POST" && path === "/projects/ensure") {
      const b = body as { projectRoot?: string } | undefined;
      if (!b?.projectRoot) {
        return { status: 400, body: { ok: false, error: "projectRoot is required" } };
      }
      const project = await this.ensureProject(b.projectRoot);
      return { status: 200, body: { ok: true, project } };
    }

    if (method === "POST" && path === "/projects/stop") {
      const b = body as { projectRoot?: string } | undefined;
      if (!b?.projectRoot) {
        return { status: 400, body: { ok: false, error: "projectRoot is required" } };
      }
      const project = this.stopProject(b.projectRoot);
      return { status: 200, body: { ok: true, project } };
    }

    const proxyMatch = path.match(/^\/proxy\/([^/]+)\/(\d+)(\/.*)/);
    if (proxyMatch) {
      const [, host, portStr, subPath] = proxyMatch;
      try {
        const { status, json } = await requestJson(`http://${host}:${portStr}${subPath}`, {
          method,
          body: body !== undefined ? body : undefined,
        });
        return { status, body: json };
      } catch (err) {
        return { status: 502, body: { ok: false, error: err instanceof Error ? err.message : "Proxy error" } };
      }
    }

    return { status: 404, body: { ok: false, error: "not found" } };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${DAEMON_HOST}:${DAEMON_PORT}`);

    if (AUTH_ENABLED && url.pathname !== "/health") {
      try {
        await verifyApiUser(req);
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 401;
        const message = err instanceof Error ? err.message : "Unauthorized";
        send(res, status, { ok: false, error: message });
        return;
      }
    }

    const body = req.method === "POST" ? await readJson(req) : undefined;
    const result = await this.routeRequest(req.method ?? "GET", url.pathname, body);
    send(res, result.status, result.body);
  }
}
