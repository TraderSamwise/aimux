import { homedir } from "node:os";
import { resolve, join } from "node:path";

const PROD_HOME = join(homedir(), ".aimux");
const DEV_HOME = join(homedir(), ".aimux-dev");
const PROD_DAEMON_PORT = "43190";
const DEV_DAEMON_PORT = "43191";
const PROD_WEB_APP_URL = "https://aimux.app";
const DEV_WEB_APP_URL = "http://localhost:8081";

type MutableEnv = Record<string, string | undefined>;

function normalizeHome(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function sameHome(value: string | undefined, expected: string): boolean {
  const normalized = normalizeHome(value);
  return normalized !== null && normalized === expected;
}

function sameValue(value: string | undefined, expected: string): boolean {
  return value?.trim() === expected;
}

function blank(value: string | undefined): boolean {
  return !value?.trim();
}

function clearSessionScopedEnv(env: MutableEnv): void {
  delete env.AIMUX_METADATA_ENDPOINT_FILE;
  delete env.AIMUX_SESSION_ID;
  delete env.AIMUX_SHELL_INTEGRATION_SCRIPT;
  delete env.AIMUX_TOOL;
}

export function prepareStableCliEnv(env: MutableEnv = process.env): void {
  const inheritedDevTarget =
    sameHome(env.AIMUX_HOME, DEV_HOME) ||
    sameValue(env.AIMUX_DAEMON_PORT, DEV_DAEMON_PORT) ||
    sameValue(env.AIMUX_ENV, "development") ||
    sameValue(env.AIMUX_WEB_APP_URL, DEV_WEB_APP_URL);

  if (blank(env.AIMUX_HOME) || sameHome(env.AIMUX_HOME, DEV_HOME)) env.AIMUX_HOME = PROD_HOME;
  if (blank(env.AIMUX_DAEMON_PORT) || sameValue(env.AIMUX_DAEMON_PORT, DEV_DAEMON_PORT)) {
    env.AIMUX_DAEMON_PORT = PROD_DAEMON_PORT;
  }
  if (blank(env.AIMUX_ENV) || sameValue(env.AIMUX_ENV, "development")) env.AIMUX_ENV = "production";
  if (blank(env.AIMUX_WEB_APP_URL) || sameValue(env.AIMUX_WEB_APP_URL, DEV_WEB_APP_URL)) {
    env.AIMUX_WEB_APP_URL = PROD_WEB_APP_URL;
  }

  if (inheritedDevTarget) clearSessionScopedEnv(env);
}

export function prepareDevCliEnv(env: MutableEnv = process.env): void {
  const inheritedStableTarget =
    sameHome(env.AIMUX_HOME, PROD_HOME) ||
    sameValue(env.AIMUX_DAEMON_PORT, PROD_DAEMON_PORT) ||
    sameValue(env.AIMUX_ENV, "production") ||
    sameValue(env.AIMUX_WEB_APP_URL, PROD_WEB_APP_URL);

  if (blank(env.AIMUX_HOME) || sameHome(env.AIMUX_HOME, PROD_HOME)) env.AIMUX_HOME = DEV_HOME;
  if (blank(env.AIMUX_DAEMON_PORT) || sameValue(env.AIMUX_DAEMON_PORT, PROD_DAEMON_PORT)) {
    env.AIMUX_DAEMON_PORT = DEV_DAEMON_PORT;
  }
  if (blank(env.AIMUX_ENV) || sameValue(env.AIMUX_ENV, "production")) env.AIMUX_ENV = "development";
  if (blank(env.AIMUX_WEB_APP_URL) || sameValue(env.AIMUX_WEB_APP_URL, PROD_WEB_APP_URL)) {
    env.AIMUX_WEB_APP_URL = DEV_WEB_APP_URL;
  }

  if (inheritedStableTarget) clearSessionScopedEnv(env);
}

/** Which CLI entry to load for the given argv. `expose` uses the lightweight popup entry. */
export function cliEntryFor(argv: string[]): "expose" | "main" {
  return argv[2] === "expose" ? "expose" : "main";
}

/**
 * Load and run the CLI entry for the current argv. `expose` routes to the lightweight
 * popup entry (no full-CLI graph) to avoid the cold-start blank; everything else loads
 * the full program, which self-runs via its top-level parse().
 */
export function runRoutedCli(): void {
  if (cliEntryFor(process.argv) === "expose") {
    void import("./popup-expose.js").then((m) => m.runExpose());
  } else {
    void import("./main.js");
  }
}
