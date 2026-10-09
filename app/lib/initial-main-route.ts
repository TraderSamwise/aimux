import { isRelayUnavailableForProjectDiscovery } from "@/lib/project-connection-display";
import type { RelayStatus } from "@/lib/relay-transport";

export type InitialMainRoute = "project" | "shared";

export type RelayLandingSignal = "available" | "unavailable" | "unknown";

/**
 * What the relay has told us about itself, as three answers rather than two.
 *
 * `relayStatusAtom` starts at "disconnected", which is also what a dropped
 * socket reports, so `status !== "connected"` read every cold launch as a
 * failure and landed the user on shared chats. The terminal set is
 * `isRelayUnavailableForProjectDiscovery`, which the project surfaces already
 * use -- deriving from it rather than restating it keeps one answer.
 */
export function relayLandingSignal(configured: boolean, status: RelayStatus): RelayLandingSignal {
  // Local mode has no relay to wait for, and the old rule only ever consulted
  // the status when one was configured.
  if (!configured) return "available";
  if (status === "connected") return "available";
  if (isRelayUnavailableForProjectDiscovery(status)) return "unavailable";
  return "unknown";
}

export interface InitialMainRouteInput {
  isSignedIn: boolean;
  realSharedChatCount: number;
  activeProjectCount: number;
  projectDiscoverySynced: boolean;
  relayConfigured: boolean;
  relayStatus: RelayStatus;
}

export function initialMainRoute(input: InitialMainRouteInput): InitialMainRoute {
  if (!input.isSignedIn || input.realSharedChatCount <= 0) return "project";

  const cliUnavailable = input.relayConfigured && input.relayStatus !== "connected";
  const noActiveProjects = input.projectDiscoverySynced && input.activeProjectCount === 0;

  return cliUnavailable || noActiveProjects ? "shared" : "project";
}
