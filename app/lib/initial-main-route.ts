import { useEffect, useState } from "react";

import type { StorageReadState } from "@/lib/jotai-storage";
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
  if (isRelayAnswerPendingForLanding(status)) return "unknown";
  if (isRelayUnavailableForProjectDiscovery(status)) return "unavailable";
  return "unknown";
}

/**
 * Whether this status is a relay that has not answered YET, as opposed to one
 * that has answered no.
 *
 * `relay_unavailable` is the could-not-ask error: `relay-transport.ts` sets it
 * after three failed handshakes and schedules a retry, so a cold cellular
 * launch reaches it with nothing known about the fleet, and the next attempt
 * may connect.
 *
 * `daemon_offline` is NOT on this list, although it looks transient. It is set
 * from a LIVE socket carrying `daemon_status { online: false }` -- the relay
 * answered, and the answer was that no daemon of this account is up. A
 * share-only recipient who never ran a host sits there permanently, so
 * treating it as pending made them wait the full budget and then land on their
 * own empty project surface, which is the one user shared chats exist for.
 *
 * `auth_failed` and `client_storage_error` are not on this list either:
 * waiting does not fix wrong credentials or broken local storage.
 */
export function isRelayAnswerPendingForLanding(status: RelayStatus): boolean {
  return status === "relay_unavailable";
}

export type OwnBackendSignal = "present" | "absent" | "unknown";

/**
 * Whether the user has a backend of their own, which is what the landing
 * choice turns on.
 *
 * Local mode has no fleet to report and a local daemon is the user's own by
 * definition, so it is present without asking. With a relay, an empty machine
 * list alongside a reachable relay is the answer: for an owner socket the
 * fleet arrives in the same `daemon_status` message that flips the status, so
 * the list is never merely late, and a guest socket is told nothing about any
 * fleet -- correctly, because the fleet is not theirs.
 */
export function ownBackendSignal(
  relayConfigured: boolean,
  relayStatus: RelayStatus,
  ownMachineCount: number,
): OwnBackendSignal {
  if (!relayConfigured) return "present";
  // A device awaiting approval is not an absent backend -- the fleet may be
  // perfectly healthy and this device simply cannot speak to it yet. The
  // project screen is where the approval instructions are; the shared list
  // suppresses the pairing banner entirely.
  if (relayStatus === "device_pending") return "present";
  const relay = relayLandingSignal(relayConfigured, relayStatus);
  if (relay === "unknown") return "unknown";
  if (relay === "unavailable") return "absent";
  return ownMachineCount > 0 ? "present" : "absent";
}

export interface InitialMainRouteInput {
  isSignedIn: boolean;
  realSharedChatCount: number;
  /**
   * What happened to the stored shares' read, in full.
   *
   * Not a boolean, because the count beside it is only as good as the read:
   * a read that FAILED answers with the DEFAULT -- no shares -- and deciding
   * from that is deciding from a fallback, which is the whole thing this
   * refuses to do elsewhere.
   */
  sharesReadState: StorageReadState;
  ownBackend: OwnBackendSignal;
  waitExpired: boolean;
}

/**
 * Where a launch lands: the user's own project surface, someone else's shared
 * chat, or neither yet.
 *
 * Two facts arrive late and both used to read as settled: the relay's status
 * starts at "disconnected", and stored shares start empty while AsyncStorage
 * is still reading. Deciding on either produced the bounce Sam saw -- project
 * for one frame, then shared. So an unknown is waited on, bounded by
 * {@link RELAY_LANDING_WAIT_MS}, and an expired wait decides with what it has.
 */
export function initialMainRoute(input: InitialMainRouteInput): InitialMainRoute {
  // Signed out has no shared chats to land on, whatever is cached.
  if (!input.isSignedIn) return "project";

  // Before the wait, not after it. A shares read that FAILED has no count to
  // offer and will not acquire one, so there is nothing for the wait to
  // resolve -- waiting on the RELAY as well would spend the whole budget on a
  // question already answered. Their own surface is the safe side, and it is
  // not a consolation prize: a shared list built from a store that cannot be
  // read would be empty anyway.
  if (input.sharesReadState === "failed") return "project";

  const sharesUnknown = input.sharesReadState === "unread";
  const backendUnknown = input.ownBackend === "unknown";
  if ((sharesUnknown || backendUnknown) && !input.waitExpired) return "pending";

  // Expiry decides rather than hangs: an unread share list is no shares, and
  // a relay that never answered is a relay that is not there.
  if (input.realSharedChatCount <= 0) return "project";

  // "No relay available AND you have shared chats" is the whole condition, so
  // only a backend known to be ABSENT sends anyone to the shared list.
  //
  // An expired wait reaches here still "unknown", and that is not the same
  // answer: a relay slow on a cold cellular launch has not said no. Sending
  // that user to shared is unrecoverable, because the redirect unmounts this
  // screen and the relay's later reply has nothing left to re-decide -- they
  // end up on someone else's chats with a working backend. Their own surface
  // is the safe side, and it carries its own copy when the relay really is
  // unreachable.
  return input.ownBackend === "absent" ? "shared" : "project";
}

/**
 * Whether the landing wait has run out, so the decision stops waiting and
 * takes what it has.
 *
 * A hook rather than a `setTimeout` in the screen, because the screen is an
 * Expo Router route no renderer in this app executes: a timer there could be
 * reduced to `setWaitExpired(true)` on the first render -- which removes the
 * wait entirely and restores the bounce -- with every gate green.
 */
export function useLandingWaitExpired(waitMs = RELAY_LANDING_WAIT_MS): boolean {
  const [expired, setExpired] = useState(false);

  // Armed once per mount rather than per decision, so re-deciding cannot
  // restart the clock.
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), waitMs);
    return () => clearTimeout(timer);
  }, [waitMs]);

  return expired;
}
