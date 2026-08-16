import { beforeEach, describe, expect, it, vi } from "vitest";
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
        new Request("https://relay.aimux.app/client/connect?deviceId=client_1&deviceKind=ios&deviceName=iPhone", {
          headers: { Upgrade: "websocket", "X-Aimux-User-Id": "user_owner" },
        }),
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
        approvalCode: expect.stringMatching(/^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/),
      }),
    ]);

    const approved = await object.fetch(
      new Request("https://relay.aimux.app/security/devices/client_1/approve", { method: "POST" }),
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
        body: { ok: false, error: "Daemon not connected" },
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
  return {
    tags,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket & { tags: string[]; send: ReturnType<typeof vi.fn> };
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
