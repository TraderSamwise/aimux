import { beforeEach, describe, expect, it, vi } from "vitest";
import { RelayObject } from "./relay-object";
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
}

describe("RelayObject sharing index repair", () => {
  let storage: MemoryStorage;
  let receiverFetch: ReturnType<typeof vi.fn>;
  let env: Env;

  beforeEach(() => {
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
    receiverFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "broken" }), { status: 500 }),
    );

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

function createObject(storage: MemoryStorage, env: Env) {
  return new RelayObject(
    {
      storage,
      getWebSockets: () => [],
      getTags: () => [],
    } as unknown as DurableObjectState,
    env,
  );
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
