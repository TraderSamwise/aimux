import { Platform } from "react-native";
import { rawEnv } from "./envRuntime";

export type AppConnectionMode = "local" | "relay";

const PROD_RELAY_URL = "wss://relay.aimux.app";
const DEFAULT_WEB_DAEMON_URL = "http://localhost:43190";

function cleanUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isProductionBuild(): boolean {
  return rawEnv.NODE_ENV === "production";
}

export function resolveAppConnectionMode(): AppConnectionMode {
  const explicit = optionalEnv(rawEnv.EXPO_PUBLIC_AIMUX_CONNECTION_MODE);
  if (explicit === "local" || explicit === "relay") return explicit;
  if (explicit) {
    throw new Error(
      `EXPO_PUBLIC_AIMUX_CONNECTION_MODE must be "local" or "relay", got ${explicit}`,
    );
  }
  return isProductionBuild() ? "relay" : "local";
}

export function resolveAppRelayUrl(): string | undefined {
  if (resolveAppConnectionMode() !== "relay") return undefined;
  return cleanUrl(optionalEnv(rawEnv.EXPO_PUBLIC_AIMUX_RELAY_URL) ?? PROD_RELAY_URL);
}

export function resolveAppDaemonUrl(): string | undefined {
  if (resolveAppConnectionMode() !== "local") return undefined;
  const override = optionalEnv(rawEnv.EXPO_PUBLIC_AIMUX_DAEMON_URL);
  if (override) return cleanUrl(override);
  if (Platform.OS === "web") return DEFAULT_WEB_DAEMON_URL;
  throw new Error(
    "EXPO_PUBLIC_AIMUX_DAEMON_URL must be set for local mode on native (mobile cannot reach localhost on the dev machine).",
  );
}

export const APP_CONNECTION_TARGET_DEFAULTS = {
  prodRelayUrl: PROD_RELAY_URL,
  defaultWebDaemonUrl: DEFAULT_WEB_DAEMON_URL,
} as const;
