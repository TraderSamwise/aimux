import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MACHINES_PER_ROOM, UNSEQUENCED_CONNECTION, connectionSequenceFromTags } from "./machines";
import { MAX_PROJECT_ENDPOINT_REPORTS, RelayObject } from "./relay-object";
import projectEndpointsContract from "../../testdata/contracts/v1/relay-project-endpoints.json";
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
  /// How many times each key was read, so a route can be asked whether it
  /// reads the same record twice to answer one question.
  readonly reads = new Map<string, number>();

  async get<T>(key: string): Promise<T | undefined> {
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
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
        // Which machine answered, from the socket's tags. A daemon with no id
        // lands in the reserved slot, which is what this fixture's tags say.
        machineId: "unidentified",
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

// Two of the owner's machines, both connected to the object that belongs to
// that owner. The account boundary is therefore closed by construction rather
// than by a check -- which is why the tests here are about the SECOND
// boundary: being on the account is not being at the keyboard.
// Ownership of a checkout is the deliberate record the ledger work needs
// before anything resolves to an owner. It moves by hand, never by election,
// and a second machine learning that it is NOT the owner is the whole point.
describe("RelayObject recording which machine owns a checkout", () => {
  function fleet(machines: string[]) {
    const sockets = machines.map((id) =>
      fakeSocket(["daemon", `user:user_owner`, `machine:${id}`, `machineName:sam-${id}`]),
    );
    return { sockets, storage: storageWithSockets(sockets) };
  }

  function report(object: RelayObject, socket: ReturnType<typeof fakeSocket>, projectRoot: string) {
    return object.webSocketMessage(
      socket,
      JSON.stringify({
        type: "project_endpoints",
        projects: [{ projectRoot, host: "relay.aimux.app", port: 443 }],
      }),
    );
  }

  function claim(object: RelayObject, body: Record<string, unknown>) {
    return object.fetch(
      request("https://relay.aimux.app/projects/claim", {
        method: "POST",
        userId: "user_owner",
        name: "Owner",
        email: "owner@example.com",
        body,
      }),
    );
  }

  it("records the claim, and says who holds it", async () => {
    const {
      sockets: [mbp],
      storage,
    } = fleet(["mbp"]);
    const object = createObject(storage, {} as unknown as Env);
    await report(object, mbp, "/Users/sam/cs/aimux");

    const claimed = await claim(object, { projectRoot: "/Users/sam/cs/aimux", machineId: "mbp" });

    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ ok: true, alreadyOwned: false, owner: { machineId: "mbp" } });

    const listed = await object.fetch(
      request("https://relay.aimux.app/projects/owners", {
        method: "GET",
        userId: "user_owner",
        name: "Owner",
        email: "owner@example.com",
      }),
    );
    expect(await listed.json()).toMatchObject({
      ok: true,
      owners: [{ projectRoot: "/Users/sam/cs/aimux", machineId: "mbp", online: true }],
    });
  });

  it("refuses a second machine while the owner is connected, and names it", async () => {
    const {
      sockets: [mbp, strix],
      storage,
    } = fleet(["mbp", "strix"]);
    const object = createObject(storage, {} as unknown as Env);
    await report(object, mbp, "/Users/sam/cs/aimux");
    await report(object, strix, "/Users/sam/cs/aimux");
    expect((await claim(object, { projectRoot: "/Users/sam/cs/aimux", machineId: "mbp" })).status).toBe(200);

    const refused = await claim(object, { projectRoot: "/Users/sam/cs/aimux", machineId: "strix" });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      ok: false,
      refusal: "held-by-a-connected-machine",
      heldBy: { machineId: "mbp" },
      // In the sentence, because the sentence is the only part that reaches a
      // person: the CLI's relay client returns `error` and drops every field
      // beside it, so the name in `heldBy` was a name nobody ever saw.
      error: "Another machine owns that checkout and is connected right now: mbp",
    });
  });

  // The case the record exists for: the owner is a laptop that is shut, and
  // the work has to be able to carry on somewhere.
  it("says the owner is away, and lets another machine take it", async () => {
    const {
      sockets: [mbp, strix],
      storage,
    } = fleet(["mbp", "strix"]);
    const object = createObject(storage, {} as unknown as Env);
    await report(object, mbp, "/Users/sam/cs/aimux");
    await report(object, strix, "/Users/sam/cs/aimux");
    expect((await claim(object, { projectRoot: "/Users/sam/cs/aimux", machineId: "mbp" })).status).toBe(200);

    // mbp goes away; only strix is left on the socket list.
    const awake = storageWithSockets([strix]);
    await awake.put("sharing-state:v1", await storage.get("sharing-state:v1"));
    const reopened = createObject(awake, {} as unknown as Env);
    await report(reopened, strix, "/Users/sam/cs/aimux");

    const listed = await reopened.fetch(
      request("https://relay.aimux.app/projects/owners", {
        method: "GET",
        userId: "user_owner",
        name: "Owner",
        email: "owner@example.com",
      }),
    );
    expect(await listed.json(), "the owner is named and marked away").toMatchObject({
      owners: [{ machineId: "mbp", online: false }],
    });

    const taken = await claim(reopened, { projectRoot: "/Users/sam/cs/aimux", machineId: "strix" });
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({ owner: { machineId: "strix" } });
  });
});

describe("RelayObject letting one machine ask another", () => {
  function fleet() {
    const mbp = fakeSocket(["daemon", "user:user_owner", "machine:mbp", "machineName:sam-mbp"]);
    const strix = fakeSocket(["daemon", "user:user_owner", "machine:strix", "machineName:sam-strix"]);
    return { mbp, strix, storage: storageWithSockets([mbp, strix]) };
  }

  function ask(machineId: string | undefined, id = "peer-1") {
    return JSON.stringify({
      id,
      type: "request",
      ...(machineId ? { machineId } : {}),
      method: "POST",
      path: "/tasks/assign",
      body: { taskId: "t1" },
      headers: { "X-Aimux-Actor-Role": "owner" },
    });
  }

  it("carries the request to the machine it named, and back again", async () => {
    const { mbp, strix, storage } = fleet();
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(mbp, ask("strix"));

    const forwarded = JSON.parse(String(strix.send.mock.calls.at(-1)?.[0])) as {
      id: string;
      headers: Record<string, string>;
    };
    // Not `owner`. The owner's own app is stamped that, and the daemon hands
    // those to its whole API -- a peer carrying it would be every machine
    // holding every other machine's keyboard. What the caller claimed is
    // stripped, and the origin is stamped from the socket, not the frame.
    expect(forwarded.headers["X-Aimux-Actor-Role"]).toBe("peer");
    expect(forwarded.headers["X-Aimux-Peer-Machine-Id"]).toBe("mbp");

    await object.webSocketMessage(
      strix,
      JSON.stringify({ id: forwarded.id, type: "response", status: 200, body: { ok: true } }),
    );

    expect(JSON.parse(String(mbp.send.mock.calls.at(-1)?.[0]))).toMatchObject({
      id: "peer-1",
      type: "response",
      status: 200,
      body: { ok: true },
    });
  });

  // Every message rebuilds the live maps from the sockets, and the rebuild
  // used to read only the clients' attachments: a peer request died on the
  // next frame of any kind, a pong included.
  it("still knows who asked after the object has hibernated", async () => {
    const { mbp, strix, storage } = fleet();
    const object = createObject(storage, {} as unknown as Env);
    await object.webSocketMessage(mbp, ask("strix"));
    const forwarded = JSON.parse(String(strix.send.mock.calls.at(-1)?.[0])) as { id: string };

    const woken = createObject(storage, {} as unknown as Env);
    // A pong is the cheapest frame there is, and it was enough to lose it.
    await woken.webSocketMessage(mbp, JSON.stringify({ type: "pong" }));
    await woken.webSocketMessage(
      strix,
      JSON.stringify({ id: forwarded.id, type: "response", status: 200, body: { ok: true } }),
    );

    expect(JSON.parse(String(mbp.send.mock.calls.at(-1)?.[0]))).toMatchObject({
      id: "peer-1",
      status: 200,
    });
  });

  it("refuses a request that names no machine, rather than picking one", async () => {
    const { mbp, strix, storage } = fleet();
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(mbp, ask(undefined));

    expect(strix.send).not.toHaveBeenCalled();
    expect(JSON.parse(String(mbp.send.mock.calls.at(-1)?.[0]))).toMatchObject({
      id: "peer-1",
      status: 400,
      body: { refusal: "peer-target-unnamed" },
    });
  });

  it("refuses a machine naming itself, instead of looping", async () => {
    const { mbp, storage } = fleet();
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(mbp, ask("mbp"));

    expect(JSON.parse(String(mbp.send.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: 400,
      body: { refusal: "peer-target-is-self" },
    });
  });

  // A project service refuses with 502 and 503 as well, so an unmarked
  // refusal leaves the asking daemon unable to tell "the peer's service is
  // down" from "the relay would not carry this" -- two problems with two
  // fixes, wearing the same number.
  it("signs the refusals it makes itself", async () => {
    const { mbp, storage } = fleet();
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(mbp, ask(undefined));

    expect(JSON.parse(String(mbp.send.mock.calls.at(-1)?.[0]))).toMatchObject({
      source: "relay",
      status: 400,
    });
  });

  // The per-origin cap bounds what one machine can send and says nothing
  // about what one machine can be sent: several machines, each politely under
  // its own eight, still land all of them on one socket at once, and the
  // owner's own app waits behind them.
  it("stops a fleet filling one machine's queue between them", async () => {
    const mbp = fakeSocket(["daemon", "user:user_owner", "machine:mbp", "machineName:sam-mbp"]);
    const mini = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    const strix = fakeSocket(["daemon", "user:user_owner", "machine:strix", "machineName:sam-strix"]);
    // A third asker, so the refusal cannot be its own eight coming back.
    const air = fakeSocket(["daemon", "user:user_owner", "machine:air", "machineName:sam-air"]);
    const object = createObject(storageWithSockets([mbp, mini, strix, air]), {} as unknown as Env);

    for (let index = 0; index < 8; index += 1) {
      await object.webSocketMessage(mbp, ask("strix", `mbp-${index}`));
    }
    for (let index = 0; index < 8; index += 1) {
      await object.webSocketMessage(mini, ask("strix", `mini-${index}`));
    }
    expect(strix.send).toHaveBeenCalledTimes(16);

    // Nothing of its own in flight, and still refused: the limit here is the
    // machine being asked, not the one asking.
    await object.webSocketMessage(air, ask("strix", "air-first"));

    expect(strix.send).toHaveBeenCalledTimes(16);
    expect(JSON.parse(String(air.send.mock.calls.at(-1)?.[0]))).toMatchObject({
      id: "air-first",
      status: 429,
      body: { refusal: "peer-target-saturated" },
    });
  });

  it("refuses a machine that is not connected", async () => {
    const mbp = fakeSocket(["daemon", "user:user_owner", "machine:mbp", "machineName:sam-mbp"]);
    const object = createObject(storageWithSockets([mbp]), {} as unknown as Env);

    await object.webSocketMessage(mbp, ask("strix"));

    expect(JSON.parse(String(mbp.send.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: 503,
      body: { refusal: "peer-target-offline" },
    });
  });

  // A daemon answers its socket one request at a time, and the owner's own
  // app shares that socket. A peer sending faster than its target can answer
  // is not going faster; it is queueing work in front of the person.
  it("stops one machine filling another's queue", async () => {
    const { mbp, strix, storage } = fleet();
    const object = createObject(storage, {} as unknown as Env);

    for (let index = 0; index < 8; index += 1) {
      await object.webSocketMessage(mbp, ask("strix", `peer-${index}`));
    }
    expect(strix.send).toHaveBeenCalledTimes(8);

    await object.webSocketMessage(mbp, ask("strix", "peer-over"));

    expect(strix.send).toHaveBeenCalledTimes(8);
    expect(JSON.parse(String(mbp.send.mock.calls.at(-1)?.[0]))).toMatchObject({
      id: "peer-over",
      status: 429,
      body: { refusal: "peer-too-many-in-flight" },
    });
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

function createObject(
  storage: MemoryStorage & { sockets?: Array<ReturnType<typeof fakeSocket>> },
  env: Env,
  acceptedTagSets: string[][] = [],
) {
  const tags = new Map<WebSocket, string[]>();
  return new RelayObject(
    {
      storage,
      getWebSockets: () => storage.sockets ?? [],
      getTags: (ws: WebSocket) => tags.get(ws) ?? (ws as WebSocket & { tags?: string[] }).tags ?? [],
      acceptWebSocket: (ws: WebSocket, acceptedTags: string[]) => {
        tags.set(ws, acceptedTags);
        acceptedTagSets.push(acceptedTags);
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

// A second invite for a share people are already on changes the record they
// hold -- its host and its checkout both follow the invite -- and the receiver
// index is written only on accept, so without a refresh a guest's copy keeps
// the old root for good: a stale project name in its share list, and legacy
// `/agent/...` routes that match on the root failing for that guest.
describe("RelayObject refreshing a share its guests already hold", () => {
  it("pushes the moved checkout to the guests, and names any it could not reach", async () => {
    const upserted: { userId: string; projectRoot: string }[] = [];
    let failNext = false;
    const storage = storageWithSockets([]);
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn((id: { name: string }) => ({
          fetch: vi.fn(async (url: string, init?: RequestInit) => {
            if (!String(url).includes("/internal/accepted-shares/upsert")) {
              return new Response("{}", { status: 200 });
            }
            if (failNext) return new Response("nope", { status: 500 });
            const body = JSON.parse(String(init?.body)) as {
              share: { projectRoot: string };
            };
            upserted.push({ userId: id.name, projectRoot: body.share.projectRoot });
            return new Response("{}", { status: 200 });
          }),
        })),
      },
    } as unknown as Env);
    // Named, because a checkout that moved and a different checkout look the
    // same to a caller that cannot say which machine it is: following the one
    // would adopt the other, and move guests into a project nobody shared
    // with them. With the machine said, the share is unmistakably the same.
    await createAcceptedShareInOwnerObject(object, "mbp");
    upserted.length = 0;

    const moved = await object.fetch(
      request("https://relay.aimux.app/shares/invite", {
        method: "POST",
        userId: "user_owner",
        name: "Owner",
        email: "owner@example.com",
        body: {
          projectRoot: "/Users/sam/code/scratch",
          machineId: "mbp",
          sessionId: "claude-k4lihz",
          email: "second@example.com",
        },
      }),
    );

    expect(moved.status).toBe(201);
    expect(upserted).toEqual([{ userId: "user_guest", projectRoot: "/Users/sam/code/scratch" }]);
    expect(await moved.json()).not.toHaveProperty("staleReceivers");

    // A refresh that could not land is reported rather than swallowed: the
    // share still works from the owner's record, but that guest is reading a
    // stale copy of it.
    failNext = true;
    const again = await object.fetch(
      request("https://relay.aimux.app/shares/invite", {
        method: "POST",
        userId: "user_owner",
        name: "Owner",
        email: "owner@example.com",
        body: {
          projectRoot: "/Users/sam/code/scratch",
          machineId: "mbp",
          sessionId: "claude-k4lihz",
          email: "third@example.com",
        },
      }),
    );

    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({ staleReceivers: ["user_guest"] });
  });
});

// A project service binds a fresh port on every start, and a share stored the
// endpoint it was created with. So the first restart after a share was made
// left it proxying to a port nothing was listening on -- the daemon connected,
// the agent working, every request from that share refused -- and the only
// repair was issuing another invite, which emails somebody.
// A share made before a share recorded its host names no machine, so the
// route refuses every guest request with a message about a disconnected host
// -- while the host is online. Re-inviting repairs it and emails somebody who
// already accepted; this route says the same thing with no invite attached.
describe("RelayObject pointing a share at the machine that holds it", () => {
  function envRecording(upserted: { userId: string; hostBound?: boolean }[]) {
    return {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn((id: { name: string }) => ({
          fetch: vi.fn(async (url: string, init?: RequestInit) => {
            if (String(url).includes("/internal/accepted-shares/upsert")) {
              const body = JSON.parse(String(init?.body)) as { share: { hostBound?: boolean } };
              upserted.push({ userId: id.name, hostBound: body.share.hostBound });
            }
            return new Response("{}", { status: 200 });
          }),
        })),
      },
    } as unknown as Env;
  }

  /// The machine has to be connected AND to have reported the checkout, so a
  /// bind test needs daemon sockets and a report, not just a share.
  function fleet(machines: string[]) {
    const sockets = machines.map((id) =>
      fakeSocket(["daemon", "user:user_owner", `machine:${id}`, `machineName:sam-${id}`]),
    );
    return { sockets, storage: storageWithSockets(sockets) };
  }

  async function reportCheckout(
    object: RelayObject,
    socket: ReturnType<typeof fakeSocket>,
    projectRoot: string,
    port = 443,
  ) {
    await object.webSocketMessage(
      socket,
      JSON.stringify({
        type: "project_endpoints",
        projects: [{ projectRoot, host: "relay.aimux.app", port }],
      }),
    );
  }

  function bind(object: RelayObject, body: Record<string, unknown>, userId = "user_owner"): Promise<Response> {
    return object.fetch(
      request("https://relay.aimux.app/shares/bind", {
        method: "POST",
        userId,
        name: "Owner",
        email: "owner@example.com",
        body,
      }),
    );
  }

  it("binds the share the guests already hold, and tells them it is routable", async () => {
    const upserted: { userId: string; hostBound?: boolean }[] = [];
    const {
      sockets: [mbp],
      storage,
    } = fleet(["mbp"]);
    const object = createObject(storage, envRecording(upserted));
    const shareId = await createAcceptedShareInOwnerObject(object);
    await reportCheckout(object, mbp, "/Users/sam/cs/scratch");
    upserted.length = 0;

    const bound = await bind(object, { shareId, machineId: "mbp" });

    expect(bound.status).toBe(200);
    expect(await bound.json()).toMatchObject({
      ok: true,
      alreadyBound: false,
      share: { id: shareId, hostBound: true },
    });
    const state = await storage.get<{ shares: Record<string, { machineId?: string }> }>("sharing-state:v1");
    expect(state!.shares[shareId].machineId).toBe("mbp");
    expect(upserted).toEqual([{ userId: "user_guest", hostBound: true }]);
  });

  // A second press must not bump the version and push every guest a refresh
  // of a record that did not change.
  it("writes nothing when the share already points there", async () => {
    const upserted: { userId: string; hostBound?: boolean }[] = [];
    const {
      sockets: [mbp],
      storage,
    } = fleet(["mbp"]);
    const object = createObject(storage, envRecording(upserted));
    const shareId = await createAcceptedShareInOwnerObject(object);
    await reportCheckout(object, mbp, "/Users/sam/cs/scratch");
    expect((await bind(object, { shareId, machineId: "mbp" })).status).toBe(200);
    upserted.length = 0;

    const again = await bind(object, { shareId, machineId: "mbp" });

    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, alreadyBound: true });
    expect(upserted).toEqual([]);
  });

  // Defence in depth, said plainly: the worker sends `/shares/bind` to the
  // CALLER's own object, so in production a second account never reaches this
  // one at all. What this pins is that the object does not rely on that.
  it("will not let another account point someone else's share anywhere", async () => {
    const {
      sockets: [mbp],
      storage,
    } = fleet(["mbp"]);
    const object = createObject(storage, envRecording([]));
    const shareId = await createAcceptedShareInOwnerObject(object);
    await reportCheckout(object, mbp, "/Users/sam/cs/scratch");

    const refused = await bind(object, { shareId, machineId: "mbp" }, "user_guest");

    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ ok: false, refusal: "no-such-share" });
    const state = await storage.get<{ shares: Record<string, { machineId?: string }> }>("sharing-state:v1");
    expect(state!.shares[shareId].machineId).toBeUndefined();
  });

  // There is no unbind route and a re-invite builds a second share, so
  // refusing a move would make one wrong press permanent.
  it("moves a share the owner pointed at the wrong machine", async () => {
    const {
      sockets: [mbp, strix],
      storage,
    } = fleet(["mbp", "strix"]);
    const object = createObject(storage, envRecording([]));
    const shareId = await createAcceptedShareInOwnerObject(object);
    await reportCheckout(object, mbp, "/Users/sam/cs/scratch");
    await reportCheckout(object, strix, "/Users/sam/cs/scratch", 444);
    expect((await bind(object, { shareId, machineId: "strix" })).status).toBe(200);

    const corrected = await bind(object, { shareId, machineId: "mbp" });

    expect(corrected.status).toBe(200);
    expect(await corrected.json()).toMatchObject({ ok: true, alreadyBound: false });
    const state = await storage.get<{ shares: Record<string, { machineId?: string }> }>("sharing-state:v1");
    expect(state!.shares[shareId].machineId).toBe("mbp");
  });

  // A bind onto a machine that is not here would report success and leave the
  // share refusing every guest until that machine came back.
  it("refuses a machine that is not connected", async () => {
    const {
      sockets: [mbp],
      storage,
    } = fleet(["mbp"]);
    const object = createObject(storage, envRecording([]));
    const shareId = await createAcceptedShareInOwnerObject(object);
    await reportCheckout(object, mbp, "/Users/sam/cs/scratch");

    const refused = await bind(object, { shareId, machineId: "strix" });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, refusal: "machine-offline" });
  });

  // Connected, and has never said it has this checkout. Nothing else says the
  // target holds the project, let alone the session.
  it("refuses a machine that has not reported the share's checkout", async () => {
    const {
      sockets: [mbp, strix],
      storage,
    } = fleet(["mbp", "strix"]);
    const object = createObject(storage, envRecording([]));
    const shareId = await createAcceptedShareInOwnerObject(object);
    await reportCheckout(object, mbp, "/Users/sam/cs/scratch");
    await reportCheckout(object, strix, "/Users/sam/cs/something-else", 444);

    const refused = await bind(object, { shareId, machineId: "strix" });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      ok: false,
      refusal: "machine-does-not-hold-checkout",
    });
  });
});

// A report loads the sharing state, then spends up to twenty cross-object
// fetches pushing summaries to guests, then saves. Anything written in that
// window was being saved over -- and a bind pressed while a machine reports
// is the common case, because a report goes out on every connect.
describe("RelayObject saving a report over what landed while it ran", () => {
  it("keeps a bind that was pressed while the report was pushing summaries", async () => {
    const mbp = fakeSocket(["daemon", "user:user_owner", "machine:mbp", "machineName:sam-mbp"]);
    const storage = storageWithSockets([mbp]);
    let bindDuringFanOut: (() => Promise<void>) | undefined;
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({
          fetch: vi.fn(async (url: string) => {
            // The window itself: one of the report's own awaits, with the
            // owner pressing the button inside it.
            if (String(url).includes("/internal/accepted-shares/upsert")) {
              const pressing = bindDuringFanOut;
              bindDuringFanOut = undefined;
              if (pressing) await pressing();
            }
            return new Response("{}", { status: 200 });
          }),
        })),
      },
    } as unknown as Env);
    const shareId = await createAcceptedShareInOwnerObject(object);
    // The machine reports the checkout once, so the bind has its evidence.
    await object.webSocketMessage(
      mbp,
      JSON.stringify({
        type: "project_endpoints",
        projects: [{ projectRoot: "/Users/sam/cs/scratch", host: "relay.aimux.app", port: 443 }],
      }),
    );

    bindDuringFanOut = async () => {
      const bound = await object.fetch(
        request("https://relay.aimux.app/shares/bind", {
          method: "POST",
          userId: "user_owner",
          name: "Owner",
          email: "owner@example.com",
          body: { shareId, machineId: "mbp", projectRoot: "/Users/sam/cs/scratch" },
        }),
      );
      expect(bound.status, "the premise: the bind succeeded").toBe(200);
    };

    // A second report, on a moved port, so there is a fan-out to land inside.
    await object.webSocketMessage(
      mbp,
      JSON.stringify({
        type: "project_endpoints",
        projects: [{ projectRoot: "/Users/sam/cs/scratch", host: "relay.aimux.app", port: 8443 }],
      }),
    );

    const state = await storage.get<{
      shares: Record<string, { machineId?: string; serviceEndpoint?: { port: number } }>;
    }>("sharing-state:v1");
    expect(state!.shares[shareId].machineId, "the bind survived the report").toBe("mbp");
    // And the report still did its own job.
    expect(state!.shares[shareId].serviceEndpoint?.port).toBe(8443);
  });

  // The bind pushes the same summary to the same guests, and records the ones
  // it could not reach. This path cannot see that, and carrying its own
  // snapshot over the top lost them -- so the guest kept an unroutable copy
  // and nothing was owed, which no later report would notice because the
  // endpoint matches by then.
  it("keeps the guests a bind in the window could not reach", async () => {
    const mbp = fakeSocket(["daemon", "user:user_owner", "machine:mbp", "machineName:sam-mbp"]);
    const storage = storageWithSockets([mbp]);
    let bindDuringFanOut: (() => Promise<void>) | undefined;
    // The bind's own push fails; the report's succeeds. That is the ordering
    // that loses a guest.
    let failTheUpsert = false;
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({
          fetch: vi.fn(async (url: string) => {
            if (!String(url).includes("/internal/accepted-shares/upsert")) {
              return new Response("{}", { status: 200 });
            }
            if (failTheUpsert) return new Response("nope", { status: 500 });
            const pressing = bindDuringFanOut;
            bindDuringFanOut = undefined;
            if (pressing) await pressing();
            return new Response("{}", { status: 200 });
          }),
        })),
      },
    } as unknown as Env);
    const shareId = await createAcceptedShareInOwnerObject(object);
    const report = (port: number) =>
      object.webSocketMessage(
        mbp,
        JSON.stringify({
          type: "project_endpoints",
          projects: [{ projectRoot: "/Users/sam/cs/scratch", host: "relay.aimux.app", port }],
        }),
      );
    await report(443);

    // Recorded, not asserted, in here: this runs inside the refresh's own
    // try/catch, so a failed expectation would be swallowed and the test
    // would pass on the fallback path instead of the one under test.
    let bindOutcome: { status: number; body: unknown } | undefined;
    bindDuringFanOut = async () => {
      failTheUpsert = true;
      const bound = await object.fetch(
        request("https://relay.aimux.app/shares/bind", {
          method: "POST",
          userId: "user_owner",
          name: "Owner",
          email: "owner@example.com",
          body: { shareId, machineId: "mbp", projectRoot: "/Users/sam/cs/scratch" },
        }),
      );
      bindOutcome = { status: bound.status, body: await bound.json() };
      failTheUpsert = false;
    };
    await report(8443);
    expect(bindOutcome, "the premise: the bind landed inside the fan-out").toBeDefined();
    expect(bindOutcome?.status, "the premise: the bind succeeded").toBe(200);
    expect(bindOutcome?.body, "the premise: its push to the guest failed").toMatchObject({
      staleReceivers: ["user_guest"],
    });

    const state = await storage.get<{
      shares: Record<string, { staleReceivers?: string[] }>;
    }>("sharing-state:v1");
    expect(state!.shares[shareId].staleReceivers, "the guest is still owed a copy").toEqual(["user_guest"]);
  });

  // Two reports from ONE machine overlap: the connect frame and the
  // thirty-second reminder, and the gate opens during the fan-out. The first
  // one's save used to revert the second one's port -- leaving the share
  // proxying where nothing listens -- and erase the guest the second one
  // could not reach, so nothing was owed and no later report noticed.
  it("does not revert a second report that landed while it was fanning out", async () => {
    const mbp = fakeSocket(["daemon", "user:user_owner", "machine:mbp", "machineName:sam-mbp"]);
    const storage = storageWithSockets([mbp]);
    let secondReport: (() => Promise<void>) | undefined;
    let failTheUpsert = false;
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({
          fetch: vi.fn(async (url: string) => {
            if (!String(url).includes("/internal/accepted-shares/upsert")) {
              return new Response("{}", { status: 200 });
            }
            if (failTheUpsert) return new Response("nope", { status: 500 });
            const interleaved = secondReport;
            secondReport = undefined;
            if (interleaved) await interleaved();
            return new Response("{}", { status: 200 });
          }),
        })),
      },
    } as unknown as Env);
    const shareId = await createAcceptedShareInOwnerObject(object);
    const report = (port: number) =>
      object.webSocketMessage(
        mbp,
        JSON.stringify({
          type: "project_endpoints",
          projects: [{ projectRoot: "/Users/sam/cs/scratch", host: "relay.aimux.app", port }],
        }),
      );
    await report(443);

    let secondRan = false;
    secondReport = async () => {
      secondRan = true;
      // The newer port, and its push to the guest fails.
      failTheUpsert = true;
      await report(9443);
      failTheUpsert = false;
    };
    await report(8443);
    expect(secondRan, "the premise: the second report landed inside the first").toBe(true);

    const state = await storage.get<{
      shares: Record<string, { serviceEndpoint?: { port: number }; staleReceivers?: string[] }>;
    }>("sharing-state:v1");
    expect(state!.shares[shareId].serviceEndpoint?.port, "the newer port stands").toBe(9443);
    expect(state!.shares[shareId].staleReceivers, "and the guest it missed is owed").toEqual(["user_guest"]);
  });

  it("keeps the roots another machine reported while this report ran", async () => {
    const mbp = fakeSocket(["daemon", "user:user_owner", "machine:mbp", "machineName:sam-mbp"]);
    const strix = fakeSocket(["daemon", "user:user_owner", "machine:strix", "machineName:sam-strix"]);
    const storage = storageWithSockets([mbp, strix]);
    let reportDuringFanOut: (() => Promise<void>) | undefined;
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({
          fetch: vi.fn(async (url: string) => {
            if (String(url).includes("/internal/accepted-shares/upsert")) {
              const interleaved = reportDuringFanOut;
              reportDuringFanOut = undefined;
              if (interleaved) await interleaved();
            }
            return new Response("{}", { status: 200 });
          }),
        })),
      },
    } as unknown as Env);
    const shareId = await createAcceptedShareInOwnerObject(object);

    const reportRoots = (
      socket: ReturnType<typeof fakeSocket>,
      projects: Array<{ projectRoot: string; port: number }>,
    ) =>
      object.webSocketMessage(
        socket,
        JSON.stringify({
          type: "project_endpoints",
          projects: projects.map(({ projectRoot, port }) => ({
            projectRoot,
            host: "relay.aimux.app",
            port,
          })),
        }),
      );
    const report = (socket: ReturnType<typeof fakeSocket>, projectRoot: string, port: number) =>
      reportRoots(socket, [{ projectRoot, port }]);

    // The share has to be bound for a report to speak for it at all: with two
    // machines connected, one that names no host is deliberately left alone.
    await report(mbp, "/Users/sam/cs/scratch", 443);
    const bound = await object.fetch(
      request("https://relay.aimux.app/shares/bind", {
        method: "POST",
        userId: "user_owner",
        name: "Owner",
        email: "owner@example.com",
        body: { shareId, machineId: "mbp", projectRoot: "/Users/sam/cs/scratch" },
      }),
    );
    expect(bound.status, "the premise: the share is bound to mbp").toBe(200);

    // strix has reported nothing when mbp's next report loads its snapshot,
    // and reports for the first time inside mbp's fan-out.
    let interleavedRan = false;
    reportDuringFanOut = async () => {
      interleavedRan = true;
      await report(strix, "/Users/sam/cs/other", 444);
    };
    // Two roots, so this report moves an endpoint AND teaches something: the
    // index is only rewritten when a report learned something, so a test that
    // only moves a port never reaches the line under test.
    await reportRoots(mbp, [
      { projectRoot: "/Users/sam/cs/scratch", port: 8443 },
      { projectRoot: "/Users/sam/cs/extra", port: 9443 },
    ]);
    expect(interleavedRan, "the premise: strix reported inside mbp's fan-out").toBe(true);

    const state = await storage.get<{ machineProjectRoots?: Record<string, string[]> }>("sharing-state:v1");
    // Assigning the index wholesale from mbp's snapshot reverted strix -- and
    // a machine's roots are how a share that names no host is routed, so the
    // revert aimed a guest at a host without the checkout.
    expect(state!.machineProjectRoots).toEqual({
      mbp: ["/Users/sam/cs/extra", "/Users/sam/cs/scratch"],
      strix: ["/Users/sam/cs/other"],
    });
  });
});

describe("RelayObject following a project service onto its new port", () => {
  function envRecording(
    upserted: { userId: string; port?: number }[],
    receiverDown?: { value: boolean },
    attempted?: string[],
  ) {
    return {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn((id: { name: string }) => ({
          fetch: vi.fn(async (url: string, init?: RequestInit) => {
            if (String(url).includes("/internal/accepted-shares/upsert")) {
              const body = JSON.parse(String(init?.body)) as {
                share: { id: string; serviceEndpoint?: { port?: number } };
              };
              attempted?.push(body.share.id);
              if (receiverDown?.value) return new Response("nope", { status: 500 });
              upserted.push({ userId: id.name, port: body.share.serviceEndpoint?.port });
            }
            return new Response("{}", { status: 200 });
          }),
        })),
      },
    } as unknown as Env;
  }

  async function shareBoundTo(
    object: RelayObject,
    machineId: string | undefined,
    port: number,
    sessionId = "claude-psmp2r",
    projectRoot = "/Users/sam/cs/tealstreet-next",
  ): Promise<string> {
    const response = await object.fetch(
      request("https://relay.aimux.app/shares/invite", {
        method: "POST",
        userId: "user_owner",
        name: "Owner",
        email: "owner@example.com",
        body: {
          projectRoot,
          serviceEndpoint: { host: "127.0.0.1", port },
          machineId,
          sessionId,
          email: "guest@example.com",
        },
      }),
    );
    expect(response.status).toBe(201);
    const accepted = await object.fetch(
      request(
        `https://relay.aimux.app/shares/invite/user_owner/${new URL(
          ((await response.json()) as { acceptUrl: string }).acceptUrl,
        ).pathname
          .split("/")
          .at(-2)!}/accept`,
        { method: "POST", userId: "user_guest", name: "Guest", email: "guest@example.com" },
      ),
    );
    expect(accepted.status).toBe(200);
    return ((await accepted.json()) as { share: { id: string } }).share.id;
  }

  /// Invite and accept one more participant onto an existing share.
  async function addGuest(object: RelayObject, userId: string, email: string): Promise<void> {
    const invited = await object.fetch(
      request("https://relay.aimux.app/shares/invite", {
        method: "POST",
        userId: "user_owner",
        name: "Owner",
        email: "owner@example.com",
        body: {
          projectRoot: "/Users/sam/cs/tealstreet-next",
          serviceEndpoint: { host: "127.0.0.1", port: 44659 },
          machineId: "mini",
          sessionId: "claude-psmp2r",
          email,
        },
      }),
    );
    expect(invited.status).toBe(201);
    const accepted = await object.fetch(
      request(
        `https://relay.aimux.app/shares/invite/user_owner/${new URL(
          ((await invited.json()) as { acceptUrl: string }).acceptUrl,
        ).pathname
          .split("/")
          .at(-2)!}/accept`,
        { method: "POST", userId, name: userId, email },
      ),
    );
    expect(accepted.status).toBe(200);
  }

  function storedEndpoint(storage: MemoryStorage, shareId: string) {
    return storage
      .get<{ shares: Record<string, { serviceEndpoint?: { host: string; port: number } }> }>("sharing-state:v1")
      .then((state) => state!.shares[shareId].serviceEndpoint);
  }

  // The daemon builds this frame in Rust and asserts the same file. Neither
  // side's own tests would notice a renamed field, and the relay answers
  // nothing, so a mismatch would be silent -- every share would stay on the
  // port its invite was written with, which is the bug the frame exists to
  // fix.
  it("reads the frame shape the daemon actually sends", async () => {
    const upserted: { userId: string; port?: number }[] = [];
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted));
    const contractProject = projectEndpointsContract.example.projects[0];
    const shareId = await shareBoundTo(object, "mini", 44659, "claude-psmp2r", contractProject.projectRoot);
    upserted.length = 0;

    const daemon = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    storage.sockets = [daemon];
    await object.webSocketMessage(daemon, JSON.stringify(projectEndpointsContract.example.frame));

    expect(await storedEndpoint(storage, shareId)).toEqual({
      host: contractProject.host,
      port: contractProject.port,
    });
    expect(upserted).toEqual([{ userId: "user_guest", port: contractProject.port }]);
  });

  it("caps the report where the contract says it is capped", () => {
    expect(MAX_PROJECT_ENDPOINT_REPORTS).toBe(projectEndpointsContract.maxProjectsPerFrame);
  });

  const endpointsFrame = (port: number) =>
    JSON.stringify({
      type: "project_endpoints",
      projects: [{ projectRoot: "/Users/sam/cs/tealstreet-next", host: "127.0.0.1", port }],
    });

  it("moves the stored endpoint and pushes it to the guests holding a copy", async () => {
    const upserted: { userId: string; port?: number }[] = [];
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted));
    const shareId = await shareBoundTo(object, "mini", 44659);
    upserted.length = 0;

    const daemon = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    storage.sockets = [daemon];
    await object.webSocketMessage(daemon, endpointsFrame(49226));

    expect(await storedEndpoint(storage, shareId)).toEqual({ host: "127.0.0.1", port: 49226 });
    // A guest reads its own object's cached copy, so saving the canonical
    // record here only fixes the owner -- without the push the guest keeps
    // proxying to the dead port, which is the same bug one hop over.
    expect(upserted).toEqual([{ userId: "user_guest", port: 49226 }]);
  });

  it("writes nothing when the service is still on the port the share has", async () => {
    // This frame arrives on every daemon connect. Saving storage and fanning
    // out to every guest each time would be a write per reconnect, and the
    // relay's edge reconnects tens of times a day.
    const upserted: { userId: string; port?: number }[] = [];
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted));
    await shareBoundTo(object, "mini", 49226);
    upserted.length = 0;

    const daemon = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    storage.sockets = [daemon];
    // The first report teaches the object which machine holds this checkout,
    // which is a real change and is written. Steady state is the second one.
    await object.webSocketMessage(daemon, endpointsFrame(49226));
    const put = vi.spyOn(storage, "put");
    await object.webSocketMessage(daemon, endpointsFrame(49226));

    expect(put).not.toHaveBeenCalled();
    expect(upserted).toEqual([]);
    put.mockRestore();
  });

  // Round 3's rule for a share that names no host, through the route rather
  // than through the helper: hardcoding the caller's flag to either value
  // used to leave the whole suite green, so the rule was a comment as far as
  // the tests were concerned -- the un-updated-caller class exactly.
  it("moves a share with no host when the reporting daemon is the only machine", async () => {
    const upserted: { userId: string; port?: number }[] = [];
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted));
    const shareId = await shareBoundTo(object, undefined, 44659);
    upserted.length = 0;

    const daemon = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    storage.sockets = [daemon];
    await object.webSocketMessage(daemon, endpointsFrame(49226));

    expect(await storedEndpoint(storage, shareId)).toEqual({ host: "127.0.0.1", port: 49226 });
    expect(upserted).toEqual([{ userId: "user_guest", port: 49226 }]);
  });

  it("leaves a share with no host alone while a second daemon is connected", async () => {
    // Unroutable either way with two machines up, so moving its endpoint
    // could only be a guess -- and the two machines would take turns, every
    // turn a durable write and a push to every guest.
    const upserted: { userId: string; port?: number }[] = [];
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted));
    const shareId = await shareBoundTo(object, undefined, 44659);
    upserted.length = 0;

    const mini = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    const mbp2 = fakeSocket(["daemon", "user:user_owner", "machine:mbp2", "machineName:sam-mbp2"]);
    storage.sockets = [mini, mbp2];
    // Once to teach it the roots, as above; the assertion is about the share.
    await object.webSocketMessage(mini, endpointsFrame(49226));
    const put = vi.spyOn(storage, "put");
    await object.webSocketMessage(mini, endpointsFrame(49226));

    expect(await storedEndpoint(storage, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
    expect(upserted).toEqual([]);
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();
  });

  // One machine connected is not the same fact as "this sender is it". A
  // socket can be superseded or evicted while a frame it sent is still being
  // handled, and then the account's one machine is somebody else -- who this
  // daemon may not speak for.
  it("will not speak for a share with no host when the one machine is somebody else", async () => {
    const upserted: { userId: string; port?: number }[] = [];
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted));
    const shareId = await shareBoundTo(object, undefined, 44659);
    upserted.length = 0;

    const mbp2 = fakeSocket(["daemon", "user:user_owner", "machine:mbp2", "machineName:sam-mbp2"]);
    // Deliberately absent from the socket list: this is the superseded one.
    const gone = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    storage.sockets = [mbp2];
    await object.webSocketMessage(gone, endpointsFrame(49226));

    expect(await storedEndpoint(storage, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
    expect(upserted).toEqual([]);
  });

  // A daemon that connected without a usable machine id is tagged
  // `unidentified`. Reading that as "claims no machine" let it move every
  // machine-bound share in the account onto its own ports.
  it("will not move a machine-bound share for a daemon with no machine identity", async () => {
    const upserted: { userId: string; port?: number }[] = [];
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted));
    const shareId = await shareBoundTo(object, "mini", 44659);
    upserted.length = 0;

    const nameless = fakeSocket(["daemon", "user:user_owner", "machine:unidentified"]);
    storage.sockets = [nameless];
    await object.webSocketMessage(nameless, endpointsFrame(49226));

    expect(await storedEndpoint(storage, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
    expect(upserted).toEqual([]);
  });

  // Which shares these are is read from the socket's own tags. A daemon that
  // claims someone else's project in the frame must not move their share.
  it("will not move a share the sending machine does not hold", async () => {
    const upserted: { userId: string; port?: number }[] = [];
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted));
    const shareId = await shareBoundTo(object, "mini", 44659);
    upserted.length = 0;

    const other = fakeSocket(["daemon", "user:user_owner", "machine:mbp2", "machineName:sam-mbp2"]);
    storage.sockets = [other];
    await object.webSocketMessage(other, endpointsFrame(49226));

    expect(await storedEndpoint(storage, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
    expect(upserted).toEqual([]);
  });

  // A guest routes on the copy in ITS object, so a refresh that failed leaves
  // that guest on the dead port while the owner's record is right -- and the
  // endpoint comparison would then never look at that share again, because by
  // then it matches every report.
  it("retries a receiver whose own copy could not be refreshed", async () => {
    const upserted: { userId: string; port?: number }[] = [];
    const receiverDown = { value: false };
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted, receiverDown));
    const shareId = await shareBoundTo(object, "mini", 44659);
    upserted.length = 0;

    const daemon = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    storage.sockets = [daemon];

    // The move lands on the owner's record, but the guest's object is down.
    receiverDown.value = true;
    await object.webSocketMessage(daemon, endpointsFrame(49226));
    expect(await storedEndpoint(storage, shareId)).toEqual({ host: "127.0.0.1", port: 49226 });
    expect(upserted).toEqual([]);

    // While that guest is still down, a repeat report retries it and finds
    // nothing new to record -- so it must not write storage. This report
    // arrives every thirty seconds and on every daemon connect.
    const put = vi.spyOn(storage, "put");
    await object.webSocketMessage(daemon, endpointsFrame(49226));
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();

    // The guest's object recovers. The next report moves nothing at all, and
    // has to reach that guest anyway.
    receiverDown.value = false;
    await object.webSocketMessage(daemon, endpointsFrame(49226));
    expect(upserted).toEqual([{ userId: "user_guest", port: 49226 }]);

    // And once it has landed, the share stops being retried.
    upserted.length = 0;
    await object.webSocketMessage(daemon, endpointsFrame(49226));
    expect(upserted).toEqual([]);
  });

  // The owed list is compared with the one on the record to decide whether
  // anything changed. Participants come back in acceptance order, so on a
  // share whose guests were accepted out of alphabetical order an unsorted
  // list reads as a change every time -- a storage write every thirty
  // seconds, for ever, recording the same two failures.
  it("does not write storage again when the same guests fail in a different order", async () => {
    const upserted: { userId: string; port?: number }[] = [];
    const receiverDown = { value: false };
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted, receiverDown));
    const shareId = await shareBoundTo(object, "mini", 44659);
    // Accepted second, sorts first.
    await addGuest(object, "user_aaa", "aaa@example.com");

    const daemon = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    storage.sockets = [daemon];

    receiverDown.value = true;
    await object.webSocketMessage(daemon, endpointsFrame(49226));
    const stored = await storage.get<{
      shares: Record<string, { staleReceivers?: string[] }>;
    }>("sharing-state:v1");
    expect(stored!.shares[shareId].staleReceivers).toEqual(["user_aaa", "user_guest"]);

    // Same two guests, same failure, nothing new to record.
    const put = vi.spyOn(storage, "put");
    await object.webSocketMessage(daemon, endpointsFrame(49226));
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();
  });

  // A bounded budget taken from the front of the list every time is a budget
  // one permanently unreachable guest owns for ever: the shares behind it are
  // never attempted at all, which is the original bug for everyone on them.
  it("works through every owed share rather than retrying the same ones", async () => {
    const upserted: { userId: string; port?: number }[] = [];
    const attempted: string[] = [];
    // Reachable while the shares are made -- accepting an invite writes the
    // guest's own index, and that has to succeed for the share to exist.
    const receiverDown = { value: false };
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted, receiverDown, attempted));

    const shareIds: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      shareIds.push(await shareBoundTo(object, "mini", 44659, `claude-${index}`));
    }
    attempted.length = 0;
    upserted.length = 0;
    receiverDown.value = true;

    const daemon = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    storage.sockets = [daemon];

    // Every guest is unreachable, so every share stays owed. Three reports.
    for (let report = 0; report < 3; report += 1) {
      await object.webSocketMessage(daemon, endpointsFrame(49226));
    }

    expect(attempted.length).toBe(60);
    expect(new Set(attempted).size, "every owed share was attempted").toBe(shareIds.length);
    expect(upserted).toEqual([]);
  });

  // Each refresh is a cross-object fetch per guest, and the retry means a
  // report that moves nothing can still owe one on every share it matched.
  // A machine reports every thirty seconds.
  it("refreshes a bounded number of shares per report, and carries the rest over", async () => {
    const upserted: { userId: string; port?: number }[] = [];
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted));

    // Thirty shares on one root, all bound to the same machine.
    const shareIds: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      shareIds.push(await shareBoundTo(object, "mini", 44659, `claude-${index}`));
    }
    upserted.length = 0;

    const daemon = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    storage.sockets = [daemon];
    await object.webSocketMessage(daemon, endpointsFrame(49226));

    expect(upserted.length).toBe(20);
    // Every share still moved -- the cap is on the guest fan-out, not on the
    // record, so no share is left pointing at the dead port.
    for (const shareId of shareIds) {
      expect(await storedEndpoint(storage, shareId)).toEqual({ host: "127.0.0.1", port: 49226 });
    }

    // The ten left over are owed, and go out on the next report even though
    // that report moves nothing.
    upserted.length = 0;
    await object.webSocketMessage(daemon, endpointsFrame(49226));
    expect(upserted.length).toBe(10);
  });

  // Routing a guest's request needs the sharing state, and so does deciding
  // whether the guest may make it. Loading it twice is two reads of the same
  // record inside one request, on the hot path of every poll a shared chat
  // makes -- and the two reads could disagree, since a write can land between
  // them.
  it("reads the sharing state once to answer one guest request", async () => {
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording([]));
    const shareId = await shareBoundTo(object, undefined, 44659);

    const daemon = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    const guest = fakeSocket(["client", `share:${shareId}`, "user:user_guest"]);
    storage.sockets = [daemon, guest];
    await object.webSocketMessage(daemon, endpointsFrame(44659));

    storage.reads.clear();
    await object.webSocketMessage(
      guest,
      JSON.stringify({
        id: "req-1",
        type: "request",
        method: "GET",
        path: "/proxy/127.0.0.1/44659/agents/history?sessionId=claude-psmp2r",
      }),
    );

    expect(JSON.parse(String(daemon.send.mock.calls.at(-1)?.[0]))).toMatchObject({
      type: "request",
    });
    expect(storage.reads.get("sharing-state:v1")).toBe(1);
  });

  // The SECOND route that resolves a shared target. The first version of the
  // gate above covered only the request route, so reverting this one to load
  // the state again left the suite green -- the un-updated-caller class, on
  // the gate written to catch it.
  it("reads the sharing state once to answer a guest's event subscription", async () => {
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording([]));
    const shareId = await shareBoundTo(object, undefined, 44659);

    const daemon = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    const guest = fakeSocket(["client", `share:${shareId}`, "user:user_guest"]);
    storage.sockets = [daemon, guest];
    await object.webSocketMessage(daemon, endpointsFrame(44659));
    daemon.send.mockClear();

    storage.reads.clear();
    await object.webSocketMessage(
      guest,
      JSON.stringify({
        id: "sub-1",
        type: "project_events_subscribe",
        path: "/proxy/127.0.0.1/44659/events?sessionId=claude-psmp2r",
      }),
    );

    const errors = guest.send.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .filter((frame) => frame.type === "project_events_error");
    expect(errors, `the subscription must route: ${JSON.stringify(errors)}`).toEqual([]);
    expect(storage.reads.get("sharing-state:v1")).toBe(1);
  });

  // The eviction rule proved through the REPORT ROUTE, not by calling the
  // helper with the option. Deleting the wiring that tells it who is
  // connected left the helper's own tests green -- the un-updated-caller
  // class, on the commit that said it had closed exactly that.
  it("keeps a reporting host that a full index would otherwise evict", async () => {
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording([]));
    const shareId = await shareBoundTo(object, undefined, 44659);

    // A hundred ids nothing is connected to any more -- what `ephemeral`
    // leaves behind, one per restart that could not read its identity file.
    const stored = await storage.get<Record<string, unknown>>("sharing-state:v1");
    const machineProjectRoots: Record<string, string[]> = {};
    for (let index = 0; index < 100; index += 1) {
      machineProjectRoots[`zz-stale-${String(index).padStart(3, "0")}`] = [`/Users/sam/cs/old-${index}`];
    }
    await storage.put("sharing-state:v1", { ...stored, machineProjectRoots });

    // Both live ids sort BEFORE every stale one, so eviction by id alone
    // takes the host as soon as it is not the machine reporting.
    const host = fakeSocket(["daemon", "user:user_owner", "machine:aaa-host", "machineName:sam-host"]);
    const other = fakeSocket(["daemon", "user:user_owner", "machine:aab-other", "machineName:sam-other"]);
    const guest = fakeSocket(["client", `share:${shareId}`, "user:user_guest"]);
    storage.sockets = [host, other, guest];
    await object.webSocketMessage(host, endpointsFrame(44659));
    await object.webSocketMessage(
      other,
      JSON.stringify({
        type: "project_endpoints",
        projects: [{ projectRoot: "/Users/sam/cs/aimux", host: "127.0.0.1", port: 43001 }],
      }),
    );
    host.send.mockClear();
    other.send.mockClear();

    await object.webSocketMessage(
      guest,
      JSON.stringify({
        id: "req-1",
        type: "request",
        method: "GET",
        path: "/proxy/127.0.0.1/44659/agents/history?sessionId=claude-psmp2r",
      }),
    );

    const refusals = guest.send.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .filter((frame) => frame.type === "response" && frame.status >= 400);
    expect(refusals, `a full index must not refuse the host that reported: ${JSON.stringify(refusals)}`).toEqual([]);
    expect(JSON.parse(String(host.send.mock.calls.at(-1)?.[0]))).toMatchObject({ type: "request" });
    expect(other.send).not.toHaveBeenCalled();
  });

  // What the "widened" answer actually does, stated rather than assumed. An
  // unreadable report index, or a machine the ceiling evicted, puts every
  // connected machine back in the running -- and that is the PRE-report
  // behaviour, which refuses as soon as there is more than one candidate. So
  // widening is the safe direction only in the sense that it cannot send a
  // guest to the wrong host; it is not harmless.
  it("routes a widened share with one machine up and refuses it with two", async () => {
    for (const machines of [["mini"], ["mini", "mbp2"]]) {
      const storage = storageWithSockets([]);
      const object = createObject(storage, envRecording([]));
      const shareId = await shareBoundTo(object, undefined, 44659);
      const sockets = machines.map((id) =>
        fakeSocket(["daemon", `user:user_owner`, `machine:${id}`, `machineName:sam-${id}`]),
      );
      const guest = fakeSocket(["client", `share:${shareId}`, "user:user_guest"]);
      storage.sockets = [...sockets, guest];
      // No endpoint report at all, so nothing has claimed the root.

      await object.webSocketMessage(
        guest,
        JSON.stringify({
          id: "req-1",
          type: "request",
          method: "GET",
          path: "/proxy/127.0.0.1/44659/agents/history?sessionId=claude-psmp2r",
        }),
      );

      const refusals = guest.send.mock.calls
        .map((call) => JSON.parse(String(call[0])))
        .filter((frame) => frame.type === "response" && frame.status >= 400);
      if (machines.length === 1) {
        expect(refusals, `one machine up must route: ${JSON.stringify(refusals)}`).toEqual([]);
      } else {
        expect(refusals).toHaveLength(1);
        expect(refusals[0].status).toBe(503);
      }
    }
  });

  // A share that names no host used to route only while exactly ONE machine
  // was connected, so starting a second daemon anywhere killed it -- with an
  // error saying the machine hosting it was not connected, while that machine
  // was right there. The reports say which machine has the checkout, and this
  // is the route actually using them.
  it("routes a share with no host to the machine that reported its checkout", async () => {
    const upserted: { userId: string; port?: number }[] = [];
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted));
    const shareId = await shareBoundTo(object, undefined, 44659);

    const mini = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    const mbp2 = fakeSocket(["daemon", "user:user_owner", "machine:mbp2", "machineName:sam-mbp2"]);
    const guest = fakeSocket(["client", `share:${shareId}`, "user:user_guest"]);
    storage.sockets = [mini, mbp2, guest];

    // Only the mini has this checkout, and says so.
    await object.webSocketMessage(mini, endpointsFrame(44659));
    mini.send.mockClear();

    await object.webSocketMessage(
      guest,
      JSON.stringify({
        id: "req-1",
        type: "request",
        method: "GET",
        path: "/proxy/127.0.0.1/44659/agents/history?sessionId=claude-psmp2r",
      }),
    );

    const refusals = guest.send.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .filter((frame) => frame.type === "response" && frame.status >= 400);
    expect(refusals, `two machines up must not make this unroutable: ${JSON.stringify(refusals)}`).toEqual([]);
    expect(JSON.parse(String(mini.send.mock.calls.at(-1)?.[0]))).toMatchObject({ type: "request" });
    expect(mbp2.send).not.toHaveBeenCalled();
  });

  // Each entry is a pass over every share this object holds, so an unbounded
  // array is unbounded work inside one request.
  it("reads at most a fleet's worth of endpoints from one frame", async () => {
    const upserted: { userId: string; port?: number }[] = [];
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted));
    const shareId = await shareBoundTo(object, "mini", 44659);
    upserted.length = 0;

    const daemon = fakeSocket(["daemon", "user:user_owner", "machine:mini", "machineName:sam-mini"]);
    storage.sockets = [daemon];
    // The real entry sits past the cap, behind a thousand decoys.
    await object.webSocketMessage(
      daemon,
      JSON.stringify({
        type: "project_endpoints",
        projects: [
          ...Array.from({ length: 1_000 }, (_, index) => ({
            projectRoot: `/decoy/${index}`,
            host: "127.0.0.1",
            port: 1_024 + index,
          })),
          { projectRoot: "/Users/sam/cs/tealstreet-next", host: "127.0.0.1", port: 49226 },
        ],
      }),
    );

    expect(await storedEndpoint(storage, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
    expect(upserted).toEqual([]);
  });

  // Anything a client sends is a claim about itself, and this frame rewrites
  // where every share for a project points.
  it("ignores the frame from a client socket", async () => {
    const upserted: { userId: string; port?: number }[] = [];
    const storage = storageWithSockets([]);
    const object = createObject(storage, envRecording(upserted));
    // Every other rule in the path has to say yes, or this proves nothing
    // about the daemon check -- which is what it had quietly become. So: a
    // share that names no host, and one connected daemon as nameless as a
    // client socket is, which makes the single-machine rule agree that this
    // sender speaks for the account. The daemon check is then the only thing
    // between the frame and the write.
    const shareId = await shareBoundTo(object, undefined, 44659);
    upserted.length = 0;

    const nameless = fakeSocket(["daemon", "user:user_owner", "machine:unidentified"]);
    const client = fakeSocket(["client", "user:user_owner", "device:client_1"]);
    storage.sockets = [nameless, client];
    await object.webSocketMessage(client, endpointsFrame(49226));

    expect(await storedEndpoint(storage, shareId)).toEqual({ host: "127.0.0.1", port: 44659 });
    expect(upserted).toEqual([]);
  });
});

async function createAcceptedShareInOwnerObject(object: RelayObject, machineId?: string): Promise<string> {
  const invite = await createInvite(object, machineId);
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

async function createInvite(object: RelayObject, machineId?: string): Promise<{ token: string }> {
  const response = await object.fetch(
    request("https://relay.aimux.app/shares/invite", {
      method: "POST",
      userId: "user_owner",
      name: "Owner",
      email: "owner@example.com",
      body: {
        projectRoot: "/Users/sam/cs/scratch",
        serviceEndpoint: { host: "relay.aimux.app", port: 443 },
        ...(machineId ? { machineId } : {}),
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

  function daemonSocket(machineId: string, machineName: string, connectedSeq?: number) {
    return fakeSocket([
      "daemon",
      "user:user_owner",
      `machine:${machineId}`,
      `machineName:${machineName}`,
      ...(connectedSeq === undefined ? [] : [`conn:${connectedSeq}`]),
    ]);
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

  // sam-mini flapped for days: 88 of its last 100 closes were `1000 Replaced`,
  // each within two seconds of connecting, while the daemon logged ZERO runner
  // replacements. The relay was evicting the socket it had just accepted.
  //
  // `rehydrateSockets` decided which of two sockets for one machine was newer
  // by their position in `getWebSockets()`, which Cloudflare does not document
  // as ordered. Rebuilt in the other order -- which is what hibernation can
  // hand back -- it kept the dead socket and closed the live one, so the
  // daemon reconnected into the same verdict for ever.
  it("keeps the newest daemon socket however getWebSockets orders them", async () => {
    for (const order of ["accept", "reversed"] as const) {
      const stale = daemonSocket("mini", "sam-mini", 1);
      const live = daemonSocket("mini", "sam-mini", 2);
      const sockets = order === "accept" ? [stale, live] : [live, stale];
      const object = createObject(storageWithSockets(sockets), {} as unknown as Env);

      await object.webSocketMessage(live, JSON.stringify({ type: "ping" }));

      expect(live.close, `live socket closed when rebuilt in ${order} order`).not.toHaveBeenCalled();
      expect(stale.close, `stale socket survived in ${order} order`).toHaveBeenCalledWith(1000, "Replaced");
    }
  });

  // A socket whose peer vanished can sit in `getWebSockets()` long after it is
  // useless, and every message rebuilds these maps from that list. Closing
  // that corpse was marking the machine superseded on EVERY message and
  // failing the work registered in the same pass -- so the daemon stayed
  // connected and reported `online: true` while every request through it came
  // back 502 "Daemon connection replaced", for ever. That is what sam-mini
  // looked like from the browser: one disconnect in the daemon log, a healthy
  // relay, and a shared chat that could not load a single thing.
  it("does not fail work for a machine that still has a live socket", async () => {
    const stale = daemonSocket("mini", "sam-mini", 1);
    const live = daemonSocket("mini", "sam-mini", 2);
    const client = fakeSocket(["client", "device:client_1"]);
    const storage = storageWithSockets([stale, live, client]);
    const object = createObject(storage, {} as unknown as Env);

    await object.webSocketMessage(
      client,
      JSON.stringify({ id: "req-1", type: "request", method: "GET", path: "/projects", machineId: "mini" }),
    );
    expect(JSON.parse(String(live.send.mock.calls.at(-1)?.[0]))).toMatchObject({
      type: "request",
      path: "/projects",
    });
    client.send.mockClear();

    // The second message is where this bit: the request is no longer a local
    // variable, it is rebuilt from the socket's attachment by the rebuild
    // that the message triggers -- and was then failed by that same rebuild,
    // before the daemon it was sent to ever had a chance to answer.
    await object.webSocketMessage(client, JSON.stringify({ type: "ping" }));

    const answers = client.send.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .filter((frame) => frame.type === "response");
    expect(answers, `the live socket can still answer: ${JSON.stringify(answers)}`).toEqual([]);
    expect(stale.close).toHaveBeenCalledWith(1000, "Replaced");
  });

  // The other direction, where a replacement really is a loss: a NEW daemon
  // socket arrives for a machine that already had one. That socket never had
  // the old one's work, so the connect path fails it rather than leaving the
  // client to wait out the request TTL.
  it("fails work when a new daemon connection replaces the old one", async () => {
    const original = daemonSocket("mini", "sam-mini", 1);
    const client = fakeSocket(["client", "device:client_1"]);
    const storage = storageWithSockets([original, client]);
    const object = createObject(storage, {} as unknown as Env);
    await object.webSocketMessage(
      client,
      JSON.stringify({ id: "req-1", type: "request", method: "GET", path: "/projects", machineId: "mini" }),
    );
    client.send.mockClear();

    await connectDaemon(object, "?machineId=mini&machineName=sam-mini");

    const answers = client.send.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .filter((frame) => frame.type === "response" && frame.status === 502);
    expect(answers.length, "the client is told, not left to time out").toBeGreaterThan(0);
  });

  // The rule above reads recency off a tag, so the connect path has to write
  // one. Without this the sockets in production all tie as unsequenced and the
  // decision silently falls back to `getWebSockets()` order -- the exact bug,
  // with the test above still green because it tags its sockets by hand.
  it("stamps each accepted daemon socket with a rising connection sequence", async () => {
    const acceptedTagSets: string[][] = [];
    const object = createObject(storageWithSockets([]), {} as unknown as Env, acceptedTagSets);

    await connectDaemon(object, "?machineId=mini&machineName=sam-mini");
    await connectDaemon(object, "?machineId=mini&machineName=sam-mini");

    const sequences = acceptedTagSets.map((set) => connectionSequenceFromTags(set));
    expect(sequences).toHaveLength(2);
    expect(sequences[0]).toBeGreaterThan(UNSEQUENCED_CONNECTION);
    expect(sequences[1]).toBeGreaterThan(sequences[0]);
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

  // "Any machine is up" is a fact about a fleet the guest cannot see, and the
  // wrong answer about the one host it can.
  it("tells a shared guest whether its own host is up, not the fleet", async () => {
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
    // Bound in storage, which is the record routing reads. It used to come
    // from a tag frozen at connect, so a share bound to a host mid-session
    // left the indicator and the requests answering from different records.
    const sharing = await storage.get<{
      shares: Record<string, { machineId?: string }>;
    }>("sharing-state:v1");
    sharing!.shares[shareId].machineId = "strix";
    await storage.put("sharing-state:v1", sharing);
    const guestOnStrix = fakeSocket(["client", `share:${shareId}`, "user:user_guest"]);
    storage.sockets = [mbp, strix, guestOnStrix];

    await object.webSocketClose(strix);

    expect(lastSentTo(guestOnStrix)).toEqual({ type: "daemon_status", online: false });
  });

  // The tag that used to answer this was frozen at connect and Workers tags
  // cannot be changed, so binding a share to a host mid-session left the
  // guest's indicator reading one record while its requests read another --
  // first saying connected while every request was refused, then, once the
  // indicator was made strict, saying offline while routing would have worked.
  it("follows a share bound to a host after the guest connected", async () => {
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
    // Connected while the share named no host, so no tag could have been set.
    const guest = fakeSocket(["client", `share:${shareId}`, "user:user_guest"]);
    storage.sockets = [mbp, strix, guest];

    const sharing = await storage.get<{
      shares: Record<string, { machineId?: string }>;
    }>("sharing-state:v1");
    sharing!.shares[shareId].machineId = "mbp";
    await storage.put("sharing-state:v1", sharing);

    // Its host is up, so it is online -- a strict read of the absent tag made
    // this false and locked the guest out of a share that routed fine.
    await object.webSocketClose(strix);
    expect(lastSentTo(guest)).toEqual({ type: "daemon_status", online: true });
  });

  // Nothing routes to a share that has gone, so neither does the indicator.
  it("tells a guest its host is offline once the share is revoked", async () => {
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

    await storage.put("sharing-state:v1", { version: 1, shares: {} });

    await object.webSocketClose(strix);
    expect(lastSentTo(guest)).toEqual({ type: "daemon_status", online: false });
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
      body: {
        ok: false,
        error: "The machine hosting this shared chat is not connected",
        machines: [],
      },
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

  // An owner client that asked before `daemon_status` named the fleet had no
  // machine to attribute the answer to, so its projects arrived bare and the
  // next poll re-keyed every project-scoped atom -- remounting the chat view
  // seconds after it opened. A guest is told nothing: a share names one host
  // and must not become a window onto the account.
  it("tells an owner which machine answered, and a guest nothing", async () => {
    const mbp = daemonSocket("mbp", "sam-mbp");
    const storage = storageWithSockets([mbp]);
    const object = createObject(storage, {
      RELAY: {
        idFromName: vi.fn((name: string) => ({ name })),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response("{}", { status: 200 })) })),
      },
    } as unknown as Env);
    const shareId = await createAcceptedShareInOwnerObject(object);
    const owner = fakeSocket(["client", "device:client_1", "user:user_owner"]);
    const guest = fakeSocket(["client", `share:${shareId}`, "user:user_guest"]);
    storage.sockets = [mbp, owner, guest];
    const sharing = await storage.get<{
      shares: Record<string, { sessionId: string; machineId?: string }>;
    }>("sharing-state:v1");
    sharing!.shares[shareId].machineId = "mbp";
    await storage.put("sharing-state:v1", sharing);
    const sharedPath = `/agents/history?sessionId=${sharing!.shares[shareId].sessionId}`;

    for (const [socket, path] of [
      [owner, "/projects"],
      [guest, sharedPath],
    ] as const) {
      mbp.send.mockClear();
      await object.webSocketMessage(socket, JSON.stringify({ id: "req-1", type: "request", method: "GET", path }));
      const forwarded = JSON.parse(String(mbp.send.mock.calls[0][0])) as { id: string };
      await object.webSocketMessage(
        mbp,
        JSON.stringify({ id: forwarded.id, type: "response", status: 200, body: { ok: true } }),
      );
    }

    expect(lastSentTo(owner)).toEqual({
      id: "req-1",
      type: "response",
      status: 200,
      body: { ok: true },
      machineId: "mbp",
    });
    expect(lastSentTo(guest)).toEqual({
      id: "req-1",
      type: "response",
      status: 200,
      body: { ok: true },
    });
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
