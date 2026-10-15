import { describe, expect, it } from "vitest";

import type { RelayStatus } from "@/lib/relay-transport";

import {
  initialMainRoute,
  isRelayAnswerPendingForLanding,
  ownBackendSignal,
  relayLandingSignal,
  type InitialMainRouteInput,
  type RelayLandingSignal,
} from "./initial-main-route";

const base: InitialMainRouteInput = {
  isSignedIn: true,
  ownBackend: "present",
  realSharedChatCount: 1,
  sharesHydrated: true,
  waitExpired: false,
};

describe("initialMainRoute", () => {
  it("defaults to project when signed out even with cached shared chats", () => {
    expect(initialMainRoute({ ...base, isSignedIn: false })).toBe("project");
  });

  it("defaults to project when there are no real shared chats", () => {
    expect(initialMainRoute({ ...base, realSharedChatCount: 0 })).toBe("project");
  });

  // Sam's second clause: no valid shared chats means his own surface even when
  // there is no relay at all. Shared chats are not a fallback for a dead
  // backend; they are only somewhere to go if he actually has some.
  it("never routes to shared with no shared chats, however dead the relay is", () => {
    for (const ownBackend of ["absent", "unknown"] as const) {
      expect(
        initialMainRoute({ ...base, ownBackend, realSharedChatCount: 0, waitExpired: true }),
        ownBackend,
      ).toBe("project");
    }
  });

  // The whole requirement: a reachable relay with a machine of the user's own
  // means the user's own surface, whatever their project list currently says.
  it("lands on the user's own surface whenever their own backend is reachable", () => {
    expect(initialMainRoute(base)).toBe("project");
  });

  // A shared-chat receiver with no backend. A share resolving at "/" makes the
  // app connect as a guest socket, which is told nothing about any fleet, so
  // the machine list reads empty -- and the fleet genuinely is not theirs.
  it("routes a user with no machines of their own to their shared chats", () => {
    expect(initialMainRoute({ ...base, ownBackend: "absent" })).toBe("shared");
  });

  // The relay answers "do you have a backend" itself: `daemon_status` with no
  // daemon online becomes `daemon_offline`, which is unavailable.
  it("routes to shared when the relay says there is nothing of the user's own", () => {
    expect(initialMainRoute({ ...base, ownBackend: "absent" })).toBe("shared");
  });

  // The reported bug. `relayStatusAtom` starts at "disconnected", so this used
  // to be indistinguishable from a relay that is down, and every cold launch
  // landed on someone else's chats.
  it("waits rather than calling a relay that has not answered unavailable", () => {
    expect(initialMainRoute({ ...base, ownBackend: "unknown" })).toBe("pending");
  });

  // The other half of the bounce: stored shares start empty, so the count said
  // "no shares" for a frame and then said otherwise.
  it("waits rather than reading unread storage as having no shares", () => {
    expect(initialMainRoute({ ...base, realSharedChatCount: 0, sharesHydrated: false })).toBe(
      "pending",
    );
  });

  // A dead relay never answers, so the wait has to end in a decision -- and
  // the decision is the user's own surface, not someone else's chats. The
  // redirect unmounts the landing screen, so a relay that was merely slow has
  // nothing left to correct: expiring into "shared" is unrecoverable.
  it("expires into the user's own surface, not into someone else's chats", () => {
    expect(initialMainRoute({ ...base, ownBackend: "unknown", waitExpired: true })).toBe("project");
    expect(
      initialMainRoute({ ...base, ownBackend: "absent", waitExpired: true }),
      "a backend known to be absent is still the shared list",
    ).toBe("shared");
    expect(
      initialMainRoute({
        ...base,
        realSharedChatCount: 0,
        sharesHydrated: false,
        waitExpired: true,
      }),
      "an unread share list expires to no shares, which is this user's own surface",
    ).toBe("project");
  });

  // Nothing to wait for: shared chats are unreachable signed out.
  it("never waits when signed out", () => {
    expect(
      initialMainRoute({
        ...base,
        isSignedIn: false,
        ownBackend: "unknown",
        sharesHydrated: false,
      }),
    ).toBe("project");
  });
});

describe("ownBackendSignal", () => {
  // Local mode never reports a fleet -- `relayMachinesAtom` is set to `[]` and
  // never filled -- and a local daemon is the user's own backend anyway.
  it("counts local mode as the user's own backend without asking", () => {
    expect(ownBackendSignal(false, "disconnected", 0)).toBe("present");
  });

  it("is the user's own backend when the relay is reachable and names a machine", () => {
    expect(ownBackendSignal(true, "connected", 1)).toBe("present");
  });

  // A guest socket is told nothing about any fleet, so an empty list is the
  // right answer rather than a missing one.
  it("is absent when a reachable relay names no machine of theirs", () => {
    expect(ownBackendSignal(true, "connected", 0)).toBe("absent");
  });

  // `knownMachinesAtom` deliberately remembers machines that have gone away,
  // so a count alone must not outvote the relay.
  it("is absent when the relay has settled a no, whatever machines are remembered", () => {
    expect(ownBackendSignal(true, "auth_failed", 3)).toBe("absent");
    expect(ownBackendSignal(true, "client_storage_error", 3)).toBe("absent");
  });

  // The whole point of this item: a could-not-ask error and a settled no are
  // different answers, and only the second one may send anyone to the shared
  // list -- that redirect unmounts the landing screen and cannot be undone.
  it("is unknown while a retryable failure might still clear", () => {
    expect(ownBackendSignal(true, "relay_unavailable", 0)).toBe("unknown");
    expect(ownBackendSignal(true, "relay_unavailable", 3)).toBe("unknown");
  });

  // A live socket saying the daemon is down HAS answered, and a share-only
  // recipient who never ran a host stays there. Waiting on it spends the whole
  // budget and then lands them on their own empty project surface -- the one
  // user shared chats are for.
  it("is absent at once when the relay reports no daemon up", () => {
    expect(ownBackendSignal(true, "daemon_offline", 0)).toBe("absent");
    expect(ownBackendSignal(true, "daemon_offline", 3)).toBe("absent");
    expect(
      initialMainRoute({
        isSignedIn: true,
        realSharedChatCount: 2,
        sharesHydrated: true,
        ownBackend: ownBackendSignal(true, "daemon_offline", 0),
        waitExpired: false,
      }),
    ).toBe("shared");
  });

  // And an expired wait on one of those lands on the user's own surface, which
  // carries its own copy, rather than on someone else's chats.
  it("expires a retryable failure into the user's own surface", () => {
    expect(
      initialMainRoute({
        isSignedIn: true,
        realSharedChatCount: 3,
        sharesHydrated: true,
        ownBackend: ownBackendSignal(true, "relay_unavailable", 0),
        waitExpired: true,
      }),
    ).toBe("project");
  });

  it("is unknown while the relay has not answered", () => {
    expect(ownBackendSignal(true, "disconnected", 0)).toBe("unknown");
    expect(ownBackendSignal(true, "connecting", 2)).toBe("unknown");
  });

  // Approval is a fact about THIS device, not about the fleet, and the project
  // screen is the only surface that says how to grant it -- the shared list
  // suppresses the pairing banner.
  it("counts a device awaiting approval as having a backend", () => {
    expect(ownBackendSignal(true, "device_pending", 0)).toBe("present");
    expect(ownBackendSignal(true, "device_pending", 2)).toBe("present");
  });
});

describe("relayLandingSignal", () => {
  // Every member, so a new `RelayStatus` has to be classified rather than
  // falling into "unknown" and holding the landing screen on a spinner.
  const SIGNALS = {
    // Waiting does not fix wrong credentials or broken local storage, so these
    // two are the only settled no.
    auth_failed: "unavailable",
    client_storage_error: "unavailable",
    connected: "available",
    connecting: "unknown",
    // A live socket reporting no daemon up is an answer, so this one is
    // settled. `relay_unavailable` is three failed handshakes with a retry
    // scheduled, which is a relay that has not answered at all: reading that
    // as a settled "no backend" sent a user with shared chats to someone
    // else's chats, and the redirect unmounts the landing screen, so the relay
    // connecting a second later had nothing left to re-decide.
    daemon_offline: "unavailable",
    relay_unavailable: "unknown",
    // Approval is a fact about THIS device, and `ownBackendSignal` answers
    // "present" for it before ever consulting this.
    device_pending: "unavailable",
    disconnected: "unknown",
  } as const satisfies Record<RelayStatus, RelayLandingSignal>;

  it("reads a configured relay's own answer, and waits when it has not given one", () => {
    for (const [status, expected] of Object.entries(SIGNALS)) {
      expect(relayLandingSignal(true, status as RelayStatus), status).toBe(expected);
    }
  });

  // The atom's initial value and a dropped socket share this status, which is
  // why it cannot mean "unavailable".
  it("treats the status a cold launch starts on as not yet known", () => {
    expect(relayLandingSignal(true, "disconnected")).toBe("unknown");
    expect(relayLandingSignal(true, "connecting")).toBe("unknown");
  });

  // The table above cannot see this: `connecting` and `disconnected` reach
  // "unknown" through the fall-through, so adding either to the pending
  // predicate changes no answer there while changing what the predicate
  // claims. Pinned as a total table of its own, in both directions.
  it("counts only a relay that has not answered as pending", () => {
    const PENDING = {
      auth_failed: false,
      client_storage_error: false,
      connected: false,
      connecting: false,
      daemon_offline: false,
      device_pending: false,
      disconnected: false,
      relay_unavailable: true,
    } as const satisfies Record<RelayStatus, boolean>;
    for (const [status, expected] of Object.entries(PENDING)) {
      expect(isRelayAnswerPendingForLanding(status as RelayStatus), status).toBe(expected);
    }
  });

  // Local mode writes `disconnected` too, with `configured` false, and there
  // is nothing to wait for there.
  it("never waits on a relay that is not configured", () => {
    for (const status of Object.keys(SIGNALS)) {
      expect(relayLandingSignal(false, status as RelayStatus), status).toBe("available");
    }
  });
});
