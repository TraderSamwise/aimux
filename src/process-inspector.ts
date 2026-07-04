import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { commandArgValueMatches } from "./process-args.js";

export interface ProcessArgsEntry {
  pid: number;
  args: string;
}

export interface ProjectServiceProcessIdentity {
  projectId?: string;
  projectRoot?: string;
}

export function readProcessArgs(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function listProcessArgs(): ProcessArgsEntry[] {
  try {
    const raw = execFileSync("ps", ["-axo", "pid=,args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw
      .split("\n")
      .map((line) => line.match(/^\s*(\d+)\s+(.+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => ({ pid: Number(match[1]), args: match[2] ?? "" }))
      .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0 && entry.args.trim());
  } catch {
    return [];
  }
}

export function readProcessCwd(pid: number): string | null {
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

export function isExitedProcessState(state: string): boolean {
  return state.trim().startsWith("Z");
}

function readProcessState(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  const state = readProcessState(pid);
  return state === null ? true : !isExitedProcessState(state);
}

export function isAimuxProjectServiceProcess(pid: number, expected: ProjectServiceProcessIdentity = {}): boolean {
  const args = readProcessArgs(pid);
  if (!args?.includes("__project-service-internal")) return false;
  if (!args.includes("--project-id") && !args.includes("--project-root") && expected.projectRoot) {
    return resolve(readProcessCwd(pid) ?? "") === resolve(expected.projectRoot);
  }
  if (expected.projectId && !commandArgValueMatches(args, "--project-id", expected.projectId)) return false;
  if (expected.projectRoot && !commandArgValueMatches(args, "--project-root", expected.projectRoot)) return false;
  return true;
}
