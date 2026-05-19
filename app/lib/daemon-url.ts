import { Platform } from "react-native";
import { env } from "@/lib/env";

// Default daemon port matches the constant baked into src/daemon.ts (DAEMON_PORT).
// Override via EXPO_PUBLIC_AIMUX_DAEMON_URL if the daemon is running elsewhere.
const DEFAULT_WEB_DAEMON_URL = "http://localhost:43190";

/**
 * Resolves the aimux daemon base URL.
 *  - Web (default): http://localhost:43190
 *  - Web (override): EXPO_PUBLIC_AIMUX_DAEMON_URL
 *  - Native: EXPO_PUBLIC_AIMUX_DAEMON_URL is required.
 *    Mobile devices cannot reach localhost on the dev machine, so we require an
 *    explicit URL.
 */
export function getDaemonUrl(): string {
  const override = env.AIMUX_DAEMON_URL;
  if (override) return override.replace(/\/$/, "");
  if (Platform.OS === "web") return DEFAULT_WEB_DAEMON_URL;
  throw new Error(
    "EXPO_PUBLIC_AIMUX_DAEMON_URL must be set on native (mobile cannot reach localhost on the dev machine).",
  );
}

export interface ServiceEndpoint {
  host: string;
  port: number;
}

export function getServiceUrl(endpoint: ServiceEndpoint): string {
  return `http://${endpoint.host}:${endpoint.port}`;
}
