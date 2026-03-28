import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { getAimuxDirFor, getProjectStateDirById, listProjects } from "./paths.js";

export interface GlobalSession {
  id: string;
  tool: string;
  status: "running" | "idle" | "waiting" | "offline";
  label?: string;
  headline?: string;
  worktreePath?: string;
  ownerPid?: number;
  isServer: boolean;
}

export interface ProjectInfo {
  name: string;
  path: string;
  sessions: GlobalSession[];
}

/**
 * Discover all projects with aimux state.
 * Uses the global projects registry plus filesystem scanning as fallback.
 */
export function discoverProjects(): string[] {
  const found = new Set<string>();

  // Primary: projects registry
  for (const entry of listProjects()) {
    if (existsSync(entry.repoRoot)) {
      found.add(entry.repoRoot);
    }
  }

  // Fallback: scan common dev directories for old-style in-repo .aimux/
  const home = homedir();
  const scanDirs = [
    join(home, "cs"),
    join(home, "projects"),
    join(home, "dev"),
    join(home, "src"),
    join(home, "code"),
    join(home, "work"),
  ];

  for (const scanDir of scanDirs) {
    try {
      const entries = readdirSync(scanDir);
      for (const entry of entries) {
        const projectPath = join(scanDir, entry);
        try {
          if (!statSync(projectPath).isDirectory()) continue;
          const aimuxDir = join(projectPath, ".aimux");
          if (existsSync(join(aimuxDir, "instances.json")) || existsSync(join(aimuxDir, "state.json"))) {
            found.add(projectPath);
          }
        } catch {}
      }
    } catch {}
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

  // Check both global state dir and in-repo .aimux/ for instances
  const instancesPaths = [join(getAimuxDirFor(projectPath), "instances.json")];
  const statusDirs = [join(getAimuxDirFor(projectPath), "status")];

  // Also check global project state dirs for registered projects
  if (registryEntry) {
    const projectStateDir = getProjectStateDirById(registryEntry.id);
    const globalInstances = join(projectStateDir, "instances.json");
    if (!instancesPaths.includes(globalInstances)) {
      instancesPaths.unshift(globalInstances);
    }
    statusDirs.unshift(join(projectStateDir, "status"));
  }

  for (const instancesPath of instancesPaths) {
    if (!existsSync(instancesPath)) continue;
    try {
      const instances = JSON.parse(readFileSync(instancesPath, "utf-8")) as Array<{
        instanceId: string;
        pid: number;
        sessions: Array<{ id: string; tool: string; worktreePath?: string; backendSessionId?: string }>;
      }>;

      for (const inst of instances) {
        // Check PID alive
        try {
          process.kill(inst.pid, 0);
        } catch {
          continue;
        }

        const isServer = inst.instanceId.startsWith("server-");

        for (const s of inst.sessions) {
          if (seenIds.has(s.id)) continue;
          seenIds.add(s.id);

          let headline: string | undefined;
          for (const statusDir of statusDirs) {
            try {
              const statusPath = join(statusDir, `${s.id}.md`);
              if (existsSync(statusPath)) {
                const content = readFileSync(statusPath, "utf-8").trim();
                if (content) {
                  headline = content.split("\n")[0].slice(0, 80);
                  break;
                }
              }
            } catch {
              // Try the next candidate directory.
            }
          }

          sessions.push({
            id: s.id,
            tool: s.tool,
            status: "running",
            headline,
            worktreePath: s.worktreePath,
            ownerPid: inst.pid,
            isServer,
          });
        }
      }
    } catch {}
  }

  // Offline sessions — check both global state and in-repo
  const statePaths = [join(getAimuxDirFor(projectPath), "state.json")];
  if (registryEntry) {
    const globalState = join(getProjectStateDirById(registryEntry.id), "state.json");
    if (!statePaths.includes(globalState)) {
      statePaths.unshift(globalState);
    }
  }

  for (const statePath of statePaths) {
    if (!existsSync(statePath)) continue;
    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
        sessions: Array<{
          id: string;
          command: string;
          tool?: string;
          label?: string;
          headline?: string;
          worktreePath?: string;
        }>;
      };

      for (const s of state.sessions) {
        if (seenIds.has(s.id)) continue;
        seenIds.add(s.id);

        sessions.push({
          id: s.id,
          tool: s.command ?? s.tool ?? "unknown",
          status: "offline",
          label: s.label,
          headline: s.headline,
          worktreePath: s.worktreePath,
          isServer: false,
        });
      }
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
