import { isRelayUnavailableForProjectDiscovery } from "@/lib/project-connection-display";
import type { RelayStatus } from "@/lib/relay-transport";

export type InitialMainRoute = "project" | "shared" | "pending";

/// How long the landing screen waits for the relay to answer and for stored
/// shares to load before deciding with whatever it has.
///
/// Generous because the happy path does not pay it: the decision is recomputed
/// when the status changes, so the wait ends the moment the relay answers.
/// `connect()` awaits a Clerk token and a WebSocket handshake first, and a
/// token not yet issued retries on a 1s backoff, so a cold launch can take
/// seconds -- a short budget would send exactly the connected user this is for
/// to someone else's chats.
export const RELAY_LANDING_WAIT_MS = 6_000;

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
  sharesHydrated: boolean;
  activeProjectCount: number;
  projectDiscoverySynced: boolean;
  relaySignal: RelayLandingSignal;
  waitExpired: boolean;
}

/**
 * Where a launch lands: the user's own project surface, someone else's shared
 * chat, or neither yet.
 *
 * Two facts arrive late and both used to read as settled: the relay's status
 * starts at "disconnected", and stored shares start empty while AsyncStorage
 * is still reading. Deciding on either produced the bounce Sam sees -- project
 * for one frame, then shared. So an unknown is waited on, bounded by
 * {@link RELAY_LANDING_WAIT_MS}, and an expired wait decides with what it has.
 */
export function initialMainRoute(input: InitialMainRouteInput): InitialMainRoute {
  // Signed out has no shared chats to land on, whatever is cached.
  if (!input.isSignedIn) return "project";

  const sharesUnknown = !input.sharesHydrated;
  const relayUnknown = input.relaySignal === "unknown";
  if ((sharesUnknown || relayUnknown) && !input.waitExpired) return "pending";

  // Expiry decides rather than hangs: an unread share list is no shares, and
  // a relay that never answered is a relay that is not there.
  if (input.realSharedChatCount <= 0) return "project";

  const relayUnavailable = input.relaySignal !== "available";
  const noActiveProjects = input.projectDiscoverySynced && input.activeProjectCount === 0;

  return relayUnavailable || noActiveProjects ? "shared" : "project";
}
