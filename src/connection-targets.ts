const PROD_WEB_APP_URL = "https://aimux.app";
const PROD_RELAY_URL = "wss://relay.aimux.app";
const DEV_WEB_APP_URL = "http://localhost:8081";

function cleanUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isDevelopmentRuntime(): boolean {
  return process.env.AIMUX_ENV?.trim() === "development";
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
