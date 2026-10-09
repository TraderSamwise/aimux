import { describe, expect, it } from "vitest";

import type { RelayStatus } from "@/lib/relay-transport";

import {
  initialMainRoute,
  relayLandingSignal,
  type InitialMainRouteInput,
  type RelayLandingSignal,
} from "./initial-main-route";

const base: InitialMainRouteInput = {
  activeProjectCount: 1,
  isSignedIn: true,
  projectDiscoverySynced: true,
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

  it("defaults to project while project discovery has not proven there are no active projects", () => {
    expect(
      initialMainRoute({ ...base, activeProjectCount: 0, projectDiscoverySynced: false }),
    ).toBe("project");
  });

  it("routes to shared for a signed-in user with shares and no active projects", () => {
    expect(initialMainRoute({ ...base, activeProjectCount: 0 })).toBe("shared");
  });

  it("routes to shared for a signed-in user with shares when the relay is unavailable", () => {
    expect(initialMainRoute({ ...base, activeProjectCount: 2, relaySignal: "unavailable" })).toBe(
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

  it("lands on the user's own surface once the relay answers", () => {
    expect(initialMainRoute({ ...base, relaySignal: "available" })).toBe("project");
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
