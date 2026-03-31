/**
 * Central path resolution for aimux.
 *
 * Two locations:
 *   - In-repo:  {repoRoot}/.aimux/  → agent-facing shared artifacts
 *                (config, team, plans, context, history, tasks, status, threads, sessions.json)
 *   - Global:   ~/.aimux/projects/<project-id>/  → runtime-private state
 *                (recordings, metadata, instance ownership, statusline internals, offline state)
 *
 * Must call `await initPaths(cwd)` once at startup before using sync path functions.
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { homedir } from "node:os";

// ── Cached state (populated by initPaths) ──────────────────────────

let _repoRoot: string | null = null;
let _projectId: string | null = null;

function assertInitialized(): void {
  if (!_repoRoot || !_projectId) {
    throw new Error("paths not initialized — call initPaths() first");
  }
}

// ── Project ID resolution ──────────────────────────────────────────

function resolveRepoRoot(cwd: string): string {
  try {
    const gitCommonDir = execSync("git rev-parse --git-common-dir", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // gitCommonDir is either ".git" (main worktree) or an absolute path
    const absGitDir = resolve(cwd, gitCommonDir);
    return dirname(absGitDir);
  } catch {
    // Not a git repo — use cwd
    return resolve(cwd);
  }
}

function computeProjectId(repoRoot: string): string {
  const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  const name = basename(repoRoot);
  return `${name}-${hash}`;
}

// ── Public: Initialization ─────────────────────────────────────────

export interface ProjectEntry {
  id: string;
  name: string;
  repoRoot: string;
  lastSeen: string;
}

export async function initPaths(cwd?: string): Promise<void> {
  const dir = cwd ?? process.cwd();
  _repoRoot = resolveRepoRoot(dir);
  _projectId = computeProjectId(_repoRoot);

  // Ensure global project dir exists
  const projectDir = getProjectStateDir();
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  ensureLocalSharedDirs();
  migrateAgentFacingStateToLocal();

  registerProject();
}

export function getRepoRoot(): string {
  assertInitialized();
  return _repoRoot!;
}

export function getProjectId(): string {
  assertInitialized();
  return _projectId!;
}

export function getProjectIdFor(cwd: string): string {
  return computeProjectId(resolveRepoRoot(cwd));
}

export function getProjectStateDirFor(cwd: string): string {
  return join(getGlobalAimuxDir(), "projects", getProjectIdFor(cwd));
}

export function getProjectStateDirById(projectId: string): string {
  return join(getGlobalAimuxDir(), "projects", projectId);
}

// ── Global paths (~/.aimux/...) ────────────────────────────────────

const HOME = homedir();

export function getGlobalAimuxDir(): string {
  return join(HOME, ".aimux");
}

export function getProjectStateDir(): string {
  assertInitialized();
  return join(getGlobalAimuxDir(), "projects", _projectId!);
}

export function getStatePath(): string {
  return join(getProjectStateDir(), "state.json");
}

export function getGraveyardPath(): string {
  return join(getProjectStateDir(), "graveyard.json");
}

export function getContextDir(): string {
  return join(getLocalAimuxDir(), "context");
}

export function getContextPathForDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return join(getContextDir(), `${yyyy}-${mm}-${dd}.md`);
}

export function getHistoryDir(): string {
  return join(getLocalAimuxDir(), "history");
}

export function getRecordingsDir(): string {
  return join(getProjectStateDir(), "recordings");
}

export function getTasksDir(): string {
  return join(getLocalAimuxDir(), "tasks");
}

export function getStatusDir(): string {
  return join(getLocalAimuxDir(), "status");
}

export function getInstancesPath(): string {
  return join(getProjectStateDir(), "instances.json");
}

export function getMetadataPath(): string {
  return join(getProjectStateDir(), "metadata.json");
}

export function getMetadataEndpointPath(): string {
  return join(getProjectStateDir(), "metadata-api.json");
}

export function getStatuslineOwnerPath(): string {
  return join(getProjectStateDir(), "statusline-owner.json");
}

// ── In-repo paths ({repoRoot}/.aimux/...) ──────────────────────────

export function getLocalAimuxDir(): string {
  assertInitialized();
  return join(_repoRoot!, ".aimux");
}

export function getConfigPath(): string {
  return join(getLocalAimuxDir(), "config.json");
}

export function getProjectTeamPath(): string {
  return join(getLocalAimuxDir(), "team.json");
}

export function getPlansDir(): string {
  return join(getLocalAimuxDir(), "plans");
}

export function getThreadsDir(): string {
  return join(getLocalAimuxDir(), "threads");
}

/** Escape hatch for cross-worktree operations. Prefer the no-arg variants above. */
export function getAimuxDirFor(cwd: string): string {
  return join(resolveRepoRoot(cwd), ".aimux");
}

function ensureLocalSharedDirs(): void {
  const localDir = getLocalAimuxDir();
  mkdirSync(localDir, { recursive: true });
  for (const subdir of ["plans", "context", "history", "tasks", "status", "threads"]) {
    mkdirSync(join(localDir, subdir), { recursive: true });
  }
}

function migrateDirIfNeeded(globalSubdir: string, localDir: string): void {
  const source = join(getProjectStateDir(), globalSubdir);
  if (!existsSync(source) || !existsSync(localDir)) return;
  const hasLocalEntries = (() => {
    try {
      return readdirSync(localDir).length > 0;
    } catch {
      return false;
    }
  })();
  if (hasLocalEntries) return;
  try {
    cpSync(source, localDir, { recursive: true, force: false });
  } catch {}
}

function migrateAgentFacingStateToLocal(): void {
  migrateDirIfNeeded("context", getContextDir());
  migrateDirIfNeeded("history", getHistoryDir());
  migrateDirIfNeeded("tasks", getTasksDir());
  migrateDirIfNeeded("status", getStatusDir());
}

// ── Global non-project paths ───────────────────────────────────────

export function getGlobalConfigPath(): string {
  return join(getGlobalAimuxDir(), "config.json");
}

export function getGlobalTeamPath(): string {
  return join(getGlobalAimuxDir(), "team.json");
}

export function getProjectsRegistryPath(): string {
  return join(getGlobalAimuxDir(), "projects.json");
}

// ── Projects registry ──────────────────────────────────────────────

interface ProjectsRegistry {
  version: 1;
  projects: ProjectEntry[];
}

function loadRegistry(): ProjectsRegistry {
  const path = getProjectsRegistryPath();
  if (!existsSync(path)) return { version: 1, projects: [] };
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { version: 1, projects: [] };
  }
}

function saveRegistry(registry: ProjectsRegistry): void {
  const dir = getGlobalAimuxDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getProjectsRegistryPath(), JSON.stringify(registry, null, 2) + "\n");
}

function registerProject(): void {
  assertInitialized();
  const registry = loadRegistry();
  const idx = registry.projects.findIndex((p) => p.id === _projectId);
  const entry: ProjectEntry = {
    id: _projectId!,
    name: basename(_repoRoot!),
    repoRoot: _repoRoot!,
    lastSeen: new Date().toISOString(),
  };
  if (idx >= 0) {
    registry.projects[idx] = entry;
  } else {
    registry.projects.push(entry);
  }
  saveRegistry(registry);
}

export function listProjects(): ProjectEntry[] {
  return loadRegistry().projects;
}

export function removeProject(id: string): void {
  const registry = loadRegistry();
  registry.projects = registry.projects.filter((p) => p.id !== id);
  saveRegistry(registry);
}
