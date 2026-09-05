import { describe, expect, it } from "vitest";

import { initialMainRoute, type InitialMainRouteInput } from "./initial-main-route";

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
