import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {} }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "test" } } }));
vi.mock("expo-crypto", () => ({
  getRandomBytesAsync: vi.fn(async (byteLength: number) => new Uint8Array(byteLength)),
}));
vi.mock("expo-secure-store", () => ({}));

import { RelayTransport, type RelayStatus } from "@/lib/relay-transport";
import { ClientDeviceStorageError } from "@/lib/client-device";

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

const testProofOptions = {
  getDeviceProof: async () => ({
    alg: "ES256" as const,
    publicKeyJwk: {
      kty: "EC",
      crv: "P-256",
      x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      ext: true,
      key_ops: ["verify"],
    },
    timestamp: "2026-05-24T00:00:00.000Z",
    nonce: "nonce",
    signature: "signature",
  }),
};

describe("RelayTransport remote security state", () => {
  it("reports device storage failures instead of retrying as disconnected", async () => {
    vi.useFakeTimers();
    const originalWebSocket = globalThis.WebSocket;
    const sockets: MockWebSocket[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
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
        async () => {
          throw new ClientDeviceStorageError(
            "Client device storage read failed for device id: keychain denied",
          );
        },
        testProofOptions,
      );
      transport.onStatusChange((status) => statuses.push(status));

      await transport.connect();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(statuses).toEqual(["connecting", "client_storage_error"]);
      expect(sockets).toHaveLength(0);
      expect(error).toHaveBeenCalledWith(
        "relay client device storage failed:",
        expect.objectContaining({
          message: "Client device storage read failed for device id: keychain denied",
        }),
      );
    } finally {
      error.mockRestore();
      vi.stubGlobal("WebSocket", originalWebSocket);
      vi.useRealTimers();
    }
  });

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
        testProofOptions,
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

  it("keeps reconnecting after repeated generic WebSocket handshake failures", async () => {
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
        testProofOptions,
      );
      transport.onStatusChange((status) => statuses.push(status));

      await transport.connect();
      await vi.advanceTimersByTimeAsync(3_500);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(statuses).not.toContain("auth_failed");
      expect(statuses).toContain("relay_unavailable");
      expect(sockets.length).toBeGreaterThan(3);
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
        testProofOptions,
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

  it("surfaces pending device approval and recovers when this device is approved", async () => {
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
      const pendingApprovals: Array<{ deviceId?: string; approvalCode?: string } | null> = [];
      const transport = new RelayTransport(
        "wss://relay.example.test",
        async () => "token",
        async () => ({
          deviceId: "client_1",
          kind: "ios",
          name: "iPhone",
          platform: "ios",
        }),
        testProofOptions,
      );
      transport.onStatusChange((status) => statuses.push(status));
      transport.onPendingApprovalChange((approval) => pendingApprovals.push(approval));

      await transport.connect();
      sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "daemon_status", online: true }) });
      const request = transport.request("GET", "/projects");
      const sent = JSON.parse(sockets[0]!.sent.at(-1)!) as { id: string };
      sockets[0]!.onmessage?.({
        data: JSON.stringify({
          id: sent.id,
          type: "response",
          status: 403,
          body: {
            ok: false,
            error: "Remote client pending security approval. Code QTE-WK4.",
            deviceId: "client_1",
            approvalCode: "QTE-WK4",
          },
        }),
      });
      await request;

      expect(statuses).toContain("device_pending");
      expect(pendingApprovals).toContainEqual({ deviceId: "client_1", approvalCode: "QTE-WK4" });

      sockets[0]!.onmessage?.({
        data: JSON.stringify({
          type: "security_event",
          event: {
            id: "event_1",
            kind: "device_approved",
            deviceId: "client_1",
            title: "Remote device approved",
            body: "iPhone approved.",
            createdAt: "2026-05-24T00:00:00.000Z",
          },
        }),
      });

      expect(statuses.at(-1)).toBe("connected");
      expect(pendingApprovals.at(-1)).toBeNull();
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
        testProofOptions,
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

  it("includes a signed device proof in the client connection URL", async () => {
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
          approvalCode: "QTE-WK4",
        }),
        testProofOptions,
      );

      await transport.connect();

      const url = new URL(sockets[0]!.url);
      expect(url.searchParams.get("deviceKeyAlg")).toBe("ES256");
      expect(url.searchParams.get("deviceProofTs")).toBe("2026-05-24T00:00:00.000Z");
      expect(url.searchParams.get("deviceProofNonce")).toBe("nonce");
      expect(url.searchParams.get("deviceProof")).toBe("signature");
      expect(url.searchParams.get("approvalCode")).toBe("QTE-WK4");
      const publicKey = JSON.parse(
        base64UrlDecodeToText(url.searchParams.get("devicePublicKey")!),
      ) as JsonWebKey;
      expect(publicKey).toMatchObject({ kty: "EC", crv: "P-256" });
    } finally {
      vi.stubGlobal("WebSocket", originalWebSocket);
    }
  });
});

function base64UrlDecodeToText(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return atob(padded);
}

describe("RelayTransport machines", () => {
  async function connectedTransport() {
    const sockets: MockWebSocket[] = [];
    const originalWebSocket = globalThis.WebSocket;
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
      async () => ({ deviceId: "client_1", kind: "web", name: "Web browser", platform: "web" }),
      testProofOptions,
    );
    await transport.connect();
    return {
      transport,
      sockets,
      restore: () => vi.stubGlobal("WebSocket", originalWebSocket),
    };
  }

  it("learns the fleet from daemon_status and reports changes", async () => {
    const { transport, sockets, restore } = await connectedTransport();
    const seen: string[][] = [];
    transport.onMachinesChange((machines) => seen.push(machines.map((machine) => machine.id)));

    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: "daemon_status",
        online: true,
        machines: [
          { id: "mbp", name: "sam-mbp" },
          { id: "strix", name: "sam-strix" },
        ],
      }),
    });

    expect(transport.machines).toEqual([
      { id: "mbp", name: "sam-mbp" },
      { id: "strix", name: "sam-strix" },
    ]);
    expect(seen).toEqual([["mbp", "strix"]]);

    // Same list again is not a change.
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: "daemon_status",
        online: true,
        machines: [
          { id: "mbp", name: "sam-mbp" },
          { id: "strix", name: "sam-strix" },
        ],
      }),
    });
    expect(seen).toHaveLength(1);
    restore();
  });

  // A shared guest is told nothing about the fleet, and an older relay says
  // nothing either. Neither is a claim that there are zero machines.
  it("treats a daemon_status without machines as unknown, not empty", async () => {
    const { transport, sockets, restore } = await connectedTransport();
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: "daemon_status",
        online: true,
        machines: [{ id: "mbp", name: "sam-mbp" }],
      }),
    });
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "daemon_status", online: true }) });
    expect(transport.machines).toEqual([{ id: "mbp", name: "sam-mbp" }]);

    // An explicit empty list is an answer, and clears it.
    sockets[0]!.onmessage?.({
      data: JSON.stringify({ type: "daemon_status", online: false, machines: [] }),
    });
    expect(transport.machines).toEqual([]);
    restore();
  });

  // A caller that must NAME a machine cannot send none: the relay refuses
  // that once the account has several. So the last answer survives the blip
  // even though the display list does not.
  it("keeps the last named fleet across a closed socket", async () => {
    vi.useFakeTimers();
    const { transport, sockets, restore } = await connectedTransport();
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: "daemon_status",
        online: true,
        machines: [{ id: "mbp", name: "sam-mbp" }],
      }),
    });
    sockets[0]!.close(1006);

    expect(transport.machines).toEqual([]);
    expect(transport.namedMachines).toEqual([{ id: "mbp", name: "sam-mbp" }]);

    transport.disconnect();
    expect(transport.namedMachines).toEqual([]);
    vi.useRealTimers();
    restore();
  });

  it("forgets the fleet when the socket closes", async () => {
    vi.useFakeTimers();
    const { transport, sockets, restore } = await connectedTransport();
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: "daemon_status",
        online: true,
        machines: [{ id: "mbp", name: "sam-mbp" }],
      }),
    });
    sockets[0]!.close(1006);
    expect(transport.machines).toEqual([]);
    transport.disconnect();
    vi.useRealTimers();
    restore();
  });

  it("drops a machine entry it cannot read", async () => {
    const { transport, sockets, restore } = await connectedTransport();
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: "daemon_status",
        online: true,
        machines: [
          null,
          "mbp",
          { name: "no id" },
          { id: "" },
          { id: "strix" },
          { id: "mbp", name: 7 },
        ],
      }),
    });
    expect(transport.machines).toEqual([
      { id: "strix", name: "strix" },
      { id: "mbp", name: "mbp" },
    ]);
    restore();
  });

  it("forgets the fleet when the transport is shut down", async () => {
    vi.useFakeTimers();
    const { transport, sockets, restore } = await connectedTransport();
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: "daemon_status",
        online: true,
        machines: [{ id: "mbp", name: "sam-mbp" }],
      }),
    });
    transport.disconnect();
    expect(transport.machines).toEqual([]);
    vi.useRealTimers();
    restore();
  });

  it("names the machine on a request only when one was chosen", async () => {
    const { transport, sockets, restore } = await connectedTransport();
    sockets[0]!.onmessage?.({
      data: JSON.stringify({
        type: "daemon_status",
        online: true,
        machines: [{ id: "strix", name: "sam-strix" }],
      }),
    });

    void transport.request("GET", "/projects", undefined, "strix");
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({
      type: "request",
      path: "/projects",
      machineId: "strix",
    });

    void transport.request("GET", "/projects");
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).not.toHaveProperty("machineId");

    transport.subscribeProjectEvents(
      "/proxy/127.0.0.1/43210/events",
      undefined,
      () => {},
      () => {},
      "strix",
    );
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({
      type: "project_events_subscribe",
      machineId: "strix",
    });
    restore();
  });
});
