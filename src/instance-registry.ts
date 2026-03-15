import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as lockfile from "proper-lockfile";
import { getAimuxDir } from "./config.js";
import { findMainRepo } from "./worktree.js";
import { debug } from "./debug.js";

export interface InstanceSessionRef {
  id: string;
  tool: string;
  backendSessionId?: string;
  worktreePath?: string;
}

export interface InstanceInfo {
  instanceId: string;
  pid: number;
  startedAt: string;
  heartbeat: string;
  cwd: string;
  sessions: InstanceSessionRef[];
}

const HEARTBEAT_STALE_MS = 15_000;
const LOCK_RETRIES = { retries: 5, minTimeout: 50 };

/**
 * Get the path to instances.json for a given directory.
 */
export function getInstancesPath(cwd: string): string {
  return join(getAimuxDir(cwd), "instances.json");
}

/**
 * Check if a PID is alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Filter out dead instances (dead PID or stale heartbeat).
 */
function pruneDeadEntries(instances: InstanceInfo[]): InstanceInfo[] {
  const now = Date.now();
  return instances.filter((inst) => {
    if (!isPidAlive(inst.pid)) {
      debug(`pruning dead instance ${inst.instanceId} (PID ${inst.pid} dead)`, "instance");
      return false;
    }
    const heartbeatAge = now - new Date(inst.heartbeat).getTime();
    if (heartbeatAge > HEARTBEAT_STALE_MS) {
      debug(
        `pruning stale instance ${inst.instanceId} (heartbeat ${Math.round(heartbeatAge / 1000)}s old)`,
        "instance",
      );
      return false;
    }
    return true;
  });
}

/**
 * Read instances.json, returning empty array if missing or corrupt.
 */
function readInstancesFile(filePath: string): InstanceInfo[] {
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as InstanceInfo[];
  } catch {
    return [];
  }
}

/**
 * Ensure the directory for the instances file exists and the file is created.
 */
function ensureInstancesFile(filePath: string): void {
  const dir = filePath.replace(/\/[^/]+$/, "");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(filePath)) {
    writeFileSync(filePath, "[]");
  }
}

/**
 * Run an operation against instances.json with locking.
 * Operates on both the local cwd and the main repo (for cross-worktree discovery).
 */
async function withLockedInstances(
  cwd: string,
  fn: (instances: InstanceInfo[], filePath: string) => InstanceInfo[],
): Promise<void> {
  const paths = getInstancesPaths(cwd);

  for (const filePath of paths) {
    ensureInstancesFile(filePath);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(filePath, { retries: LOCK_RETRIES });
      const instances = readInstancesFile(filePath);
      const updated = fn(instances, filePath);
      writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n");
    } finally {
      if (release) await release();
    }
  }
}

/**
 * Get all instances.json paths to update (local + main repo if different).
 */
function getInstancesPaths(cwd: string): string[] {
  const localPath = getInstancesPath(cwd);
  const paths = [localPath];

  try {
    const mainRepo = findMainRepo(cwd);
    const mainPath = getInstancesPath(mainRepo);
    if (mainPath !== localPath) {
      paths.push(mainPath);
    }
  } catch {
    // Not in a git repo or worktree detection failed — local only
  }

  return paths;
}

/**
 * Register this instance in instances.json.
 */
export async function registerInstance(instanceId: string, cwd: string): Promise<InstanceInfo[]> {
  let remoteInstances: InstanceInfo[] = [];

  await withLockedInstances(cwd, (instances) => {
    const pruned = pruneDeadEntries(instances);

    const entry: InstanceInfo = {
      instanceId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeat: new Date().toISOString(),
      cwd,
      sessions: [],
    };

    const updated = [...pruned, entry];
    remoteInstances = pruned.filter((i) => i.instanceId !== instanceId);
    return updated;
  });

  if (remoteInstances.length > 0) {
    debug(`registered instance ${instanceId}, found ${remoteInstances.length} other instance(s)`, "instance");
  } else {
    debug(`registered instance ${instanceId} (sole instance)`, "instance");
  }

  return remoteInstances;
}

/**
 * Unregister this instance from instances.json.
 */
export async function unregisterInstance(instanceId: string, cwd: string): Promise<void> {
  await withLockedInstances(cwd, (instances) => {
    return instances.filter((i) => i.instanceId !== instanceId);
  });
  debug(`unregistered instance ${instanceId}`, "instance");
}

/**
 * Update heartbeat timestamp and sessions list. Also prunes dead instances.
 */
export async function updateHeartbeat(instanceId: string, sessions: InstanceSessionRef[], cwd: string): Promise<void> {
  await withLockedInstances(cwd, (instances) => {
    const pruned = pruneDeadEntries(instances);
    return pruned.map((inst) => {
      if (inst.instanceId === instanceId) {
        return { ...inst, heartbeat: new Date().toISOString(), sessions };
      }
      return inst;
    });
  });
}

/**
 * Get instances belonging to other aimux processes.
 * Reads from main repo's instances.json for cross-worktree visibility.
 */
export function getRemoteInstances(ownInstanceId: string, cwd: string): InstanceInfo[] {
  const paths = getInstancesPaths(cwd);
  const seen = new Set<string>();
  const result: InstanceInfo[] = [];

  for (const filePath of paths) {
    const instances = readInstancesFile(filePath);
    const alive = pruneDeadEntries(instances);
    for (const inst of alive) {
      if (inst.instanceId !== ownInstanceId && !seen.has(inst.instanceId)) {
        seen.add(inst.instanceId);
        result.push(inst);
      }
    }
  }

  return result;
}

/**
 * Remove a session from another instance's entry (takeover step).
 * Returns the claimed session ref, or undefined if not found.
 */
export async function claimSession(
  sessionId: string,
  fromInstanceId: string,
  cwd: string,
): Promise<InstanceSessionRef | undefined> {
  let claimed: InstanceSessionRef | undefined;

  await withLockedInstances(cwd, (instances) => {
    return instances.map((inst) => {
      if (inst.instanceId === fromInstanceId) {
        const session = inst.sessions.find((s) => s.id === sessionId);
        if (session) {
          claimed = session;
          debug(`claimed session ${sessionId} from instance ${fromInstanceId}`, "instance");
          return {
            ...inst,
            sessions: inst.sessions.filter((s) => s.id !== sessionId),
          };
        }
      }
      return inst;
    });
  });

  return claimed;
}
