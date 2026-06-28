import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { getAimuxDirFor, getProjectStateDirById, listProjects } from "./paths.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import { RuntimeTopologyStore } from "./runtime-core/topology-store.js";
import { topologySessionToSessionState } from "./runtime-core/topology-sessions.js";
import { loadConfig } from "./config.js";

export interface GlobalSession {
  id: string;
  tool: string;
  status: "running" | "idle" | "waiting" | "offline";
  label?: string;
  headline?: string;
  role?: string;
  worktreePath?: string;
}

export interface ProjectInfo {
  name: string;
  path: string;
  sessions: GlobalSession[];
}

export interface DesktopProjectInfo {
  id: string;
  name: string;
  path: string;
  lastSeen?: string;
  dashboardSessionName: string;
}

function getHiddenProjectTmpDirs(): Set<string> {
  const osTmpDir = tmpdir();
  const dirs = new Set([osTmpDir]);
  try {
    dirs.add(realpathSync(osTmpDir));
  } catch {}
  return dirs;
}

function shouldHideDesktopProject(projectPath: string, tmpDirs = getHiddenProjectTmpDirs()): boolean {
  if (!projectPath || !existsSync(projectPath)) {
    return true;
  }
  const name = basename(projectPath);
  const isTmpProject = [...tmpDirs].some((tmpDir) => projectPath.startsWith(tmpDir));
  return isTmpProject && name.startsWith("aimux-");
}

function getConfiguredTmuxSessionPrefix(): string {
  try {
    return loadConfig().runtime.tmux.sessionPrefix || "aimux";
  } catch {
    return "aimux";
  }
}

function topologyStatusToGlobalStatus(status: string | undefined): GlobalSession["status"] {
  if (status === "running" || status === "idle" || status === "waiting" || status === "offline") return status;
  return "offline";
}

/**
 * Discover local projects with aimux state.
 * Uses the global projects registry. Runtime topology lives in the
 * registry-owned project state directory, not in legacy presence files.
 */
export function discoverProjects(): string[] {
  const found = new Set<string>();

  // Primary: projects registry
  for (const entry of listProjects()) {
    if (existsSync(entry.repoRoot)) {
      found.add(entry.repoRoot);
    }
  }

  return [...found];
}

/**
 * Scan a single project for all sessions (running + offline).
 */
export function scanProject(projectPath: string): ProjectInfo {
  const sessions: GlobalSession[] = [];
  const seenIds = new Set<string>();
  const registryEntry = listProjects().find((entry) => entry.repoRoot === projectPath);
  const sessionById = new Map<string, GlobalSession>();

  const statusDirs = [join(getAimuxDirFor(projectPath), "status")];

  // Also check global project state dirs for registered projects
  if (registryEntry) {
    const projectStateDir = getProjectStateDirById(registryEntry.id);
    statusDirs.unshift(join(projectStateDir, "status"));
  }

  function readStatusHeadline(sessionId: string): string | undefined {
    for (const statusDir of statusDirs) {
      try {
        const statusPath = join(statusDir, `${sessionId}.md`);
        if (existsSync(statusPath)) {
          const content = readFileSync(statusPath, "utf-8").trim();
          if (content) {
            return content.split("\n")[0].slice(0, 80);
          }
        }
      } catch {
        // Try the next candidate directory.
      }
    }
    return undefined;
  }

  const topologyPaths: string[] = [];
  if (registryEntry) {
    topologyPaths.push(join(getProjectStateDirById(registryEntry.id), "runtime-topology.yaml"));
  }

  for (const topologyPath of topologyPaths) {
    if (!existsSync(topologyPath)) continue;
    try {
      const topology = new RuntimeTopologyStore(topologyPath).read();
      for (const topologySession of topology.sessions.filter((session) => session.status !== "graveyard")) {
        const s = topologySessionToSessionState(topologySession, topology);
        if (seenIds.has(s.id)) {
          const existing = sessionById.get(s.id);
          if (existing) {
            existing.status = topologyStatusToGlobalStatus(topologySession.status);
            existing.label = s.label ?? existing.label;
            existing.headline = s.headline ?? existing.headline ?? readStatusHeadline(s.id);
            existing.worktreePath = s.worktreePath ?? existing.worktreePath;
          }
          continue;
        }
        const session: GlobalSession = {
          id: s.id,
          tool: s.command ?? s.tool ?? "unknown",
          status: topologyStatusToGlobalStatus(topologySession.status),
          label: s.label,
          headline: s.headline ?? readStatusHeadline(s.id),
          worktreePath: s.worktreePath,
        };
        sessions.push(session);
        sessionById.set(s.id, session);
        seenIds.add(s.id);
      }
    } catch {}
  }

  // Enrich known sessions with the global statusline projection when available.
  const statuslinePaths = registryEntry ? [join(getProjectStateDirById(registryEntry.id), "statusline.json")] : [];

  for (const statuslinePath of statuslinePaths) {
    if (!existsSync(statuslinePath)) continue;
    try {
      const stat = statSync(statuslinePath);
      if (Date.now() - stat.mtimeMs > 10_000) continue;
      const statusline = JSON.parse(readFileSync(statuslinePath, "utf-8")) as {
        sessions?: Array<{
          id: string;
          tool?: string;
          label?: string;
          headline?: string;
          status?: "running" | "idle" | "waiting" | "offline";
          role?: string;
        }>;
      };

      for (const s of statusline.sessions ?? []) {
        const existing = sessionById.get(s.id);
        if (!existing) continue;
        existing.tool = s.tool ?? existing.tool;
        existing.label = s.label ?? existing.label;
        existing.headline = s.headline ?? existing.headline;
        existing.role = s.role ?? existing.role;
      }
      break;
    } catch {}
  }

  return {
    name: basename(projectPath),
    path: projectPath,
    sessions,
  };
}

/**
 * Scan all discovered projects and return global state.
 */
export function scanAllProjects(): ProjectInfo[] {
  const projectPaths = discoverProjects();
  return projectPaths
    .map(scanProject)
    .filter((p) => p.sessions.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listDesktopProjects(tmux = new TmuxRuntimeManager()): DesktopProjectInfo[] {
  const scannedByPath = new Map(scanAllProjects().map((project) => [project.path, project]));
  const projects = new Map<string, DesktopProjectInfo>();
  const tmpDirs = getHiddenProjectTmpDirs();

  for (const entry of listProjects()) {
    if (shouldHideDesktopProject(entry.repoRoot, tmpDirs)) continue;
    const tmuxSession = tmux.getProjectSession(entry.repoRoot);
    projects.set(entry.repoRoot, {
      id: entry.id,
      name: entry.name,
      path: entry.repoRoot,
      lastSeen: entry.lastSeen,
      dashboardSessionName: tmuxSession.sessionName,
    });
  }

  for (const scanned of scannedByPath.values()) {
    if (shouldHideDesktopProject(scanned.path, tmpDirs)) continue;
    if (projects.has(scanned.path)) continue;
    const tmuxSession = tmux.getProjectSession(scanned.path);
    projects.set(scanned.path, {
      id: `unregistered-${tmuxSession.sessionName}`,
      name: scanned.name,
      path: scanned.path,
      dashboardSessionName: tmuxSession.sessionName,
    });
  }

  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export function listRegisteredDesktopProjects(): DesktopProjectInfo[] {
  const tmpDirs = getHiddenProjectTmpDirs();
  const sessionPrefix = getConfiguredTmuxSessionPrefix();
  return listProjects()
    .filter((entry) => !shouldHideDesktopProject(entry.repoRoot, tmpDirs))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      path: entry.repoRoot,
      lastSeen: entry.lastSeen,
      dashboardSessionName: `${sessionPrefix}-${entry.id}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}
