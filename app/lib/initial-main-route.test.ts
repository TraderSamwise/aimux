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
  realSharedChatCount: 1,
  activeProjectCount: 1,
  projectDiscoverySynced: true,
  relayConfigured: true,
  relayStatus: "connected",
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
      initialMainRoute({
        ...base,
        activeProjectCount: 0,
        projectDiscoverySynced: false,
        relayConfigured: false,
        relayStatus: "disconnected",
      }),
    ).toBe("project");
  });

  it("routes to shared for a signed-in user with shares and no active projects", () => {
    expect(initialMainRoute({ ...base, activeProjectCount: 0 })).toBe("shared");
  });

  it("routes to shared for a signed-in user with shares when the relay CLI lane is unavailable", () => {
    expect(
      initialMainRoute({ ...base, activeProjectCount: 2, relayStatus: "device_pending" }),
    ).toBe("shared");
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
