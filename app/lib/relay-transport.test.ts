import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {} }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "test" } } }));
vi.mock("expo-secure-store", () => ({}));

import { RelayTransport, type RelayStatus } from "@/lib/relay-transport";

class MockWebSocket {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(
    public url: string,
    public protocols: string[],
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

describe("RelayTransport remote security state", () => {
  it("stops reconnecting when the relay rejects auth or lockdown state", async () => {
    vi.useFakeTimers();
    const originalWebSocket = globalThis.WebSocket;
    const sockets: MockWebSocket[] = [];
    try {
      vi.stubGlobal(
        "WebSocket",
        class extends MockWebSocket {
          constructor(url: string, protocols: string[]) {
            super(url, protocols);
            sockets.push(this);
          }
        },
      );
      const statuses: RelayStatus[] = [];
      const transport = new RelayTransport(
        "wss://relay.example.test",
        async () => "token",
        async () => ({
          deviceId: "client_1",
          kind: "web",
          name: "Web browser",
          platform: "web",
        }),
      );
      transport.onStatusChange((status) => statuses.push(status));

      await transport.connect();
      expect(sockets).toHaveLength(1);
      sockets[0]!.onclose?.({ code: 4003 });
      await vi.advanceTimersByTimeAsync(30_000);

      expect(statuses).toContain("auth_failed");
      expect(sockets).toHaveLength(1);
    } finally {
      vi.stubGlobal("WebSocket", originalWebSocket);
      vi.useRealTimers();
    }
  });

  it("stops reconnecting after repeated failed WebSocket handshakes", async () => {
    vi.useFakeTimers();
    const originalWebSocket = globalThis.WebSocket;
    const sockets: MockWebSocket[] = [];
    try {
      vi.stubGlobal(
        "WebSocket",
        class extends MockWebSocket {
          constructor(url: string, protocols: string[]) {
            super(url, protocols);
            sockets.push(this);
            setTimeout(() => this.onclose?.({ code: 1006 }), 0);
          }
        },
      );
      const statuses: RelayStatus[] = [];
      const transport = new RelayTransport(
        "wss://relay.example.test",
        async () => "token",
        async () => ({
          deviceId: "client_1",
          kind: "web",
          name: "Web browser",
          platform: "web",
        }),
      );
      transport.onStatusChange((status) => statuses.push(status));

      await transport.connect();
      await vi.advanceTimersByTimeAsync(3_500);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(statuses).toContain("auth_failed");
      expect(sockets).toHaveLength(3);
    } finally {
      vi.stubGlobal("WebSocket", originalWebSocket);
      vi.useRealTimers();
    }
  });

  it("subscribes to project events over the relay socket", async () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: MockWebSocket[] = [];
    try {
      vi.stubGlobal(
        "WebSocket",
        class extends MockWebSocket {
          constructor(url: string, protocols: string[]) {
            super(url, protocols);
            sockets.push(this);
          }
        },
      );
      const transport = new RelayTransport(
        "wss://relay.example.test",
        async () => "token",
        async () => ({
          deviceId: "client_1",
          kind: "web",
          name: "Web browser",
          platform: "web",
        }),
      );

      await transport.connect();
      sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "daemon_status", online: true }) });
      const events: Array<{ event: string; data: unknown }> = [];
      const errors: Error[] = [];

      const handle = transport.subscribeProjectEvents(
        "/proxy/127.0.0.1/43210/events",
        { Authorization: "Bearer token" },
        (event, data) => events.push({ event, data }),
        (error) => errors.push(error),
      );
      const subscribe = JSON.parse(sockets[0]!.sent.at(-1)!) as { id: string; type: string };
      expect(subscribe).toMatchObject({
        type: "project_events_subscribe",
        path: "/proxy/127.0.0.1/43210/events",
        headers: { Authorization: "Bearer token" },
      });

      sockets[0]!.onmessage?.({
        data: JSON.stringify({
          id: subscribe.id,
          type: "project_event",
          event: "project_update",
          data: { views: ["coordination-worklist"] },
        }),
      });
      expect(events).toEqual([
        { event: "project_update", data: { views: ["coordination-worklist"] } },
      ]);

      handle.stop();
      expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toEqual({
        id: subscribe.id,
        type: "project_events_unsubscribe",
      });
      expect(errors).toEqual([]);
    } finally {
      vi.stubGlobal("WebSocket", originalWebSocket);
    }
  });

  it("drops relay project event subscriptions after stream errors", async () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: MockWebSocket[] = [];
    try {
      vi.stubGlobal(
        "WebSocket",
        class extends MockWebSocket {
          constructor(url: string, protocols: string[]) {
            super(url, protocols);
            sockets.push(this);
          }
        },
      );
      const transport = new RelayTransport(
        "wss://relay.example.test",
        async () => "token",
        async () => ({
          deviceId: "client_1",
          kind: "web",
          name: "Web browser",
          platform: "web",
        }),
      );

      await transport.connect();
      sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "daemon_status", online: true }) });
      const errors: string[] = [];
      transport.subscribeProjectEvents(
        "/proxy/127.0.0.1/43210/events",
        undefined,
        () => {},
        (error) => errors.push(error.message),
      );
      const subscribe = JSON.parse(sockets[0]!.sent.at(-1)!) as { id: string };
      sockets[0]!.onmessage?.({
        data: JSON.stringify({
          id: subscribe.id,
          type: "project_events_error",
          status: 502,
          message: "stream failed",
        }),
      });

      expect(errors).toEqual(["stream failed"]);
      sockets[0]!.onmessage?.({
        data: JSON.stringify({
          id: subscribe.id,
          type: "project_event",
          event: "project_update",
          data: {},
        }),
      });
      expect(errors).toEqual(["stream failed"]);
    } finally {
      vi.stubGlobal("WebSocket", originalWebSocket);
    }
  });
});
