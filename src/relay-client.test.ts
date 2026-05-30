import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayClient } from "./relay-client.js";
import type { AimuxDaemon } from "./daemon.js";
import { notifyRemoteClientConnected } from "./notify.js";

vi.mock("./notify.js", () => ({
  notifyRemoteClientConnected: vi.fn(),
}));

describe("RelayClient runtime compatibility", () => {
  beforeEach(() => {
    vi.mocked(notifyRemoteClientConnected).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("fails fast when the Node runtime has no global WebSocket", () => {
    vi.stubGlobal("WebSocket", undefined);
    const daemon = { routeRequest: vi.fn() } as unknown as AimuxDaemon;
    const client = new RelayClient("wss://relay.aimux.app/", "token", daemon);

    client.connect();

    const status = client.getStatus();
    expect(status).toMatchObject({
      status: "disconnected",
      relayUrl: "wss://relay.aimux.app",
      lastConnectedAt: null,
    });
    expect(status.lastError).toContain("Node 22+");
  });

  it("turns relay client_connected security events into local notifications", async () => {
    const daemon = { routeRequest: vi.fn() } as unknown as AimuxDaemon;
    const client = new RelayClient("wss://relay.aimux.app/", "token", daemon);
    const message = JSON.stringify({
      type: "security_event",
      event: {
        kind: "client_connected",
        deviceId: "device-1",
        title: "Remote client connected",
        body: "iPhone from SG",
        createdAt: new Date().toISOString(),
      },
    });

    await (client as unknown as { handleMessage(data: string): Promise<void> }).handleMessage(message);

    expect(notifyRemoteClientConnected).toHaveBeenCalledWith({
      title: "Remote client connected",
      body: "iPhone from SG",
    });
  });

  it("dedupes repeated client_connected notifications for a bouncing remote client", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T00:00:00.000Z"));
    const daemon = { routeRequest: vi.fn() } as unknown as AimuxDaemon;
    const client = new RelayClient("wss://relay.aimux.app/", "token", daemon);
    const message = JSON.stringify({
      type: "security_event",
      event: {
        kind: "client_connected",
        deviceId: "device-1",
        title: "Remote client connected",
        body: "iPhone from SG",
        createdAt: new Date().toISOString(),
      },
    });

    await (client as unknown as { handleMessage(data: string): Promise<void> }).handleMessage(message);
    await (client as unknown as { handleMessage(data: string): Promise<void> }).handleMessage(message);

    expect(notifyRemoteClientConnected).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await (client as unknown as { handleMessage(data: string): Promise<void> }).handleMessage(message);

    expect(notifyRemoteClientConnected).toHaveBeenCalledTimes(2);
  });
});
