import { existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getGlobalAimuxDir, getProjectIdFor } from "./paths.js";
import { writeJsonAtomic } from "./atomic-write.js";
import { requestJson } from "./http-client.js";
import { log } from "./debug.js";
import { commandArgValueMatches } from "./process-args.js";

interface OtherOwner {
  home: string;
  port: number;
}

interface DaemonInfo {
  pid: number;
  port?: number;
}

interface DaemonState {
  projects?: Record<string, { pid?: number; projectId?: string; projectRoot?: string }>;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function knownOwners(): OtherOwner[] {
  return [{ home: join(homedir(), ".aimux"), port: 43190 }];
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  writeJsonAtomic(path, value);
}

function readProcessCwd(pid: number): string | null {
  try {
    const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const cwd = output
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1)
      .trim();
    return cwd || null;
  } catch {
    return null;
  }
}

function isAimuxProjectServiceProcess(
  pid: number,
  expected: { projectId?: string; projectRoot?: string } = {},
): boolean {
  try {
    const args = execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!args.includes("__project-service-internal")) return false;
    if (!args.includes("--project-id") && !args.includes("--project-root") && expected.projectRoot) {
      return resolve(readProcessCwd(pid) ?? "") === resolve(expected.projectRoot);
    }
    if (expected.projectId && !commandArgValueMatches(args, "--project-id", expected.projectId)) return false;
    if (expected.projectRoot && !commandArgValueMatches(args, "--project-root", expected.projectRoot)) return false;
    return true;
  } catch {
    return false;
  }
}

async function requestOtherOwnerStop(owner: OtherOwner, projectRoot: string): Promise<boolean> {
  const info = readJson<DaemonInfo>(join(owner.home, "daemon", "daemon.json"));
  const port = info?.port ?? owner.port;
  if (!info?.pid || !isPidAlive(info.pid)) return false;
  try {
    const { status, json } = await requestJson(`http://127.0.0.1:${port}/projects/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { projectRoot },
      timeoutMs: 1500,
    });
    return status >= 200 && status < 300 && json?.ok !== false;
  } catch {
    return false;
  }
}

function cleanOtherOwnerProjectState(owner: OtherOwner, projectId: string): void {
  const statePath = join(owner.home, "daemon", "state.json");
  const state = readJson<DaemonState>(statePath);
  const entry = state?.projects?.[projectId];
  if (entry?.pid && isPidAlive(entry.pid)) {
    if (isAimuxProjectServiceProcess(entry.pid, { projectId, projectRoot: entry.projectRoot })) {
      try {
        process.kill(entry.pid, "SIGTERM");
      } catch {}
    } else {
      log.warn("skipping stale takeover pid with unverified identity", "daemon", {
        ownerHome: owner.home,
        projectId,
        projectRoot: entry.projectRoot,
        pid: entry.pid,
      });
    }
  }
  if (state?.projects?.[projectId]) {
    delete state.projects[projectId];
    writeJson(statePath, state);
  }
  const projectStateDir = join(owner.home, "projects", projectId);
  for (const file of ["metadata-api.json", "metadata-api.txt"]) {
    try {
      rmSync(join(projectStateDir, file), { force: true });
    } catch {}
  }
}

export async function takeOverProjectFromOtherOwners(projectRoot: string): Promise<void> {
  const currentHome = resolve(getGlobalAimuxDir());
  const projectId = getProjectIdFor(projectRoot);
  for (const owner of knownOwners()) {
    if (resolve(owner.home) === currentHome) continue;
    try {
      await requestOtherOwnerStop(owner, projectRoot);
      cleanOtherOwnerProjectState(owner, projectId);
    } catch (error) {
      log.warn("project takeover cleanup failed for alternate owner", "daemon", {
        ownerHome: owner.home,
        projectRoot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
