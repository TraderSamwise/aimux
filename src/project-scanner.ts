import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { getAimuxDir } from "./config.js";

export interface GlobalSession {
  id: string;
  tool: string;
  status: "running" | "idle" | "waiting" | "offline";
  label?: string;
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
 * Discover all projects with .aimux/ directories.
 * Scans common dev directories and any previously seen projects.
 */
export function discoverProjects(): string[] {
  const home = homedir();
  const found = new Set<string>();

  // Scan common dev directories
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
  const aimuxDir = join(projectPath, ".aimux");
  const sessions: GlobalSession[] = [];
  const seenIds = new Set<string>();

  // Running sessions from instances.json
  const instancesPath = join(aimuxDir, "instances.json");
  if (existsSync(instancesPath)) {
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

          // Read status file
          let label: string | undefined;
          try {
            const statusCwd = s.worktreePath ?? projectPath;
            const statusPath = join(getAimuxDir(statusCwd), "status", `${s.id}.md`);
            if (existsSync(statusPath)) {
              const content = readFileSync(statusPath, "utf-8").trim();
              if (content) label = content.split("\n")[0].slice(0, 80);
            }
          } catch {}

          sessions.push({
            id: s.id,
            tool: s.tool,
            status: "running",
            label,
            worktreePath: s.worktreePath,
            ownerPid: inst.pid,
            isServer,
          });
        }
      }
    } catch {}
  }

  // Offline sessions from state.json
  const statePath = join(aimuxDir, "state.json");
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
        sessions: Array<{
          id: string;
          command: string;
          tool?: string;
          label?: string;
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
