import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import { getDaemonInfoPath, getDaemonStatePath } from "./paths.js";
import { isPidAlive } from "./process-inspector.js";

const DEFAULT_DAEMON_PORT = 43190;
const DEFAULT_DAEMON_HOST = "127.0.0.1";

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

export function getDaemonBaseUrl(port = getDaemonPort()): string {
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

export interface DaemonState {
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

export function loadDaemonInfo(): AimuxDaemonInfo | null {
  const info = loadJson<AimuxDaemonInfo | null>(getDaemonInfoPath(), null);
  if (!info) return null;
  return isPidAlive(info.pid) ? info : null;
}

export function saveDaemonInfo(info: AimuxDaemonInfo): void {
  saveJson(getDaemonInfoPath(), info);
}

export function clearDaemonInfo(): void {
  clearFile(getDaemonInfoPath());
}

export function loadDaemonState(): DaemonState {
  const raw = loadJson<DaemonState>(getDaemonStatePath(), {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    projects: {},
  });
  const projects: Record<string, ProjectServiceState> = {};
  for (const [projectId, entry] of Object.entries(raw.projects ?? {})) {
    if (entry) projects[projectId] = entry;
  }
  return {
    version: 1,
    updatedAt: raw.updatedAt,
    projects,
  };
}

export function saveDaemonState(state: DaemonState): void {
  saveJson(getDaemonStatePath(), state);
}
