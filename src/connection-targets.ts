import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PROD_WEB_APP_URL = "https://aimux.app";
const PROD_RELAY_URL = "wss://relay.aimux.app";
const DEV_WEB_APP_URL = "http://localhost:8081";
const DEV_HOME = join(homedir(), ".aimux-dev");
const DEV_DAEMON_PORT = "43191";

function cleanUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeHome(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

// Mirrors launcher-env's lane detection: any one dev-lane signal marks the
// runtime as development, so the label survives a single var being unset.
export function isDevelopmentRuntime(): boolean {
  return (
    process.env.AIMUX_ENV?.trim() === "development" ||
    normalizeHome(process.env.AIMUX_HOME) === DEV_HOME ||
    process.env.AIMUX_DAEMON_PORT?.trim() === DEV_DAEMON_PORT ||
    optionalEnv(process.env.AIMUX_WEB_APP_URL) === DEV_WEB_APP_URL
  );
}

export function resolveWebAppUrl(override?: string): string {
  const value =
    optionalEnv(override) ??
    optionalEnv(process.env.AIMUX_WEB_APP_URL) ??
    (isDevelopmentRuntime() ? DEV_WEB_APP_URL : PROD_WEB_APP_URL);
  return cleanUrl(value);
}

export function resolveRelayUrl(): string {
  return cleanUrl(optionalEnv(process.env.AIMUX_RELAY_URL) ?? PROD_RELAY_URL);
}

export const CONNECTION_TARGET_DEFAULTS = {
  prodWebAppUrl: PROD_WEB_APP_URL,
  prodRelayUrl: PROD_RELAY_URL,
  devWebAppUrl: DEV_WEB_APP_URL,
} as const;
