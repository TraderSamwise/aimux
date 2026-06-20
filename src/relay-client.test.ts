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
    expect(status.lastError).toContain("Node 24+");
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

  it("proxies project service SSE events over relay subscriptions", async () => {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const sent: string[] = [];
    try {
      vi.stubGlobal("WebSocket", { OPEN: 1 });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'event: project_update\ndata: {"type":"project_update","views":["desktop-state"],"projectId":"p1","ts":"now"}\n\n',
                ),
              );
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }),
      );
      const daemon = {
        routeRequest: vi.fn(),
        resolveProjectEventStream: vi.fn(() => ({
          ok: true,
          url: "http://127.0.0.1:4321/events",
        })),
      } as unknown as AimuxDaemon;
      const client = new RelayClient("wss://relay.aimux.app/", "token", daemon);
      (client as unknown as { ws: { readyState: number; send: (data: string) => void } | null }).ws = {
        readyState: 1,
        send: (data: string) => sent.push(data),
      };

      await (client as unknown as { handleMessage(data: string): Promise<void> }).handleMessage(
        JSON.stringify({
          id: "sub-1",
          type: "project_events_subscribe",
          path: "/proxy/127.0.0.1/4321/events",
        }),
      );
      await vi.waitFor(() => {
        expect(sent.some((data) => data.includes('"type":"project_event"'))).toBe(true);
      });

      expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4321/events", expect.objectContaining({ method: "GET" }));
      expect(sent.map((data) => JSON.parse(data) as { type: string })).toEqual([
        { id: "sub-1", type: "project_events_subscribed" },
        {
          id: "sub-1",
          type: "project_event",
          event: "project_update",
          data: {
            type: "project_update",
            views: ["desktop-state"],
            projectId: "p1",
            ts: "now",
          },
        },
        {
          id: "sub-1",
          type: "project_events_error",
          status: 502,
          message: "Project event stream closed",
        },
      ]);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
      vi.stubGlobal("WebSocket", originalWebSocket);
    }
  });

  it("rejects shared guest project event subscriptions without the authorized session id", async () => {
    const originalWebSocket = globalThis.WebSocket;
    const sent: string[] = [];
    try {
      vi.stubGlobal("WebSocket", { OPEN: 1 });
      const daemon = {
        routeRequest: vi.fn(),
        resolveProjectEventStream: vi.fn(() => ({
          ok: false,
          status: 403,
          error: "shared session route requires a session id",
        })),
      } as unknown as AimuxDaemon;
      const client = new RelayClient("wss://relay.aimux.app/", "token", daemon);
      (client as unknown as { ws: { readyState: number; send: (data: string) => void } | null }).ws = {
        readyState: 1,
        send: (data: string) => sent.push(data),
      };

      await (client as unknown as { handleMessage(data: string): Promise<void> }).handleMessage(
        JSON.stringify({
          id: "sub-guest",
          type: "project_events_subscribe",
          path: "/proxy/127.0.0.1/4321/events",
          headers: {
            "X-Aimux-Actor-Role": "guest",
            "X-Aimux-Share-Session-Id": "shared-1",
          },
        }),
      );

      expect(sent.map((data) => JSON.parse(data) as { type: string; status: number })).toEqual([
        {
          id: "sub-guest",
          type: "project_events_error",
          status: 403,
          message: "shared session route requires a session id",
        },
      ]);
    } finally {
      vi.stubGlobal("WebSocket", originalWebSocket);
    }
  });
});
