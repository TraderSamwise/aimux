import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getGlobalAimuxDir } from "./paths.js";

/**
 * Recordings outlive the sessions that produced them.
 *
 * graveyard-cleanup removes a recording by session id, so a session that leaves
 * project state without being graveyarded strands its file permanently — the
 * same shape as an install nothing references. This sweep is keyed to age
 * instead of identity, so nothing can fall out of its reach.
 */
export const DEFAULT_RECORDING_RETENTION_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RecordingCleanupCandidate {
  path: string;
  ageDays: number;
  sizeBytes: number;
}

export interface RecordingCleanupPlan {
  retentionDays: number;
  remove: RecordingCleanupCandidate[];
  keptCount: number;
  reclaimableBytes: number;
}

export interface RecordingCleanupResult {
  dryRun: boolean;
  plan: RecordingCleanupPlan;
  removed: number;
  failed: number;
  reclaimedBytes: number;
}

export interface PlanRecordingCleanupOptions {
  projectsRoot?: string;
  /**
   * Recordings also live beside the repo in `<project>/.aimux/recordings`, which
   * the global projects layout does not reach. Pass those directories here.
   */
  extraDirs?: string[];
  retentionDays?: number;
  now?: () => number;
}

export interface RecordingCleanupOperations {
  removeFile?: (path: string) => void | Promise<void>;
}

function listFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

function listRecordingFiles(projectsRoot: string, extraDirs: string[]): string[] {
  let projects: string[];
  try {
    projects = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    projects = [];
  }
  const dirs = [...projects.map((project) => join(projectsRoot, project, "recordings")), ...extraDirs];
  return [...new Set(dirs)].flatMap(listFilesIn);
}

/**
 * Session ids a project still knows about. Age alone cannot tell a dead recording
 * from one belonging to a session that has simply been idle, so the registry is
 * used here as a guard — never as the way recordings are found.
 */
function liveSessionIds(recordingsDir: string): Set<string> {
  const statePath = join(dirname(recordingsDir), "state.json");
  if (!existsSync(statePath)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    const sessions = parsed?.sessions;
    if (Array.isArray(sessions)) {
      return new Set(
        sessions
          .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : entry))
          .filter((id): id is string => typeof id === "string"),
      );
    }
    if (sessions && typeof sessions === "object") return new Set(Object.keys(sessions));
    return new Set();
  } catch {
    return new Set();
  }
}

function recordingSessionId(path: string): string {
  const base = path.split("/").pop() ?? "";
  return base.replace(/\.(log|txt)$/, "");
}

export function planRecordingCleanup(options: PlanRecordingCleanupOptions = {}): RecordingCleanupPlan {
  const projectsRoot = options.projectsRoot ?? join(getGlobalAimuxDir(), "projects");
  const retentionDays = options.retentionDays ?? DEFAULT_RECORDING_RETENTION_DAYS;
  const now = (options.now ?? Date.now)();

  const remove: RecordingCleanupCandidate[] = [];
  let keptCount = 0;
  const liveByDir = new Map<string, Set<string>>();
  for (const path of listRecordingFiles(projectsRoot, options.extraDirs ?? [])) {
    const dir = dirname(path);
    let live = liveByDir.get(dir);
    if (!live) {
      live = liveSessionIds(dir);
      liveByDir.set(dir, live);
    }
    if (live.has(recordingSessionId(path))) {
      keptCount += 1;
      continue;
    }
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const ageDays = (now - stat.mtimeMs) / MS_PER_DAY;
    // A live session writes continuously, so recent mtime is what keeps its
    // recording — no need to know which sessions are alive.
    if (ageDays < retentionDays) {
      keptCount += 1;
      continue;
    }
    remove.push({ path, ageDays, sizeBytes: stat.size });
  }
  remove.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    retentionDays,
    remove,
    keptCount,
    reclaimableBytes: remove.reduce((total, entry) => total + entry.sizeBytes, 0),
  };
}

export async function runRecordingCleanup(
  plan: RecordingCleanupPlan,
  operations: RecordingCleanupOperations = {},
  input?: { dryRun?: boolean; limit?: number },
): Promise<RecordingCleanupResult> {
  // Deleting is the opt-in, matching install cleanup.
  const dryRun = input?.dryRun !== false;
  const removeFile = operations.removeFile ?? ((path: string) => rm(path, { force: true, maxRetries: 3 }));
  const limit = input?.limit;
  const candidates = typeof limit === "number" && limit >= 0 && !dryRun ? plan.remove.slice(0, limit) : plan.remove;

  let removed = 0;
  let failed = 0;
  let reclaimedBytes = 0;
  if (!dryRun) {
    for (const candidate of candidates) {
      try {
        await removeFile(candidate.path);
        removed += 1;
        reclaimedBytes += candidate.sizeBytes;
      } catch {
        failed += 1;
      }
    }
  }

  return { dryRun, plan, removed, failed, reclaimedBytes };
}
