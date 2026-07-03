import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface AimuxCliLaunchCommand {
  command: string;
  args: string[];
  source: "stable-shim" | "current-entry";
  currentEntryPath: string;
  stableShimPath: string;
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function currentEntryPath(): string {
  const compiledPath = fileURLToPath(new URL("./main.js", import.meta.url));
  if (fileExists(compiledPath)) return compiledPath;
  return fileURLToPath(new URL("./main.ts", import.meta.url));
}

function normalizeDir(path: string): string {
  const normalized = resolve(path);
  return normalized.endsWith(sep) ? normalized : `${normalized}${sep}`;
}

export function getAimuxStableShimPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AIMUX_CLI_BIN?.trim() || `${homedir()}/.local/bin/aimux`;
}

function shouldUseStableShim(input: {
  currentArgvEntry: string | undefined;
  stableShimPath: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (!fileExists(input.stableShimPath)) return false;
  const current = input.currentArgvEntry?.trim();
  if (!current) return false;
  if (resolve(current) === resolve(input.stableShimPath)) return true;
  const nativeRoot = normalizeDir(input.env.AIMUX_INSTALL_ROOT || `${homedir()}/.aimux/native`);
  return resolve(current).startsWith(nativeRoot);
}

function resolveAimuxCliLaunchCommand(
  args: string[] = [],
  options: { env?: NodeJS.ProcessEnv; currentArgvEntry?: string } = {},
): AimuxCliLaunchCommand {
  const env = options.env ?? process.env;
  const stableShimPath = getAimuxStableShimPath(env);
  const currentEntry = currentEntryPath();
  if (
    shouldUseStableShim({
      currentArgvEntry: options.currentArgvEntry ?? process.argv[1],
      stableShimPath,
      env,
    })
  ) {
    return {
      command: stableShimPath,
      args,
      source: "stable-shim",
      currentEntryPath: currentEntry,
      stableShimPath,
    };
  }
  return {
    command: process.execPath,
    args: [currentEntry, ...args],
    source: "current-entry",
    currentEntryPath: currentEntry,
    stableShimPath,
  };
}

export function getAimuxDaemonLaunchCommand(
  options: { env?: NodeJS.ProcessEnv; currentArgvEntry?: string } = {},
): AimuxCliLaunchCommand {
  return resolveAimuxCliLaunchCommand(["daemon", "run"], options);
}

export function getAimuxDashboardLaunchCommand(
  options: { env?: NodeJS.ProcessEnv; currentArgvEntry?: string } = {},
): AimuxCliLaunchCommand {
  return resolveAimuxCliLaunchCommand(["--tmux-dashboard-internal"], options);
}

export function getAimuxCurrentCliIdentity(
  options: { env?: NodeJS.ProcessEnv; currentArgvEntry?: string } = {},
): AimuxCliLaunchCommand {
  return resolveAimuxCliLaunchCommand([], options);
}
