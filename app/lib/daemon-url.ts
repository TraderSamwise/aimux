import { env } from "@/lib/env";

/**
 * Resolves the aimux daemon base URL.
 * Local/dev builds default to local HTTP; production builds default to relay
 * and call this only when explicitly forced into local mode.
 */
export function getDaemonUrl(): string {
  const url = env.AIMUX_DAEMON_URL;
  if (!url) throw new Error("AIMUX daemon URL is not configured for this connection mode.");
  return url;
}

export interface ServiceEndpoint {
  host: string;
  port: number;
}

export function getServiceUrl(endpoint: ServiceEndpoint): string {
  return `http://${endpoint.host}:${endpoint.port}`;
}

export function getRelayHttpUrl(): string | undefined {
  const relayUrl = env.AIMUX_RELAY_URL;
  if (!relayUrl) return undefined;
  if (relayUrl.startsWith("wss://")) return `https://${relayUrl.slice("wss://".length)}`;
  if (relayUrl.startsWith("ws://")) return `http://${relayUrl.slice("ws://".length)}`;
  return relayUrl;
}

export function getRelayServiceUrl(endpoint: ServiceEndpoint, path: string): string | null {
  const relayHttpUrl = getRelayHttpUrl();
  if (!relayHttpUrl) return null;
  return `${relayHttpUrl}/proxy/${endpoint.host}/${endpoint.port}${path}`;
}
