import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MACHINES_PER_ROOM } from "./machines";
import { RelayObject } from "./relay-object";
import { deviceProofMessage } from "./security";
import type { Env } from "./types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject<Env> {
    protected ctx: DurableObjectState;
    protected env: Env;

    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

class MemoryStorage {
  private values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  setAlarm = vi.fn(async (_time: number) => undefined);
}

class FakeR2Bucket {
  objects = new Map<string, { body: Uint8Array; customMetadata?: Record<string, string> }>();

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { customMetadata?: Record<string, string> },
  ) {
    const body =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, { body, customMetadata: options?.customMetadata });
    return null;
  }

  async get(key: string) {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

describe("RelayObject request hibernation", () => {
  it("delivers a daemon response after pending request state is rebuilt from the client socket", async () => {
    const daemonSocket = fakeSocket(["daemon", "user:user_owner"]);
    const clientSocket = fakeSocket(["client", "device:client_1"]);
    const storage = storageWithSockets([daemonSocket, clientSocket]);
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(
      clientSocket,
      JSON.stringify({ id: "client-req-1", type: "request", method: "GET", path: "/projects" }),
    );
    const daemonRequest = JSON.parse(String(daemonSocket.send.mock.calls.at(-1)?.[0])) as {
      id: string;
      type: string;
    };
    expect(daemonRequest).toMatchObject({ type: "request" });

    const hibernatedObject = createObject(storage, {} as unknown as Env);
    await hibernatedObject.webSocketMessage(
      daemonSocket,
      JSON.stringify({
        id: daemonRequest.id,
        type: "response",
        status: 200,
        body: {
          ok: true,
          projects: [
            { id: "aimux", serviceAlive: true },
            { id: "cold", serviceAlive: false },
          ],
        },
      }),
    );

    expect(clientSocket.send).toHaveBeenCalledWith(
      JSON.stringify({
        id: "client-req-1",
        type: "response",
        status: 200,
        body: {
          ok: true,
          projects: [
            { id: "aimux", serviceAlive: true },
            { id: "cold", serviceAlive: false },
          ],
        },
      }),
    );
  });

  it("sweeps expired daemon requests after pending request state is rebuilt from the client socket", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
      const daemonSocket = fakeSocket(["daemon", "user:user_owner"]);
      const clientSocket = fakeSocket(["client", "device:client_1"]);
      const storage = storageWithSockets([daemonSocket, clientSocket]);
      const object = createObject(storage, {} as unknown as Env);

      await object.webSocketMessage(
        clientSocket,
        JSON.stringify({ id: "client-req-2", type: "request", method: "POST", path: "/agents/input" }),
      );
      vi.setSystemTime(new Date("2026-09-12T00:01:01.000Z"));

      const hibernatedObject = createObject(storage, {} as unknown as Env);
      await hibernatedObject.alarm();

      expect(clientSocket.send).toHaveBeenCalledWith(
        JSON.stringify({
          id: "client-req-2",
          type: "response",
          status: 504,
          body: { ok: false, error: "Daemon did not respond in time" },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a daemon response with no recoverable request mapping instead of dropping it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const daemonSocket = fakeSocket(["daemon", "user:user_owner"]);
      const object = createObject(storageWithSockets([daemonSocket]), {} as unknown as Env);

      await object.webSocketMessage(
        daemonSocket,
        JSON.stringify({ id: "missing-request", type: "response", status: 200, body: { ok: true } }),
      );

      const message = "No pending relay request for daemon response id missing-request";
      expect(warn).toHaveBeenCalledWith(message);
      expect(daemonSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "error", message }));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("RelayObject sharing index repair", () => {
  let storage: MemoryStorage;
  let receiverFetch: ReturnType<typeof vi.fn>;
  let env: Env;

  beforeEach(() => {
    vi.stubGlobal(
      "WebSocketPair",
      class TestWebSocketPair {
        0 = fakeSocket([]);
        1 = fakeSocket([]);
      },
    );
    storage = new MemoryStorage();
    receiverFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    env = {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: receiverFetch })),
      },
    } as unknown as Env;
  });

  it("fails invite acceptance when the receiver accepted-share index cannot be written", async () => {
    const object = createObject(storage, env);
    const invite = await createInvite(object);
    receiverFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "broken" }), { status: 500 }));

    const response = await object.fetch(
      request(`https://relay.aimux.app/shares/invite/user_owner/${invite.token}/accept`, {
        method: "POST",
        userId: "user_guest",
        name: "Guest",
        email: "guest@example.com",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "Accepted share index upsert failed with 500",
    });
  });

  it("repairs the receiver accepted-share index from an owner-scoped share read", async () => {
    const object = createObject(storage, env);
    const invite = await createInvite(object);
    const accepted = await object.fetch(
      request(`https://relay.aimux.app/shares/invite/user_owner/${invite.token}/accept`, {
        method: "POST",
        userId: "user_guest",
        name: "Guest",
        email: "guest@example.com",
      }),
    );
    const acceptedBody = (await accepted.json()) as { share: { id: string } };
    receiverFetch.mockClear();

    const response = await object.fetch(
      request(`https://relay.aimux.app/shares/user_owner/${acceptedBody.share.id}`, {
        method: "GET",
        userId: "user_guest",
        name: "Guest",
        email: "guest@example.com",
      }),
    );

    expect(response.status).toBe(200);
    expect(receiverFetch).toHaveBeenCalledTimes(1);
    const [repairUrl, repairInit] = receiverFetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(repairUrl).pathname).toBe("/internal/accepted-shares/upsert");
    const repairBody = JSON.parse(String(repairInit.body)) as {
      share: { id: string; ownerUserId: string };
    };
    expect(repairBody.share).toMatchObject({
      id: acceptedBody.share.id,
      ownerUserId: "user_owner",
    });
  });
});

describe("RelayObject hosted attachments", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "WebSocketPair",
      class TestWebSocketPair {
        0 = fakeSocket([]);
        1 = fakeSocket([]);
      },
    );
  });

  it("adds a hosted attachment pointer to allowed shared uploads", async () => {
    const storage = new MemoryStorage();
    const bucket = new FakeR2Bucket();
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) })),
      },
      ATTACHMENTS: bucket as unknown as R2Bucket,
    } as unknown as Env);
    const shareId = await createAcceptedShareInOwnerObject(object);
    const ws = fakeSocket([`share:${shareId}`, "user:user_guest"]);

    const result = await (
      object as unknown as {
        prepareClientRequest: (
          ws: WebSocket,
          request: {
            id: string;
            type: "request";
            method: string;
            path: string;
            body?: unknown;
          },
        ) => Promise<{ ok: true; requestPatch?: { body?: unknown } } | { ok: false; error: string }>;
      }
    ).prepareClientRequest(ws, {
      id: "req_1",
      type: "request",
      method: "POST",
      path: "/proxy/127.0.0.1/43192/attachments",
      body: {
        filename: "screen.png",
        mimeType: "image/png",
        dataBase64: btoa("png-bytes"),
        sessionId: "claude-k4lihz",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.requestPatch?.body : null).toMatchObject({
      hostedAttachment: {
        contentUrl: expect.stringMatching(
          /^https:\/\/relay\.aimux\.app\/attachments\/hosted\/ha_[A-Za-z0-9_-]{43}\/content$/,
        ),
        expiresAt: expect.any(String),
        sha256: "ea80334363eed145dfeee51ebae7dc3f1cd7d0c7879f8bfd2070c061d3c33f56",
        sizeBytes: 9,
      },
    });
    expect(bucket.objects.size).toBe(1);
  });

  it("replaces client-supplied hosted attachment pointers on shared uploads", async () => {
    const storage = new MemoryStorage();
    const bucket = new FakeR2Bucket();
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) })),
      },
      ATTACHMENTS: bucket as unknown as R2Bucket,
    } as unknown as Env);
    const shareId = await createAcceptedShareInOwnerObject(object);
    const ws = fakeSocket([`share:${shareId}`, "user:user_guest"]);

    const result = await (
      object as unknown as {
        prepareClientRequest: (
          ws: WebSocket,
          request: {
            id: string;
            type: "request";
            method: string;
            path: string;
            body?: unknown;
          },
        ) => Promise<{ ok: true; requestPatch?: { body?: unknown } } | { ok: false; error: string }>;
      }
    ).prepareClientRequest(ws, {
      id: "req_1",
      type: "request",
      method: "POST",
      path: "/proxy/127.0.0.1/43192/attachments",
      body: {
        filename: "screen.png",
        mimeType: "image/png",
        dataBase64: btoa("png-bytes"),
        sessionId: "claude-k4lihz",
        hostedAttachment: {
          contentUrl: "https://attacker.example.test/screen.png",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    });

    const body = result.ok ? (result.requestPatch?.body as { hostedAttachment?: { contentUrl?: string } }) : null;
    expect(result.ok).toBe(true);
    expect(body).toMatchObject({
      hostedAttachment: {
        contentUrl: expect.stringMatching(/^https:\/\/relay\.aimux\.app\/attachments\/hosted\/ha_/),
      },
    });
    expect(body?.hostedAttachment?.contentUrl).not.toBe("https://attacker.example.test/screen.png");
    expect(bucket.objects.size).toBe(1);
  });

  it("adds a hosted attachment pointer to owner uploads when storage is available", async () => {
    const storage = new MemoryStorage();
    const bucket = new FakeR2Bucket();
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) })),
      },
      ATTACHMENTS: bucket as unknown as R2Bucket,
    } as unknown as Env);
    const ws = fakeSocket(["client", "device:client_phone"]);

    const result = await (
      object as unknown as {
        prepareClientRequest: (
          ws: WebSocket,
          request: {
            id: string;
            type: "request";
            method: string;
            path: string;
            body?: unknown;
          },
        ) => Promise<{ ok: true; requestPatch?: { body?: unknown } } | { ok: false; error: string }>;
      }
    ).prepareClientRequest(ws, {
      id: "req_1",
      type: "request",
      method: "POST",
      path: "/proxy/127.0.0.1/43192/attachments",
      body: {
        filename: "screen.png",
        mimeType: "image/png",
        dataBase64: btoa("png-bytes"),
        sessionId: "claude-k4lihz",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.requestPatch?.body : null).toMatchObject({
      hostedAttachment: {
        contentUrl: expect.stringMatching(
          /^https:\/\/relay\.aimux\.app\/attachments\/hosted\/ha_[A-Za-z0-9_-]{43}\/content$/,
        ),
        expiresAt: expect.any(String),
        sha256: "ea80334363eed145dfeee51ebae7dc3f1cd7d0c7879f8bfd2070c061d3c33f56",
        sizeBytes: 9,
      },
    });
    expect(bucket.objects.size).toBe(1);
  });

  it("lets owner uploads continue when hosted storage is unavailable", async () => {
    const object = createObject(new MemoryStorage(), {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) })),
      },
    } as unknown as Env);
    const ws = fakeSocket(["client", "device:client_phone"]);

    const result = await (
      object as unknown as {
        prepareClientRequest: (
          ws: WebSocket,
          request: {
            id: string;
            type: "request";
            method: string;
            path: string;
            body?: unknown;
          },
        ) => Promise<{ ok: true; requestPatch?: { body?: unknown } } | { ok: false; error: string }>;
      }
    ).prepareClientRequest(ws, {
      id: "req_1",
      type: "request",
      method: "POST",
      path: "/proxy/127.0.0.1/43192/attachments",
      body: {
        filename: "screen.png",
        mimeType: "image/png",
        dataBase64: btoa("png-bytes"),
        sessionId: "claude-k4lihz",
        hostedAttachment: {
          contentUrl: "https://stale.example.test/screen.png",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      requestPatch: {
        headers: { "X-Aimux-Actor-Role": "owner" },
        body: {
          filename: "screen.png",
          mimeType: "image/png",
          dataBase64: btoa("png-bytes"),
          sessionId: "claude-k4lihz",
        },
      },
    });
  });

  it("lets owner uploads continue when hosted storage writes fail", async () => {
    const bucket = new FakeR2Bucket();
    vi.spyOn(bucket, "put").mockRejectedValueOnce(new Error("r2 unavailable"));
    const object = createObject(new MemoryStorage(), {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) })),
      },
      ATTACHMENTS: bucket as unknown as R2Bucket,
    } as unknown as Env);
    const ws = fakeSocket(["client", "device:client_phone"]);

    const result = await (
      object as unknown as {
        prepareClientRequest: (
          ws: WebSocket,
          request: {
            id: string;
            type: "request";
            method: string;
            path: string;
            body?: unknown;
          },
        ) => Promise<{ ok: true; requestPatch?: { body?: unknown } } | { ok: false; error: string }>;
      }
    ).prepareClientRequest(ws, {
      id: "req_1",
      type: "request",
      method: "POST",
      path: "/proxy/127.0.0.1/43192/attachments",
      body: {
        filename: "screen.png",
        mimeType: "image/png",
        dataBase64: btoa("png-bytes"),
        sessionId: "claude-k4lihz",
        hostedAttachment: {
          contentUrl: "https://stale.example.test/screen.png",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      requestPatch: {
        headers: { "X-Aimux-Actor-Role": "owner" },
        body: {
          filename: "screen.png",
          mimeType: "image/png",
          dataBase64: btoa("png-bytes"),
          sessionId: "claude-k4lihz",
        },
      },
    });
  });

  it("fails shared uploads closed when hosted storage is unavailable", async () => {
    const storage = new MemoryStorage();
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) })),
      },
    } as unknown as Env);
    const shareId = await createAcceptedShareInOwnerObject(object);
    const ws = fakeSocket([`share:${shareId}`, "user:user_guest"]);

    const result = await (
      object as unknown as {
        prepareClientRequest: (
          ws: WebSocket,
          request: {
            id: string;
            type: "request";
            method: string;
            path: string;
            body?: unknown;
          },
        ) => Promise<{ ok: true } | { ok: false; status: number; error: string }>;
      }
    ).prepareClientRequest(ws, {
      id: "req_1",
      type: "request",
      method: "POST",
      path: "/proxy/127.0.0.1/43192/attachments",
      body: {
        filename: "screen.png",
        mimeType: "image/png",
        dataBase64: btoa("png-bytes"),
        sessionId: "claude-k4lihz",
      },
    });

    expect(result).toMatchObject({ ok: false, status: 503, error: "Hosted attachments are not configured" });
  });
});

describe("RelayObject shared security delivery", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "WebSocketPair",
      class TestWebSocketPair {
        0 = fakeSocket([]);
        1 = fakeSocket([]);
      },
    );
  });

  it("sends shared participant connection events to owner sockets, not sharee sockets", async () => {
    const storage = storageWithSockets([]);
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response("{}", { status: 200 })) })),
      },
    } as unknown as Env);
    const shareId = await createAcceptedShareInOwnerObject(object);
    const ownerSocket = fakeSocket(["client", `share:${shareId}`, "user:user_owner"]);
    const shareeSocket = fakeSocket(["client", `share:${shareId}`, "user:user_guest"]);
    const normalOwnerSocket = fakeSocket(["client", "user:user_owner"]);
    storage.sockets = [ownerSocket, shareeSocket, normalOwnerSocket];

    const response = await object
      .fetch(
        new Request(`https://relay.aimux.app/client/connect?deviceId=guest-browser&shareId=${shareId}`, {
          headers: {
            Upgrade: "websocket",
            "X-Aimux-Share-Owner-Id": "user_owner",
            "X-Aimux-User-Id": "user_guest",
          },
        }),
      )
      .catch((error) => error);

    expect(response).toBeInstanceOf(RangeError);
    expect(ownerSocket.send).toHaveBeenCalledWith(expect.stringContaining("shared_client_connected"));
    expect(normalOwnerSocket.send).toHaveBeenCalledWith(expect.stringContaining("shared_client_connected"));
    expect(shareeSocket.send).not.toHaveBeenCalled();
  });

  it("does not create emergency lockdown actions for shared participant connections", async () => {
    const storage = storageWithSockets([]);
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response("{}", { status: 200 })) })),
      },
    } as unknown as Env);

    const shareId = await createAcceptedShareInOwnerObject(object);
    const before = await storage.get<{ actions: Record<string, unknown> }>("security-state:v1");
    const response = await object
      .fetch(
        new Request(`https://relay.aimux.app/client/connect?deviceId=guest-browser&shareId=${shareId}`, {
          headers: {
            Upgrade: "websocket",
            "X-Aimux-Share-Owner-Id": "user_owner",
            "X-Aimux-User-Id": "user_guest",
          },
        }),
      )
      .catch((error) => error);

    expect(response).toBeInstanceOf(RangeError);
    const security = await storage.get<{ actions: Record<string, unknown> }>("security-state:v1");
    expect(Object.keys(security?.actions ?? {})).toEqual(Object.keys(before?.actions ?? {}));
  });
});

describe("RelayObject owner device security", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "WebSocketPair",
      class TestWebSocketPair {
        0 = fakeSocket([]);
        1 = fakeSocket([]);
      },
    );
  });

  it("lists, approves, blocks, and unblocks owner devices", async () => {
    const storage = storageWithSockets([]);
    const object = createObject(storage, {
      SECURITY_DEVICE_POLICY: "enforce",
    } as unknown as Env);

    await object
      .fetch(
        new Request(
          "https://relay.aimux.app/client/connect?deviceId=client_1&deviceKind=ios&deviceName=iPhone&approvalCode=QTE-WK4",
          {
            headers: { Upgrade: "websocket", "X-Aimux-User-Id": "user_owner" },
          },
        ),
      )
      .catch((error) => error);
    await object
      .fetch(
        new Request("https://relay.aimux.app/client/connect?deviceId=guest-browser&shareId=share_1&deviceName=Guest", {
          headers: { Upgrade: "websocket", "X-Aimux-User-Id": "user_guest", "X-Aimux-Share-Owner-Id": "user_owner" },
        }),
      )
      .catch(() => undefined);

    const listed = await object.fetch(new Request("https://relay.aimux.app/security/devices"));
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { devices: Array<{ id: string; approved: boolean }> };
    expect(listedBody.devices).toEqual([expect.objectContaining({ id: "client_1", approved: false })]);

    const pending = await object.fetch(new Request("https://relay.aimux.app/security/devices/pending"));
    expect(pending.status).toBe(200);
    const pendingBody = (await pending.json()) as { devices: Array<{ id: string; approvalCode?: string }> };
    expect(pendingBody.devices).toEqual([
      expect.objectContaining({
        id: "client_1",
      }),
    ]);
    expect(pendingBody.devices[0]?.approvalCode).toBeUndefined();

    const rejected = await object.fetch(
      new Request("https://relay.aimux.app/security/devices/client_1/approve", {
        method: "POST",
        body: JSON.stringify({ approvalCode: "BAD-BAD" }),
      }),
    );
    expect(rejected.status).toBe(403);

    const approved = await object.fetch(
      new Request("https://relay.aimux.app/security/devices/client_1/approve", {
        method: "POST",
        body: JSON.stringify({ approvalCode: "QTE-WK4" }),
      }),
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ device: { id: "client_1", approved: true, blocked: false } });

    const blocked = await object.fetch(
      new Request("https://relay.aimux.app/security/devices/client_1/block", { method: "POST" }),
    );
    expect(blocked.status).toBe(200);
    expect(await blocked.json()).toMatchObject({ device: { id: "client_1", approved: false, blocked: true } });

    const unblocked = await object.fetch(
      new Request("https://relay.aimux.app/security/devices/client_1/unblock", { method: "POST" }),
    );
    expect(unblocked.status).toBe(200);
    expect(await unblocked.json()).toMatchObject({ device: { id: "client_1", approved: false, blocked: false } });
  });

  it("uses approved-device policy for test push delivery", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const storage = storageWithSockets([]);
    const securityState = {
      version: 1,
      devices: {
        client_1: {
          id: "client_1",
          deviceId: "client_1",
          kind: "ios",
          name: "iPhone",
          firstSeenAt: "2026-05-24T00:00:00.000Z",
          lastSeenAt: "2026-05-24T00:00:00.000Z",
          approvalCode: "QTE-WK4",
        },
      },
      pushTokens: {
        "user_owner:client_1": {
          userId: "user_owner",
          deviceId: "client_1",
          token: "ExponentPushToken[owner-ios]",
          platform: "ios",
          agentAlerts: true,
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
      },
      actions: {},
      proofNonces: {},
      events: [],
    };
    await storage.put("security-state:v1", securityState);
    const object = createObject(storage, { SECURITY_DEVICE_POLICY: "enforce" } as unknown as Env);

    const rejected = await object.fetch(
      new Request("https://relay.aimux.app/security/test-push", {
        method: "POST",
        headers: { "X-Aimux-User-Id": "user_owner" },
      }),
    );

    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toMatchObject({
      ok: false,
      error: "No enabled approved mobile push token registered",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await storage.put("security-state:v1", {
      ...securityState,
      devices: {
        ...securityState.devices,
        client_1: {
          ...securityState.devices.client_1,
          approvedAt: "2026-05-24T00:01:00.000Z",
        },
      },
    });
    const sent = await object.fetch(
      new Request("https://relay.aimux.app/security/test-push", {
        method: "POST",
        headers: { "X-Aimux-User-Id": "user_owner" },
      }),
    );

    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ ok: true, sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports Expo delivery errors for test push instead of returning a raw worker 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ status: "error", message: "DeviceNotRegistered" }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const storage = storageWithSockets([]);
    await storage.put("security-state:v1", {
      version: 1,
      devices: {
        client_1: {
          id: "client_1",
          deviceId: "client_1",
          kind: "ios",
          name: "iPhone",
          firstSeenAt: "2026-05-24T00:00:00.000Z",
          lastSeenAt: "2026-05-24T00:00:00.000Z",
          approvedAt: "2026-05-24T00:01:00.000Z",
        },
      },
      pushTokens: {
        "user_owner:client_1": {
          userId: "user_owner",
          deviceId: "client_1",
          token: "ExponentPushToken[stale]",
          platform: "ios",
          agentAlerts: true,
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
      },
      actions: {},
      proofNonces: {},
      events: [],
    });
    const object = createObject(storage, { SECURITY_DEVICE_POLICY: "enforce" } as unknown as Env);

    const response = await object.fetch(
      new Request("https://relay.aimux.app/security/test-push", {
        method: "POST",
        headers: { "X-Aimux-User-Id": "user_owner" },
      }),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "Expo push rejected a token: DeviceNotRegistered",
    });
  });

  it("delivers every repeated test push to Expo", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const storage = storageWithSockets([]);
    await storage.put("security-state:v1", {
      version: 1,
      devices: {
        client_1: {
          id: "client_1",
          deviceId: "client_1",
          kind: "ios",
          name: "iPhone",
          firstSeenAt: "2026-05-24T00:00:00.000Z",
          lastSeenAt: "2026-05-24T00:00:00.000Z",
          approvedAt: "2026-05-24T00:01:00.000Z",
        },
      },
      pushTokens: {
        "user_owner:client_1": {
          userId: "user_owner",
          deviceId: "client_1",
          token: "ExponentPushToken[owner-ios]",
          platform: "ios",
          agentAlerts: true,
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
      },
      actions: {},
      proofNonces: {},
      events: [],
    });
    const object = createObject(storage, { SECURITY_DEVICE_POLICY: "enforce" } as unknown as Env);

    for (let i = 0; i < 6; i += 1) {
      const response = await object.fetch(
        new Request("https://relay.aimux.app/security/test-push", {
          method: "POST",
          headers: { "X-Aimux-User-Id": "user_owner" },
        }),
      );
      expect(response.status).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("delivers every daemon-originated mobile push to Expo", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const daemonSocket = fakeSocket(["daemon", "user:user_owner"]);
    const storage = storageWithSockets([daemonSocket]);
    await storage.put("security-state:v1", {
      version: 1,
      devices: {
        client_1: {
          id: "client_1",
          deviceId: "client_1",
          kind: "ios",
          name: "iPhone",
          firstSeenAt: "2026-05-24T00:00:00.000Z",
          lastSeenAt: "2026-05-24T00:00:00.000Z",
          approvedAt: "2026-05-24T00:01:00.000Z",
        },
      },
      pushTokens: {
        "user_owner:client_1": {
          userId: "user_owner",
          deviceId: "client_1",
          token: "ExponentPushToken[owner-ios]",
          platform: "ios",
          agentAlerts: true,
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
      },
      actions: {},
      proofNonces: {},
      events: [],
    });
    const object = createObject(storage, { SECURITY_DEVICE_POLICY: "enforce" } as unknown as Env);
    const message = JSON.stringify({
      type: "notification_push",
      notification: {
        title: "Agent needs input",
        body: "claude-1 is waiting",
        kind: "needs_input",
        sessionId: "claude-1",
        dedupeKey: "needs_input:claude-1",
      },
    });

    await object.webSocketMessage(daemonSocket, message);
    await object.webSocketMessage(daemonSocket, message);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tests shared mobile pushes against the owner delivery path", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const storage = storageWithSockets([]);
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response("{}", { status: 200 })) })),
      },
    } as unknown as Env);
    const shareId = await createAcceptedShareInOwnerObject(object);
    await storage.put("security-state:v1", {
      version: 1,
      devices: {
        owner_phone: {
          id: "owner_phone",
          deviceId: "owner_phone",
          kind: "ios",
          firstSeenAt: "2026-05-24T00:00:00.000Z",
          lastSeenAt: "2026-05-24T00:00:00.000Z",
        },
        guest_phone: {
          id: "guest_phone",
          deviceId: "guest_phone",
          kind: "ios",
          firstSeenAt: "2026-05-24T00:00:00.000Z",
          lastSeenAt: "2026-05-24T00:00:00.000Z",
        },
      },
      pushTokens: {
        "user_owner:owner_phone": {
          userId: "user_owner",
          deviceId: "owner_phone",
          token: "ExponentPushToken[owner-ios]",
          platform: "ios",
          agentAlerts: true,
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
        "user_guest:guest_phone": {
          userId: "user_guest",
          deviceId: "guest_phone",
          token: "ExponentPushToken[guest-ios]",
          platform: "ios",
          agentAlerts: true,
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
      },
      actions: {},
      proofNonces: {},
      events: [],
    });

    const sent = await object.fetch(
      new Request("https://relay.aimux.app/security/test-push", {
        method: "POST",
        headers: {
          "X-Aimux-User-Id": "user_guest",
          "X-Aimux-Share-Owner-Id": "user_owner",
          "X-Aimux-Share-Id": shareId,
        },
      }),
    );

    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ ok: true, sent: 1 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Array<{ to: string }>;
    expect(body.map((message) => message.to)).toEqual(["ExponentPushToken[owner-ios]"]);
  });

  it("rejects forged shared test push headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ status: "ok" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const storage = storageWithSockets([]);
    await storage.put("security-state:v1", {
      version: 1,
      devices: {
        owner_phone: {
          id: "owner_phone",
          deviceId: "owner_phone",
          kind: "ios",
          firstSeenAt: "2026-05-24T00:00:00.000Z",
          lastSeenAt: "2026-05-24T00:00:00.000Z",
        },
      },
      pushTokens: {
        "user_owner:owner_phone": {
          userId: "user_owner",
          deviceId: "owner_phone",
          token: "ExponentPushToken[owner-ios]",
          platform: "ios",
          agentAlerts: true,
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
      },
      actions: {},
      proofNonces: {},
      events: [],
    });
    const object = createObject(storage, {} as unknown as Env);

    const rejected = await object.fetch(
      new Request("https://relay.aimux.app/security/test-push", {
        method: "POST",
        headers: {
          "X-Aimux-User-Id": "user_guest",
          "X-Aimux-Share-Owner-Id": "user_owner",
          "X-Aimux-Share-Id": "share_missing",
        },
      }),
    );

    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toMatchObject({ ok: false, error: "Shared chat not found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the approval event to the waiting owner client", async () => {
    const storage = storageWithSockets([]);
    const object = createObject(storage, {
      SECURITY_DEVICE_POLICY: "enforce",
    } as unknown as Env);

    await object
      .fetch(
        new Request("https://relay.aimux.app/client/connect?deviceId=client_1&deviceKind=ios&deviceName=iPhone", {
          headers: { Upgrade: "websocket", "X-Aimux-User-Id": "user_owner" },
        }),
      )
      .catch((error) => error);

    const clientSocket = storage.sockets?.at(-1);
    expect(clientSocket?.send).toHaveBeenCalledWith(expect.stringContaining("Remote approval needed"));
    expect(clientSocket?.send).toHaveBeenCalledWith(expect.stringContaining("approvalCode"));
  });

  it("does not approve historical devices that are no longer connected", async () => {
    const storage = storageWithSockets([]);
    await storage.put("security-state:v1", {
      version: 1,
      devices: {
        client_1: {
          id: "client_1",
          deviceId: "client_1",
          kind: "ios",
          name: "iPhone",
          firstSeenAt: "2026-05-24T00:00:00.000Z",
          lastSeenAt: "2026-05-24T00:00:00.000Z",
        },
      },
      pushTokens: {},
      actions: {},
      events: [],
    });
    const object = createObject(storage, {
      SECURITY_DEVICE_POLICY: "enforce",
    } as unknown as Env);

    const response = await object.fetch(
      new Request("https://relay.aimux.app/security/devices/client_1/approve", { method: "POST" }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "Device is not currently connected and waiting for approval",
    });
  });

  it("rejects unapproved owner client requests under enforce mode", async () => {
    const clientSocket = fakeSocket(["client", "device:client_1"]);
    const storage = storageWithSockets([clientSocket]);
    const object = createObject(storage, { SECURITY_DEVICE_POLICY: "enforce" } as unknown as Env);

    await object.webSocketMessage(
      clientSocket,
      JSON.stringify({ id: "req-1", type: "request", method: "GET", path: "/projects" }),
    );

    expect(clientSocket.send).toHaveBeenCalledWith(
      JSON.stringify({
        id: "req-1",
        type: "response",
        status: 403,
        body: { ok: false, error: "Remote client pending security approval" },
      }),
    );
  });

  it("includes the approval code when rejecting a live pending owner client request", async () => {
    const clientSocket = fakeSocket(["client", "device:client_1"]);
    const storage = storageWithSockets([clientSocket]);
    await storage.put("security-state:v1", {
      version: 1,
      devices: {
        client_1: {
          id: "client_1",
          deviceId: "client_1",
          kind: "ios",
          name: "iPhone",
          firstSeenAt: "2026-05-24T00:00:00.000Z",
          lastSeenAt: "2026-05-24T00:00:00.000Z",
        },
      },
      pushTokens: {},
      actions: {},
      events: [],
    });
    const object = createObject(storage, { SECURITY_DEVICE_POLICY: "enforce" } as unknown as Env);

    await object.webSocketMessage(
      clientSocket,
      JSON.stringify({ id: "req-1", type: "request", method: "GET", path: "/projects" }),
    );

    expect(clientSocket.send).toHaveBeenCalledWith(
      expect.stringContaining("Remote client pending security approval. Code "),
    );
    const sent = JSON.parse(String(clientSocket.send.mock.calls.at(-1)?.[0])) as {
      body: { approvalCode?: string; error?: string };
    };
    expect(sent.body.approvalCode).toMatch(/^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/);
    expect(sent.body.error).toContain(sent.body.approvalCode);
  });

  it("allows approved owner client requests to reach daemon routing", async () => {
    const clientSocket = fakeSocket(["client", "device:client_1"]);
    const storage = storageWithSockets([clientSocket]);
    await storage.put("security-state:v1", {
      version: 1,
      devices: {
        client_1: {
          id: "client_1",
          deviceId: "client_1",
          kind: "web",
          firstSeenAt: "2026-05-24T00:00:00.000Z",
          lastSeenAt: "2026-05-24T00:00:00.000Z",
          approvedAt: "2026-05-24T00:01:00.000Z",
        },
      },
      pushTokens: {},
      actions: {},
      events: [],
    });
    const object = createObject(storage, { SECURITY_DEVICE_POLICY: "enforce" } as unknown as Env);

    await object.webSocketMessage(
      clientSocket,
      JSON.stringify({ id: "req-1", type: "request", method: "GET", path: "/projects" }),
    );

    expect(clientSocket.send).toHaveBeenCalledWith(
      JSON.stringify({
        id: "req-1",
        type: "response",
        status: 503,
        body: { ok: false, error: "Daemon not connected", machines: [] },
      }),
    );
  });

  it("rejects owner client connections without proof when proof enforcement is enabled", async () => {
    const storage = storageWithSockets([]);
    const object = createObject(storage, {
      SECURITY_DEVICE_PROOF_POLICY: "enforce",
    } as unknown as Env);

    const response = await object.fetch(
      new Request("https://relay.aimux.app/client/connect?deviceId=client_1", {
        headers: { Upgrade: "websocket", "X-Aimux-User-Id": "user_owner" },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Invalid device proof");
  });

  it("records valid owner client device proof metadata", async () => {
    const storage = storageWithSockets([]);
    const object = createObject(storage, {
      SECURITY_DEVICE_PROOF_POLICY: "enforce",
    } as unknown as Env);
    const proof = await createTestDeviceProof("client_1");

    await object
      .fetch(
        new Request(`https://relay.aimux.app/client/connect?deviceId=client_1&${proof.query}`, {
          headers: { Upgrade: "websocket", "X-Aimux-User-Id": "user_owner" },
        }),
      )
      .catch((error) => error);

    const security = await storage.get<{
      devices: Record<string, { id: string; publicKeyAlg?: string; publicKeyJwk?: JsonWebKey; lastProofAt?: string }>;
    }>("security-state:v1");
    expect(security?.devices.client_1).toMatchObject({
      id: "client_1",
      publicKeyAlg: "ES256",
      publicKeyJwk: proof.publicKeyJwk,
      lastProofAt: proof.timestamp,
    });
  });

  it("rejects owner push token registration without proof under proof enforcement", async () => {
    const storage = storageWithSockets([]);
    await storage.put("security-state:v1", {
      version: 1,
      devices: {
        client_1: {
          id: "client_1",
          deviceId: "client_1",
          kind: "ios",
          firstSeenAt: "2026-05-24T00:00:00.000Z",
          lastSeenAt: "2026-05-24T00:00:00.000Z",
          approvedAt: "2026-05-24T00:01:00.000Z",
        },
      },
      pushTokens: {},
      actions: {},
      proofNonces: {},
      events: [],
    });
    const object = createObject(storage, {
      SECURITY_DEVICE_PROOF_POLICY: "enforce",
    } as unknown as Env);

    const response = await object.fetch(
      new Request("https://relay.aimux.app/security/push-token", {
        method: "POST",
        headers: { "X-Aimux-User-Id": "user_owner", "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: "client_1",
          token: "ExponentPushToken[test]",
          platform: "ios",
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining("Invalid device proof") });
  });
});

function createObject(storage: MemoryStorage & { sockets?: Array<ReturnType<typeof fakeSocket>> }, env: Env) {
  const tags = new Map<WebSocket, string[]>();
  return new RelayObject(
    {
      storage,
      getWebSockets: () => storage.sockets ?? [],
      getTags: (ws: WebSocket) => tags.get(ws) ?? (ws as WebSocket & { tags?: string[] }).tags ?? [],
      acceptWebSocket: (ws: WebSocket, acceptedTags: string[]) => {
        tags.set(ws, acceptedTags);
        storage.sockets = [...(storage.sockets ?? []), ws as ReturnType<typeof fakeSocket>];
      },
    } as unknown as DurableObjectState,
    env,
  );
}

function storageWithSockets(sockets: Array<ReturnType<typeof fakeSocket>>) {
  const storage = new MemoryStorage();
  return Object.assign(storage, {
    sockets,
  });
}

function fakeSocket(tags: string[]) {
  let attachment: unknown;
  return {
    tags,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn((value: unknown) => {
      attachment = value;
    }),
    deserializeAttachment: vi.fn(() => attachment),
  } as unknown as WebSocket & {
    tags: string[];
    send: ReturnType<typeof vi.fn>;
    serializeAttachment: ReturnType<typeof vi.fn>;
    deserializeAttachment: ReturnType<typeof vi.fn>;
  };
}

async function createAcceptedShareInOwnerObject(object: RelayObject): Promise<string> {
  const invite = await createInvite(object);
  const accepted = await object.fetch(
    request(`https://relay.aimux.app/shares/invite/user_owner/${invite.token}/accept`, {
      method: "POST",
      userId: "user_guest",
      name: "Guest",
      email: "guest@example.com",
    }),
  );
  expect(accepted.status).toBe(200);
  const body = (await accepted.json()) as { share: { id: string } };
  return body.share.id;
}

async function createInvite(object: RelayObject): Promise<{ token: string }> {
  const response = await object.fetch(
    request("https://relay.aimux.app/shares/invite", {
      method: "POST",
      userId: "user_owner",
      name: "Owner",
      email: "owner@example.com",
      body: {
        projectRoot: "/Users/sam/cs/scratch",
        serviceEndpoint: { host: "relay.aimux.app", port: 443 },
        sessionId: "claude-k4lihz",
        email: "guest@example.com",
      },
    }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { acceptUrl: string };
  return { token: new URL(body.acceptUrl).pathname.split("/").at(-2)! };
}

async function createTestDeviceProof(deviceId: string): Promise<{
  timestamp: string;
  publicKeyJwk: JsonWebKey;
  query: string;
}> {
  const timestamp = new Date().toISOString();
  const nonce = randomBase64Url(16);
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(deviceProofMessage(deviceId, timestamp, nonce)),
  );
  const params = new URLSearchParams();
  params.set("deviceKeyAlg", "ES256");
  params.set("devicePublicKey", base64UrlEncode(new TextEncoder().encode(JSON.stringify(publicKeyJwk))));
  params.set("deviceProofTs", timestamp);
  params.set("deviceProofNonce", nonce);
  params.set("deviceProof", base64UrlEncode(new Uint8Array(signature)));
  return { timestamp, publicKeyJwk, query: params.toString() };
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function request(
  url: string,
  opts: {
    method: string;
    userId: string;
    name: string;
    email: string;
    body?: unknown;
  },
) {
  return new Request(url, {
    method: opts.method,
    headers: {
      "X-Aimux-User-Id": opts.userId,
      "X-Aimux-User-Name": opts.name,
      "X-Aimux-User-Email": opts.email,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

describe("RelayObject owner identification", () => {
  // An approved client reaching the daemon over the relay was refused as a shared
  // guest, and the GUI rendered that refusal as "no projects detected". The relay
  // is the only party that knows the socket belongs to the owner's own paired
  // device, so it has to say so on the way through.
  async function prepare(ws: WebSocket, headers?: Record<string, string>) {
    const object = createObject(new MemoryStorage(), {} as unknown as Env);
    return (
      object as unknown as {
        prepareClientRequest: (
          ws: WebSocket,
          request: {
            id: string;
            type: "request";
            method: string;
            path: string;
            headers?: Record<string, string>;
          },
        ) => Promise<
          | {
              ok: true;
              requestPatch?: { headers?: Record<string, string> };
            }
          | { ok: false; error: string }
        >;
      }
    ).prepareClientRequest(ws, {
      id: "req_1",
      type: "request",
      method: "GET",
      path: "/projects",
      headers,
    });
  }

  it("stamps the owner role on a request from a paired device with no share", async () => {
    const result = await prepare(fakeSocket(["client", "device:client_phone"]));
    expect(result.ok).toBe(true);
    expect(result.ok ? result.requestPatch?.headers?.["X-Aimux-Actor-Role"] : null).toBe("owner");
  });

  it("does not let a client claim its own aimux identity headers", async () => {
    const result = await prepare(fakeSocket(["client", "device:client_phone"]), {
      "x-aimux-actor-role": "operator",
      "x-aimux-share-id": "share-someone-elses",
      accept: "application/json",
    });
    expect(result.ok).toBe(true);
    const headers = result.ok ? (result.requestPatch?.headers ?? {}) : {};
    expect(headers["X-Aimux-Actor-Role"]).toBe("owner");
    expect(headers["x-aimux-share-id"]).toBeUndefined();
    expect(headers["x-aimux-actor-role"]).toBeUndefined();
    expect(headers.accept).toBe("application/json");
  });
});

describe("RelayObject machines", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "WebSocketPair",
      class TestWebSocketPair {
        0 = fakeSocket([]);
        1 = fakeSocket([]);
      },
    );
  });

  function daemonSocket(machineId: string, machineName: string) {
    return fakeSocket(["daemon", "user:user_owner", `machine:${machineId}`, `machineName:${machineName}`]);
  }

  async function connectDaemon(object: RelayObject, query: string) {
    return object
      .fetch(
        new Request(`https://relay.aimux.app/daemon/connect${query}`, {
          headers: { Upgrade: "websocket", "X-Aimux-User-Id": "user_owner" },
        }),
      )
      .catch((error) => error);
  }

  function lastSentTo(socket: ReturnType<typeof fakeSocket>) {
    const calls = socket.send.mock.calls;
    return calls.length === 0 ? undefined : (JSON.parse(String(calls.at(-1)?.[0])) as Record<string, unknown>);
  }

  // The whole reason this exists: connecting strix used to kick the mbp off.
  it("lets a second machine join instead of evicting the first", async () => {
    const mbp = daemonSocket("mbp", "sam-mbp");
    const client = fakeSocket(["client", "device:client_1"]);
    const storage = storageWithSockets([mbp, client]);
    const object = createObject(storage, {} as unknown as Env);

    const response = await connectDaemon(object, "?machineId=strix&machineName=sam-strix");

    expect(response).toBeInstanceOf(RangeError);
    expect(mbp.close).not.toHaveBeenCalled();
    expect(mbp.send).not.toHaveBeenCalled();
    expect(lastSentTo(client)).toEqual({
      type: "daemon_status",
      online: true,
      machines: [
        { id: "mbp", name: "sam-mbp" },
        { id: "strix", name: "sam-strix" },
      ],
    });
  });

  it("replaces only the reconnecting machine's own daemon", async () => {
    const mbp = daemonSocket("mbp", "sam-mbp");
    const strix = daemonSocket("strix", "sam-strix");
    const storage = storageWithSockets([mbp, strix]);
    const object = createObject(storage, {} as unknown as Env);

    await connectDaemon(object, "?machineId=mbp&machineName=sam-mbp");

    expect(mbp.close).toHaveBeenCalledWith(1000, "Replaced");
    expect(mbp.send).toHaveBeenCalledWith(expect.stringContaining("Replaced by new daemon connection"));
    expect(strix.close).not.toHaveBeenCalled();
    expect(strix.send).not.toHaveBeenCalled();
  });

  it("sends a request to the machine the client named", async () => {
    const mbp = daemonSocket("mbp", "sam-mbp");
    const strix = daemonSocket("strix", "sam-strix");
    const client = fakeSocket(["client", "device:client_1"]);
    const storage = storageWithSockets([mbp, strix, client]);
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(
      client,
      JSON.stringify({ id: "req-1", type: "request", method: "GET", path: "/projects", machineId: "strix" }),
    );

    expect(strix.send).toHaveBeenCalledTimes(1);
    expect(mbp.send).not.toHaveBeenCalled();
    expect(JSON.parse(String(strix.send.mock.calls[0]?.[0]))).toMatchObject({
      type: "request",
      path: "/projects",
    });
  });

  // Picking one would route a kill to the wrong host.
  it("refuses to guess a machine and answers with the list instead", async () => {
    const mbp = daemonSocket("mbp", "sam-mbp");
    const strix = daemonSocket("strix", "sam-strix");
    const client = fakeSocket(["client", "device:client_1"]);
    const storage = storageWithSockets([mbp, strix, client]);
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(
      client,
      JSON.stringify({ id: "req-1", type: "request", method: "POST", path: "/agents/kill" }),
    );

    expect(mbp.send).not.toHaveBeenCalled();
    expect(strix.send).not.toHaveBeenCalled();
    expect(lastSentTo(client)).toEqual({
      id: "req-1",
      type: "response",
      status: 409,
      body: {
        ok: false,
        error: "Several machines are connected; name one with machineId",
        machines: [
          { id: "mbp", name: "sam-mbp" },
          { id: "strix", name: "sam-strix" },
        ],
      },
    });
  });

  it("will not let one machine answer another machine's request", async () => {
    const mbp = daemonSocket("mbp", "sam-mbp");
    const strix = daemonSocket("strix", "sam-strix");
    const client = fakeSocket(["client", "device:client_1"]);
    const storage = storageWithSockets([mbp, strix, client]);
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(
      client,
      JSON.stringify({ id: "req-1", type: "request", method: "GET", path: "/projects", machineId: "mbp" }),
    );
    const relayRequestId = (JSON.parse(String(mbp.send.mock.calls[0]?.[0])) as { id: string }).id;
    client.send.mockClear();

    await object.webSocketMessage(
      strix,
      JSON.stringify({ id: relayRequestId, type: "response", status: 200, body: { ok: true, stolen: true } }),
    );

    expect(client.send).not.toHaveBeenCalled();
    expect(strix.send).toHaveBeenCalledWith(expect.stringContaining("No pending relay request"));

    await object.webSocketMessage(
      mbp,
      JSON.stringify({ id: relayRequestId, type: "response", status: 200, body: { ok: true } }),
    );
    expect(lastSentTo(client)).toMatchObject({ id: "req-1", type: "response", status: 200 });
  });

  it("fails only the lost machine's in-flight work and keeps the other online", async () => {
    const mbp = daemonSocket("mbp", "sam-mbp");
    const strix = daemonSocket("strix", "sam-strix");
    const client = fakeSocket(["client", "device:client_1"]);
    const storage = storageWithSockets([mbp, strix, client]);
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(
      client,
      JSON.stringify({ id: "mbp-req", type: "request", method: "GET", path: "/projects", machineId: "mbp" }),
    );
    await object.webSocketMessage(
      client,
      JSON.stringify({ id: "strix-req", type: "request", method: "GET", path: "/projects", machineId: "strix" }),
    );
    const strixRelayId = (JSON.parse(String(strix.send.mock.calls[0]?.[0])) as { id: string }).id;
    client.send.mockClear();
    storage.sockets = [strix, client];

    await object.webSocketClose(mbp);

    const sent = client.send.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(sent).toEqual([
      { id: "mbp-req", type: "response", status: 502, body: { ok: false, error: "Daemon connection lost" } },
      { type: "daemon_status", online: true, machines: [{ id: "strix", name: "sam-strix" }] },
    ]);

    // The surviving machine's request is still routable afterwards.
    client.send.mockClear();
    await object.webSocketMessage(
      strix,
      JSON.stringify({ id: strixRelayId, type: "response", status: 200, body: { ok: true } }),
    );
    expect(lastSentTo(client)).toMatchObject({ id: "strix-req", status: 200 });
  });

  // Written by an older relay, so it carries no machine. Answering it from
  // whichever daemon is alone in the room is exactly the mix-up to avoid.
  it("fails rebuilt work that lost which machine it was for", async () => {
    const mbp = daemonSocket("mbp", "sam-mbp");
    const client = fakeSocket(["client", "device:client_1"]);
    (client as unknown as { serializeAttachment: (value: unknown) => void }).serializeAttachment({
      pendingRequests: { "do-old-1": { clientRequestId: "req-old", expiresAt: Date.now() + 60_000 } },
      projectEventSubscriptions: { "do-old-2": "sub-old" },
    });
    const storage = storageWithSockets([mbp, client]);
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(client, JSON.stringify({ type: "ping" }));

    const sent = client.send.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(sent).toEqual([
      {
        id: "sub-old",
        type: "project_events_error",
        status: 503,
        message: "Relay lost which machine this stream was for; subscribe again",
      },
      {
        id: "req-old",
        type: "response",
        status: 503,
        body: { ok: false, error: "Relay lost which machine this request was for; retry it" },
      },
      { type: "pong" },
    ]);
    expect(mbp.send).not.toHaveBeenCalled();
  });

  // A close delivered after hibernation arrives with every in-memory map empty,
  // so the machine has to come from the durable attachment.
  it("unsubscribes a hibernated client's stream from the right machine", async () => {
    const mbp = daemonSocket("mbp", "sam-mbp");
    const strix = daemonSocket("strix", "sam-strix");
    const client = fakeSocket(["client", "device:client_1"]);
    (client as unknown as { serializeAttachment: (value: unknown) => void }).serializeAttachment({
      projectEventSubscriptions: { "do-1": { clientSubscriptionId: "sub-1", machineId: "strix" } },
    });
    const storage = storageWithSockets([mbp, strix, client]);
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketClose(client);

    expect(JSON.parse(String(strix.send.mock.calls.at(-1)?.[0]))).toEqual({
      id: "do-1",
      type: "project_events_unsubscribe",
    });
    expect(mbp.send).not.toHaveBeenCalled();
  });

  it("keeps one slot for a daemon that does not say which machine it is", async () => {
    const legacy = fakeSocket(["daemon", "user:user_owner"]);
    const client = fakeSocket(["client", "device:client_1"]);
    const storage = storageWithSockets([legacy, client]);
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(
      client,
      JSON.stringify({ id: "req-1", type: "request", method: "GET", path: "/projects" }),
    );

    expect(legacy.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(legacy.send.mock.calls[0]?.[0]))).toMatchObject({ path: "/projects" });
  });

  // A share is one session on one host, not a window onto the fleet.
  it("binds a new share to the machine the owner named", async () => {
    const storage = storageWithSockets([]);
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response("{}", { status: 200 })) })),
      },
    } as unknown as Env);

    const response = await object.fetch(
      request("https://relay.aimux.app/shares/invite", {
        method: "POST",
        userId: "user_owner",
        name: "Sam",
        email: "sam@example.com",
        body: {
          projectRoot: "/repo/aimux",
          sessionId: "claude-1",
          email: "guest@example.com",
          machineId: "strix",
          serviceEndpoint: { host: "127.0.0.1", port: 43191 },
        },
      }),
    );

    expect(response.status).toBe(201);
    const sharing = await storage.get<{ shares: Record<string, { machineId?: string }> }>("sharing-state:v1");
    expect(Object.values(sharing!.shares).map((share) => share.machineId)).toEqual(["strix"]);
  });

  it("tells a shared guest nothing about which machines exist", async () => {
    const mbp = daemonSocket("mbp", "sam-mbp");
    const strix = daemonSocket("strix", "sam-strix");
    const storage = storageWithSockets([mbp, strix]);
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response("{}", { status: 200 })) })),
      },
    } as unknown as Env);
    const shareId = await createAcceptedShareInOwnerObject(object);
    const owner = fakeSocket(["client", "device:client_1"]);
    const guest = fakeSocket(["client", `share:${shareId}`, "user:user_guest"]);
    storage.sockets = [mbp, strix, owner, guest];

    await object.webSocketClose(mbp);

    expect(lastSentTo(owner)).toEqual({
      type: "daemon_status",
      online: true,
      machines: [{ id: "strix", name: "sam-strix" }],
    });
    expect(lastSentTo(guest)).toEqual({ type: "daemon_status", online: true });
  });

  it("will not let a shared guest choose which machine answers", async () => {
    const mbp = daemonSocket("mbp", "sam-mbp");
    const strix = daemonSocket("strix", "sam-strix");
    const storage = storageWithSockets([mbp, strix]);
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response("{}", { status: 200 })) })),
      },
    } as unknown as Env);
    const shareId = await createAcceptedShareInOwnerObject(object);
    const guest = fakeSocket(["client", `share:${shareId}`, "user:user_guest"]);
    storage.sockets = [mbp, strix, guest];
    // The invite acceptance above told both machines; that is not this test.
    mbp.send.mockClear();
    strix.send.mockClear();
    const sharing = await storage.get<{
      shares: Record<string, { sessionId: string; machineId?: string }>;
    }>("sharing-state:v1");
    const sharedPath = `/agents/history?sessionId=${sharing!.shares[shareId].sessionId}`;

    // An unbound share with two machines up is refused, and says nothing.
    await object.webSocketMessage(
      guest,
      JSON.stringify({ id: "req-1", type: "request", method: "GET", path: sharedPath, machineId: "strix" }),
    );
    expect(mbp.send).not.toHaveBeenCalled();
    expect(strix.send).not.toHaveBeenCalled();
    expect(lastSentTo(guest)).toEqual({
      id: "req-1",
      type: "response",
      status: 503,
      body: { ok: false, error: "This shared chat is not bound to a machine", machines: [] },
    });

    // Bound to the mbp, the guest's request goes there -- not to the machine
    // the guest asked for.
    sharing!.shares[shareId].machineId = "mbp";
    await storage.put("sharing-state:v1", sharing);

    await object.webSocketMessage(
      guest,
      JSON.stringify({ id: "req-2", type: "request", method: "GET", path: sharedPath, machineId: "strix" }),
    );
    expect(strix.send).not.toHaveBeenCalled();
    expect(mbp.send).toHaveBeenCalledTimes(1);
  });

  // A project id and root exist on more than one host, so a tapped
  // notification without this deep-links to whichever one the app resolves.
  it("stamps a push with the machine that raised it", async () => {
    const pushed: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      pushed.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const strix = daemonSocket("strix", "sam-strix");
    const storage = storageWithSockets([strix]);
    await storage.put("security-state:v1", {
      version: 1,
      devices: {},
      pushTokens: {
        phone: {
          id: "phone",
          token: "ExponentPushToken[x]",
          platform: "ios",
          userId: "user_owner",
          deviceId: "phone",
          createdAt: "2026-05-24T00:00:00.000Z",
        },
      },
      actions: {},
      events: [],
    });
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(
      strix,
      JSON.stringify({
        type: "notification_push",
        notification: { title: "Agent needs input", projectRoot: "/repo/aimux" },
      }),
    );

    globalThis.fetch = originalFetch;
    expect(pushed).toHaveLength(1);
    const messages = pushed[0] as { data: { machineId?: string; projectRoot?: string } }[];
    expect(messages[0].data).toMatchObject({ machineId: "strix", projectRoot: "/repo/aimux" });
  });

  it("tells every machine about a security event", async () => {
    const mbp = daemonSocket("mbp", "sam-mbp");
    const strix = daemonSocket("strix", "sam-strix");
    const storage = storageWithSockets([mbp, strix]);
    const object = createObject(storage, {} as unknown as Env);

    const response = await object
      .fetch(
        new Request("https://relay.aimux.app/client/connect?deviceId=new_phone&deviceKind=ios&deviceName=iPhone", {
          headers: { Upgrade: "websocket", "X-Aimux-User-Id": "user_owner" },
        }),
      )
      .catch((error) => error);

    expect(response).toBeInstanceOf(RangeError);
    expect(mbp.send).toHaveBeenCalledWith(expect.stringContaining("new_client_detected"));
    expect(strix.send).toHaveBeenCalledWith(expect.stringContaining("new_client_detected"));
  });

  it("lets an unidentified daemon share the room with a named one", async () => {
    const legacy = fakeSocket(["daemon", "user:user_owner"]);
    const strix = daemonSocket("strix", "sam-strix");
    const client = fakeSocket(["client", "device:client_1"]);
    const storage = storageWithSockets([legacy, strix, client]);
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(
      client,
      JSON.stringify({ id: "req-1", type: "request", method: "GET", path: "/projects", machineId: "unidentified" }),
    );

    expect(legacy.send).toHaveBeenCalledTimes(1);
    expect(strix.send).not.toHaveBeenCalled();
    expect(lastSentTo(client)).toBeUndefined();
  });

  it("refuses a machine beyond the room cap rather than growing without end", async () => {
    const existing = Array.from({ length: MAX_MACHINES_PER_ROOM }, (_, index) =>
      daemonSocket(`m${index}`, `host-${index}`),
    );
    const storage = storageWithSockets(existing);
    const object = createObject(storage, {} as unknown as Env);

    const response = await connectDaemon(object, "?machineId=onetoomany&machineName=extra");

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(503);
    // An existing machine reconnecting is not a new machine, so it still fits.
    const reconnect = await connectDaemon(object, "?machineId=m0&machineName=host-0");
    expect(reconnect).toBeInstanceOf(RangeError);
  });
});
