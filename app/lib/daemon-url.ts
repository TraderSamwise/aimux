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
  // Whose loopback. `127.0.0.1:43191` names a different project service on
  // each of Sam's machines, so an address without the machine is not an
  // address once more than one is connected. Absent in local mode and on a
  // shared surface, where there is only ever one host to mean.
  machineId?: string;
}

// One cache key for one address. Seven screens spelled this as
// `host:port`, which is the same string for the same project service on two
// different machines -- switching machines would have shown the other one's
// data until the next refresh.
export function serviceEndpointKey(endpoint: ServiceEndpoint | null | undefined): string | null {
  if (!endpoint) return null;
  return `${endpoint.machineId ?? ""}:${endpoint.host}:${endpoint.port}`;
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
