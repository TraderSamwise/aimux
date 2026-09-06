import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface AimuxCliLaunchCommand {
  command: string;
  args: string[];
  source: "stable-shim" | "current-entry" | "native-binary";
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
  const compiledPath = fileURLToPath(new URL("./launcher-bin.js", import.meta.url));
  if (fileExists(compiledPath)) return compiledPath;
  return fileURLToPath(new URL("./launcher-bin.ts", import.meta.url));
}

function normalizeDir(path: string): string {
  const normalized = canonicalPath(path);
  return normalized.endsWith(sep) ? normalized : `${normalized}${sep}`;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function platformNativeBinaryPath(installRoot: string): string {
  return join(installRoot, "native", `${process.platform}-${process.arch}`, "aimux");
}

function nativeInstallRootFromEntry(path: string | undefined): string | null {
  const current = path?.trim();
  if (!current) return null;
  const canonical = canonicalPath(current);
  for (const suffix of [
    `${sep}dist${sep}launcher-bin.js`,
    `${sep}dist${sep}launcher-bin.ts`,
    `${sep}dist${sep}main.js`,
    `${sep}dist${sep}main.ts`,
    `${sep}bin${sep}aimux`,
  ]) {
    if (canonical.endsWith(suffix)) return canonical.slice(0, -suffix.length);
  }
  if (basename(canonical) === "aimux" && basename(dirname(canonical)) === `${process.platform}-${process.arch}`) {
    const nativeDir = dirname(dirname(canonical));
    if (basename(nativeDir) === "native") return dirname(nativeDir);
  }
  return null;
}

function nativeBinaryForStableShim(stableShimPath: string): string | null {
  try {
    const realShimPath = realpathSync(stableShimPath);
    if (basename(realShimPath) !== "aimux" || basename(dirname(realShimPath)) !== "bin") return null;
    const nativeBinary = platformNativeBinaryPath(dirname(dirname(realShimPath)));
    return fileExists(nativeBinary) ? nativeBinary : null;
  } catch {
    return null;
  }
}

function resolveInstalledNativeBinary(input: {
  currentArgvEntry: string | undefined;
  currentEntryPath: string;
  stableShimPath: string;
  env: NodeJS.ProcessEnv;
}): string | null {
  const explicit = input.env.AIMUX_NATIVE_BIN?.trim();
  if (explicit && fileExists(explicit)) return canonicalPath(explicit);
  const stableNative = nativeBinaryForStableShim(input.stableShimPath);
  if (stableNative && shouldUseStableShim(input)) return stableNative;
  for (const entry of [input.currentArgvEntry, input.currentEntryPath]) {
    const root = nativeInstallRootFromEntry(entry);
    if (!root) continue;
    const nativeBinary = platformNativeBinaryPath(root);
    if (fileExists(nativeBinary)) return nativeBinary;
  }
  return null;
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
  if (canonicalPath(current) === canonicalPath(input.stableShimPath)) return true;
  const nativeRoot = normalizeDir(input.env.AIMUX_INSTALL_ROOT || `${homedir()}/.aimux/native`);
  return canonicalPath(current).startsWith(nativeRoot);
}

function resolveAimuxCliLaunchCommand(
  args: string[] = [],
  options: { env?: NodeJS.ProcessEnv; currentArgvEntry?: string; preferNativeBinary?: boolean } = {},
): AimuxCliLaunchCommand {
  const env = options.env ?? process.env;
  const stableShimPath = getAimuxStableShimPath(env);
  const currentEntry = currentEntryPath();
  const currentArgvEntry = options.currentArgvEntry ?? process.argv[1];
  if (options.preferNativeBinary) {
    const nativeBinary = resolveInstalledNativeBinary({
      currentArgvEntry,
      currentEntryPath: currentEntry,
      stableShimPath,
      env,
    });
    if (nativeBinary) {
      return {
        command: nativeBinary,
        args,
        source: "native-binary",
        currentEntryPath: nativeBinary,
        stableShimPath,
      };
    }
  }
  if (
    shouldUseStableShim({
      currentArgvEntry,
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
  return resolveAimuxCliLaunchCommand(["daemon", "run"], { ...options, preferNativeBinary: true });
}

export function getAimuxDashboardLaunchCommand(
  options: { env?: NodeJS.ProcessEnv; currentArgvEntry?: string } = {},
): AimuxCliLaunchCommand {
  if ((options.env ?? process.env).AIMUX_DASHBOARD_IMPLEMENTATION?.trim() === "native") {
    return resolveAimuxCliLaunchCommand(["__dashboard-internal-native"], { ...options, preferNativeBinary: true });
  }
  return resolveAimuxCliLaunchCommand(["--tmux-dashboard-internal"], options);
}

export function getAimuxProjectServiceLaunchCommand(
  projectId: string,
  projectRoot: string,
  options: { env?: NodeJS.ProcessEnv; currentArgvEntry?: string } = {},
): AimuxCliLaunchCommand {
  return resolveAimuxCliLaunchCommand(
    ["__project-service-internal", "--project-id", projectId, "--project-root", projectRoot],
    { ...options, preferNativeBinary: true },
  );
}

export function getAimuxCurrentCliIdentity(
  options: { env?: NodeJS.ProcessEnv; currentArgvEntry?: string } = {},
): AimuxCliLaunchCommand {
  return resolveAimuxCliLaunchCommand([], { ...options, preferNativeBinary: true });
}
