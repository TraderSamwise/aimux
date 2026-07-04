import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAimuxDashboardLaunchCommand } from "../cli-launcher.js";
import { DEFAULT_DAEMON_PORT, DEFAULT_ENV, DEFAULT_HOME, DEFAULT_WEB_APP_URL } from "../launcher-env.js";
import type { TmuxCommandSpec } from "../tmux/runtime-manager.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export interface DashboardCommandSpec {
  scriptPath: string;
  dashboardBuildStamp: string;
  dashboardCommand: TmuxCommandSpec;
}

const DASHBOARD_ENV_KEYS = [
  "AIMUX_HOME",
  "AIMUX_DAEMON_HOST",
  "AIMUX_DAEMON_PORT",
  "AIMUX_ENV",
  "AIMUX_WEB_APP_URL",
  "AIMUX_CLI_BIN",
  "AIMUX_INSTALL_ROOT",
] as const;
const DASHBOARD_ENV_STAMP_DEFAULTS: Partial<Record<(typeof DASHBOARD_ENV_KEYS)[number], string>> = {
  AIMUX_HOME: DEFAULT_HOME,
  AIMUX_DAEMON_PORT: DEFAULT_DAEMON_PORT,
  AIMUX_ENV: DEFAULT_ENV,
  AIMUX_WEB_APP_URL: DEFAULT_WEB_APP_URL,
};
const STABLE_SHIM_ENV_KEYS = ["AIMUX_CLI_BIN", "AIMUX_INSTALL_ROOT"] as const;

function resolveExistingArtifact(compiledPath: string, sourcePath: string): string {
  if (existsSync(compiledPath)) return compiledPath;
  return sourcePath;
}

function resolveDashboardScriptPath(): string {
  return resolveExistingArtifact(
    fileURLToPath(new URL("../launcher-bin.js", import.meta.url)),
    fileURLToPath(new URL("../launcher-bin.ts", import.meta.url)),
  );
}

function resolveDashboardImplementationPath(): string {
  return resolveExistingArtifact(
    fileURLToPath(new URL("../main.js", import.meta.url)),
    fileURLToPath(new URL("../main.ts", import.meta.url)),
  );
}

function resolveStableShimArtifactPaths(stableShimPath: string): string[] | null {
  try {
    const realShimPath = realpathSync(stableShimPath);
    if (basename(realShimPath) !== "aimux" || basename(dirname(realShimPath)) !== "bin") return null;
    const installRoot = dirname(dirname(realShimPath));
    const artifactPaths = [join(installRoot, "dist", "launcher-bin.js"), join(installRoot, "dist", "main.js")];
    return artifactPaths.every((path) => existsSync(path)) ? artifactPaths : null;
  } catch {
    return null;
  }
}

function buildDashboardEnvCommandPrefix(
  env: NodeJS.ProcessEnv,
  options: { forStamp?: boolean; unsetKeys?: readonly string[] } = {},
): string {
  const unsets = (options.unsetKeys ?? []).map((key) => `-u ${shellQuote(key)}`);
  const entries = DASHBOARD_ENV_KEYS.flatMap((key) => {
    const value = env[key]?.trim();
    if (options.forStamp && value && DASHBOARD_ENV_STAMP_DEFAULTS[key] === value) return [];
    return value ? [`${key}=${shellQuote(value)}`] : [];
  });
  const args = [...unsets, ...entries];
  return args.length > 0 ? `env ${args.join(" ")} ` : "";
}

function dashboardEnvForLaunch(env: NodeJS.ProcessEnv, source: "stable-shim" | "current-entry"): NodeJS.ProcessEnv {
  if (source === "stable-shim") return env;
  const { AIMUX_CLI_BIN: _cliBin, AIMUX_INSTALL_ROOT: _installRoot, ...rest } = env;
  return rest;
}

function buildDashboardStamp(artifactPaths: string[], command: string): string {
  const artifactHash = createHash("sha256");
  for (const path of [...new Set(artifactPaths)]) {
    artifactHash.update(`${path}:${Math.trunc(statSync(path).mtimeMs)}:`);
    artifactHash.update(readFileSync(path));
  }
  const commandHash = createHash("sha256").update(command).digest("hex").slice(0, 16);
  return `${artifactHash.digest("hex").slice(0, 16)}-${commandHash}`;
}

export function getDashboardCommandSpec(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): DashboardCommandSpec {
  const scriptPath = resolveDashboardScriptPath();
  const launch = getAimuxDashboardLaunchCommand({ env, currentArgvEntry: scriptPath });
  const artifactPaths =
    launch.source === "stable-shim"
      ? (resolveStableShimArtifactPaths(launch.stableShimPath) ?? [scriptPath, resolveDashboardImplementationPath()])
      : [scriptPath, resolveDashboardImplementationPath()];
  const aimuxCommand = [launch.command, ...launch.args].map(shellQuote).join(" ");
  const dashboardEnv = dashboardEnvForLaunch(env, launch.source);
  const unsetKeys = launch.source === "current-entry" ? STABLE_SHIM_ENV_KEYS : [];
  const dashboardEntrypoint = `${buildDashboardEnvCommandPrefix(dashboardEnv, { unsetKeys })}${aimuxCommand}`;
  const dashboardStampEntrypoint = `${buildDashboardEnvCommandPrefix(dashboardEnv, {
    forStamp: true,
    unsetKeys,
  })}${aimuxCommand}`;
  const wrappedDashboardCommand = [
    "output_file=$(mktemp /tmp/aimux-dashboard-output.XXXXXX)",
    ";",
    "set -o pipefail",
    ";",
    dashboardEntrypoint,
    "2>&1",
    "|",
    "tee",
    '"$output_file"',
    "|",
    "tee",
    "-a",
    shellQuote("/tmp/aimux-debug.log"),
    ";",
    "code=$?",
    ";",
    "if",
    "[",
    "$code",
    "-ne",
    "0",
    "]",
    ";",
    "then",
    "printf",
    "'\\033[?1049l\\033[H\\033[2J'",
    ";",
    "if",
    "[",
    "-s",
    '"$output_file"',
    "]",
    ";",
    "then",
    "cat",
    '"$output_file"',
    ";",
    "else",
    "printf",
    "%s\\n%s\\n",
    shellQuote("No dashboard stderr/stdout was captured."),
    shellQuote("Last debug log lines:"),
    ";",
    "tail",
    "-n",
    "40",
    shellQuote("/tmp/aimux-debug.log"),
    ";",
    "fi",
    ";",
    "printf",
    "%s\\n",
    shellQuote(""),
    ";",
    "printf",
    "%s\\n%s\\n%s\\n%s\\n%s\\n",
    shellQuote("aimux dashboard failed to start."),
    shellQuote("The error above was captured from the dashboard process."),
    shellQuote("If that output is empty, the last debug-log lines were shown instead."),
    shellQuote("Press q, Enter, or Ctrl+C to close this pane."),
    shellQuote(""),
    ";",
    "printf",
    "%s\\n",
    '"exit code: $code"',
    ";",
    "while",
    "IFS= read -rsn1 key",
    ";",
    "do",
    "if",
    "[",
    "-z",
    '"$key"',
    "]",
    "||",
    "[",
    '"$key"',
    "=",
    shellQuote("q"),
    "]",
    ";",
    "then",
    "rm",
    "-f",
    '"$output_file"',
    ";",
    "exit 0",
    ";",
    "fi",
    ";",
    "done",
    ";",
    "else",
    "rm",
    "-f",
    '"$output_file"',
    ";",
    "fi",
  ].join(" ");
  const stampCommand = wrappedDashboardCommand.replace(dashboardEntrypoint, dashboardStampEntrypoint);
  return {
    scriptPath,
    dashboardBuildStamp: buildDashboardStamp(artifactPaths, stampCommand),
    dashboardCommand: {
      cwd: projectRoot,
      command: "bash",
      args: ["-lc", wrappedDashboardCommand],
    },
  };
}
