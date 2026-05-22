import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayClient } from "./relay-client.js";
import type { AimuxDaemon } from "./daemon.js";

describe("RelayClient runtime compatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails fast when the Node runtime has no global WebSocket", () => {
    vi.stubGlobal("WebSocket", undefined);
    const daemon = { routeRequest: vi.fn() } as unknown as AimuxDaemon;
    const client = new RelayClient("wss://relay.aimux.com/", "token", daemon);

    client.connect();

    const status = client.getStatus();
    expect(status).toMatchObject({
      status: "disconnected",
      relayUrl: "wss://relay.aimux.com",
      lastConnectedAt: null,
    });
    expect(status.lastError).toContain("Node 22+");
  });
});
