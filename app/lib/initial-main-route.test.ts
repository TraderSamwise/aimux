import { describe, expect, it } from "vitest";

import type { RelayStatus } from "@/lib/relay-transport";

import {
  initialMainRoute,
  relayLandingSignal,
  type InitialMainRouteInput,
  type RelayLandingSignal,
} from "./initial-main-route";

const base: InitialMainRouteInput = {
  isSignedIn: true,
  ownMachineCount: 1,
  realSharedChatCount: 1,
  relaySignal: "available",
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
    for (const relaySignal of ["unavailable", "unknown"] as const) {
      expect(
        initialMainRoute({
          ...base,
          ownMachineCount: 0,
          realSharedChatCount: 0,
          relaySignal,
          waitExpired: true,
        }),
        relaySignal,
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
    expect(initialMainRoute({ ...base, ownMachineCount: 0 })).toBe("shared");
  });

  // The relay answers "do you have a backend" itself: `daemon_status` with no
  // daemon online becomes `daemon_offline`, which is unavailable.
  it("routes to shared when the relay says there is nothing of the user's own", () => {
    expect(initialMainRoute({ ...base, relaySignal: "unavailable" })).toBe("shared");
  });

  // A machine that exists but whose relay is unreachable is still no backend.
  it("does not let a remembered machine override an unreachable relay", () => {
    expect(initialMainRoute({ ...base, ownMachineCount: 3, relaySignal: "unavailable" })).toBe(
      "shared",
    );
  });

  // The reported bug. `relayStatusAtom` starts at "disconnected", so this used
  // to be indistinguishable from a relay that is down, and every cold launch
  // landed on someone else's chats.
  it("waits rather than calling a relay that has not answered unavailable", () => {
    expect(initialMainRoute({ ...base, relaySignal: "unknown" })).toBe("pending");
  });

  // The other half of the bounce: stored shares start empty, so the count said
  // "no shares" for a frame and then said otherwise.
  it("waits rather than reading unread storage as having no shares", () => {
    expect(initialMainRoute({ ...base, realSharedChatCount: 0, sharesHydrated: false })).toBe(
      "pending",
    );
  });

  // A dead relay never answers, so the wait has to end in a decision.
  it("decides with what it has once the wait expires", () => {
    expect(initialMainRoute({ ...base, relaySignal: "unknown", waitExpired: true })).toBe("shared");
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
        relaySignal: "unknown",
        sharesHydrated: false,
      }),
    ).toBe("project");
  });
});

describe("relayLandingSignal", () => {
  // Every member, so a new `RelayStatus` has to be classified rather than
  // falling into "unknown" and holding the landing screen on a spinner.
  const SIGNALS = {
    auth_failed: "unavailable",
    client_storage_error: "unavailable",
    connected: "available",
    connecting: "unknown",
    daemon_offline: "unavailable",
    device_pending: "unavailable",
    disconnected: "unknown",
    relay_unavailable: "unavailable",
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

  // Local mode writes `disconnected` too, with `configured` false, and there
  // is nothing to wait for there.
  it("never waits on a relay that is not configured", () => {
    for (const status of Object.keys(SIGNALS)) {
      expect(relayLandingSignal(false, status as RelayStatus), status).toBe("available");
    }
  });
});
