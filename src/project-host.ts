import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as lockfile from "proper-lockfile";
import { getHostStatePath } from "./paths.js";
import { debug } from "./debug.js";

export interface ProjectHostInfo {
  instanceId: string;
  pid: number;
  startedAt: string;
  heartbeat: string;
  cwd: string;
  metadataPort?: number;
}

const HOST_HEARTBEAT_STALE_MS = 15_000;
const LOCK_RETRIES = { retries: 5, minTimeout: 50 };

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isHostAlive(host: ProjectHostInfo | null): boolean {
  if (!host) return false;
  if (!isPidAlive(host.pid)) return false;
  const age = Date.now() - new Date(host.heartbeat).getTime();
  return age <= HOST_HEARTBEAT_STALE_MS;
}

function ensureHostFile(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "null\n");
}

function readHost(path: string): ProjectHostInfo | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw || raw === "null") return null;
    return JSON.parse(raw) as ProjectHostInfo;
  } catch {
    return null;
  }
}

function saveHost(path: string, host: ProjectHostInfo | null): void {
  ensureHostFile(path);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(host, null, 2)}\n`);
  renameSync(tmp, path);
}

async function withLockedHost<T>(
  _cwd: string,
  fn: (path: string, current: ProjectHostInfo | null) => Promise<T> | T,
): Promise<T> {
  const path = getHostStatePath();
  ensureHostFile(path);
  const release = await lockfile.lock(path, { retries: LOCK_RETRIES });
  try {
    return await fn(path, readHost(path));
  } finally {
    await release();
  }
}

export async function acquireProjectHost(
  instanceId: string,
  cwd: string,
): Promise<{ claimed: boolean; host: ProjectHostInfo | null }> {
  return withLockedHost(cwd, async (path, current) => {
    const liveCurrent = isHostAlive(current) ? current : null;
    if (liveCurrent && !(liveCurrent.instanceId === instanceId && liveCurrent.pid === process.pid)) {
      return { claimed: false, host: liveCurrent };
    }

    const now = new Date().toISOString();
    const next: ProjectHostInfo = {
      instanceId,
      pid: process.pid,
      startedAt: current?.instanceId === instanceId && current?.pid === process.pid ? current.startedAt : now,
      heartbeat: now,
      cwd,
      metadataPort:
        current?.instanceId === instanceId && current?.pid === process.pid ? current.metadataPort : undefined,
    };
    saveHost(path, next);
    debug(`project host claimed by ${instanceId} pid=${process.pid}`, "host");
    return { claimed: true, host: next };
  });
}

export async function heartbeatProjectHost(
  instanceId: string,
  cwd: string,
  patch: Partial<Pick<ProjectHostInfo, "metadataPort" | "cwd">> = {},
): Promise<ProjectHostInfo | null> {
  return withLockedHost(cwd, async (path, current) => {
    if (!current) return null;
    if (current.instanceId !== instanceId || current.pid !== process.pid) return null;
    const next: ProjectHostInfo = {
      ...current,
      ...patch,
      heartbeat: new Date().toISOString(),
    };
    saveHost(path, next);
    return next;
  });
}

export async function releaseProjectHost(instanceId: string, cwd: string): Promise<void> {
  await withLockedHost(cwd, async (path, current) => {
    if (current && current.instanceId === instanceId && current.pid === process.pid) {
      saveHost(path, null);
      debug(`project host released by ${instanceId} pid=${process.pid}`, "host");
    }
  });
}

export function loadProjectHost(): ProjectHostInfo | null {
  const path = getHostStatePath();
  const current = readHost(path);
  return isHostAlive(current) ? (current as ProjectHostInfo) : null;
}

export async function clearProjectHost(cwd: string): Promise<void> {
  await withLockedHost(cwd, async (path) => {
    saveHost(path, null);
  });
}

export async function terminateProjectHost(
  cwd: string,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<{ host: ProjectHostInfo | null; signaled: boolean }> {
  return withLockedHost(cwd, async (path, current) => {
    const liveCurrent = isHostAlive(current) ? current : null;
    if (!liveCurrent) {
      saveHost(path, null);
      return { host: null, signaled: false };
    }
    try {
      process.kill(liveCurrent.pid, signal);
      debug(`project host ${liveCurrent.instanceId} pid=${liveCurrent.pid} signaled ${signal}`, "host");
      return { host: liveCurrent, signaled: true };
    } catch {
      saveHost(path, null);
      return { host: liveCurrent, signaled: false };
    }
  });
}

export async function pruneDeadProjectHost(cwd: string): Promise<void> {
  await withLockedHost(cwd, async (path, current) => {
    if (current !== null) {
      const host = current as ProjectHostInfo;
      if (isHostAlive(host)) return;
      const deadPid = host.pid;
      saveHost(path, null);
      debug(`pruned dead project host pid=${deadPid}`, "host");
    }
  });
}
