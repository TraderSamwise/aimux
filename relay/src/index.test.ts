import { beforeEach, describe, expect, it, vi } from "vitest";
import relay from "./index";
import { mintDaemonToken } from "./daemon-token";
import type { Env } from "./types";

const authMocks = vi.hoisted(() => ({
  fetchClerkUserProfile: vi.fn(),
  verifyWsToken: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));

vi.mock("./auth.js", () => authMocks);

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

function allowHeaderSet(response: Response): Set<string> {
  return new Set(
    (response.headers.get("Access-Control-Allow-Headers") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean),
  );
}

describe("relay CORS", () => {
  beforeEach(() => {
    authMocks.fetchClerkUserProfile.mockReset();
    authMocks.verifyWsToken.mockReset();
  });

  it("allows sharing preflights with actor/share headers and owner mutation methods", async () => {
    const response = await relay.fetch(
      new Request("https://relay.aimux.app/shares", {
        method: "OPTIONS",
        headers: {
          Origin: "https://aimux.app",
          "Access-Control-Request-Method": "DELETE",
          "Access-Control-Request-Headers": [
            "authorization",
            "x-aimux-actor-user-id",
            "x-aimux-actor-display-name",
            "x-aimux-actor-email",
            "x-aimux-actor-role",
            "x-aimux-share-id",
            "x-aimux-share-session-id",
          ].join(","),
        },
      }),
      {} as Env,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");

    const allowedHeaders = allowHeaderSet(response);
    for (const header of [
      "authorization",
      "x-aimux-actor-user-id",
      "x-aimux-actor-display-name",
      "x-aimux-actor-email",
      "x-aimux-actor-role",
      "x-aimux-share-id",
      "x-aimux-share-session-id",
    ]) {
      expect(allowedHeaders.has(header)).toBe(true);
    }
  });

  it("keeps CLI token preflights restricted to configured origins", async () => {
    const env = { CLI_TOKEN_ALLOWED_ORIGINS: "https://aimux.app" } as Env;

    const allowed = await relay.fetch(
      new Request("https://relay.aimux.app/cli/issue-token", {
        method: "OPTIONS",
        headers: { Origin: "https://aimux.app" },
      }),
      env,
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://aimux.app");
    expect(allowed.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");

    const denied = await relay.fetch(
      new Request("https://relay.aimux.app/cli/issue-token", {
        method: "OPTIONS",
        headers: { Origin: "https://example.com" },
      }),
      env,
    );
    expect(denied.status).toBe(403);
  });

  it("adds sharing CORS headers to successful durable object responses", async () => {
    authMocks.verifyWsToken.mockResolvedValueOnce("user_123");
    authMocks.fetchClerkUserProfile.mockResolvedValueOnce({
      userId: "user_123",
      displayName: "Sam",
      email: "sam@example.com",
    });
    const objectFetch = vi.fn(async (_request: Request) => {
      return new Response(JSON.stringify({ ok: true, shares: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Aimux-Share-Mode": "multi" },
      });
    });
    const env = {
      CLERK_SECRET_KEY: "sk_test",
      RELAY: {
        idFromName: vi.fn(() => ({ name: "user_123" })),
        get: vi.fn(() => ({ fetch: objectFetch })),
      },
    } as unknown as Env;

    const response = await relay.fetch(
      new Request("https://relay.aimux.app/shares", {
        method: "GET",
        headers: { Origin: "https://aimux.app", Authorization: "Bearer clerk-token" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("X-Aimux-Share-Mode");
    expect(await response.json()).toEqual({ ok: true, shares: [] });

    const proxied = objectFetch.mock.calls[0][0];
    expect(proxied.headers.get("X-Aimux-User-Id")).toBe("user_123");
    expect(proxied.headers.get("X-Aimux-User-Name")).toBe("Sam");
    expect(proxied.headers.get("X-Aimux-User-Email")).toBe("sam@example.com");
  });

  it("forwards owner-scoped sharing routes to the owner durable object", async () => {
    authMocks.verifyWsToken.mockResolvedValueOnce("user_actor");
    authMocks.fetchClerkUserProfile.mockResolvedValueOnce({
      userId: "user_actor",
      displayName: "Sam",
      email: "sam@example.com",
    });
    const objectFetch = vi.fn(async (_request: Request) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const idFromName = vi.fn(() => ({ name: "user_owner" }));
    const env = {
      CLERK_SECRET_KEY: "sk_test",
      RELAY: {
        idFromName,
        get: vi.fn(() => ({ fetch: objectFetch })),
      },
    } as unknown as Env;

    const response = await relay.fetch(
      new Request("https://relay.aimux.app/shares/user_owner/share_123/invites/invite_123", {
        method: "DELETE",
        headers: { Origin: "https://aimux.app", Authorization: "Bearer clerk-token" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith("user_owner");
    expect(objectFetch).toHaveBeenCalledTimes(1);
    const proxied = objectFetch.mock.calls[0][0];
    expect(proxied.headers.get("X-Aimux-User-Id")).toBe("user_actor");
    expect(proxied.headers.get("X-Aimux-User-Name")).toBe("Sam");
    expect(proxied.headers.get("X-Aimux-User-Email")).toBe("sam@example.com");
    expect(proxied.headers.get("X-Aimux-Share-Owner-Id")).toBe("user_owner");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  // The first segment of a `/shares/...` path is the owner whose object holds
  // the share -- except when it is a verb. Read as an owner id, `bind` picks a
  // durable object named "bind": empty, shared by every account, and it
  // answers "no share for that session" for a share that exists.
  it("sends a verb-shaped sharing route to the caller's own object", async () => {
    authMocks.verifyWsToken.mockResolvedValueOnce("user_owner");
    authMocks.fetchClerkUserProfile.mockResolvedValueOnce({
      userId: "user_owner",
      displayName: "Sam",
      email: "sam@example.com",
    });
    const objectFetch = vi.fn(async (_request: Request) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const idFromName = vi.fn(() => ({ name: "user_owner" }));
    const env = {
      CLERK_SECRET_KEY: "sk_test",
      RELAY: { idFromName, get: vi.fn(() => ({ fetch: objectFetch })) },
    } as unknown as Env;

    const response = await relay.fetch(
      new Request("https://relay.aimux.app/shares/bind", {
        method: "POST",
        headers: { Origin: "https://aimux.app", Authorization: "Bearer clerk-token" },
        body: JSON.stringify({ projectRoot: "/repo", sessionId: "claude-1", machineId: "mbp" }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith("user_owner");
    // Nothing is a share owned by someone else, so nothing claims it is.
    expect(objectFetch.mock.calls[0][0].headers.get("X-Aimux-Share-Owner-Id")).toBeNull();
  });

  // Claiming a checkout is a thing a machine says about itself, so the
  // daemon's token carries it. A browser session has no machine to speak for,
  // and allowing one would let a phone claim a laptop's repository.
  it("lets the local CLI claim a project and refuses a browser session", async () => {
    const objectFetch = vi.fn(async (_request: Request) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const env = {
      CLERK_SECRET_KEY: "sk_test",
      RELAY_TOKEN_SECRET: "shhh",
      RELAY: { idFromName: vi.fn(() => ({ name: "user_owner" })), get: vi.fn(() => ({ fetch: objectFetch })) },
    } as unknown as Env;

    // A real daemon token, because `isDaemonToken` reads the payload rather
    // than being mocked: a test that faked it would prove nothing about the
    // branch the CLI actually takes.
    const daemonToken = await mintDaemonToken("user_owner", "shhh");
    const fromCli = await relay.fetch(
      new Request("https://relay.aimux.app/projects/claim", {
        method: "POST",
        headers: { Authorization: `Bearer ${daemonToken}` },
        body: JSON.stringify({ projectRoot: "/repo", machineId: "mbp" }),
      }),
      env,
    );
    expect(fromCli.status).toBe(200);
    expect(objectFetch.mock.calls[0][0].headers.get("X-Aimux-User-Id")).toBe("user_owner");

    authMocks.verifyWsToken.mockResolvedValue("user_owner");
    const fromBrowser = await relay.fetch(
      new Request("https://relay.aimux.app/projects/claim", {
        method: "POST",
        headers: { Authorization: "Bearer clerk-token" },
        body: JSON.stringify({ projectRoot: "/repo", machineId: "mbp" }),
      }),
      env,
    );
    expect(fromBrowser.status).toBe(403);
    expect(objectFetch).toHaveBeenCalledTimes(1);
  });

  it("allows Clerk tokens to read but not mutate owner device security", async () => {
    authMocks.verifyWsToken.mockResolvedValue("user_owner");
    const objectFetch = vi.fn(async (_request: Request) => {
      return new Response(JSON.stringify({ ok: true, devices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const env = {
      CLERK_SECRET_KEY: "sk_test",
      RELAY: {
        idFromName: vi.fn(() => ({ name: "user_owner" })),
        get: vi.fn(() => ({ fetch: objectFetch })),
      },
    } as unknown as Env;

    const read = await relay.fetch(
      new Request("https://relay.aimux.app/security/devices", {
        method: "GET",
        headers: { Authorization: "Bearer clerk-token" },
      }),
      env,
    );
    expect(read.status).toBe(200);
    expect(objectFetch).toHaveBeenCalledTimes(1);

    const approve = await relay.fetch(
      new Request("https://relay.aimux.app/security/devices/client_1/approve", {
        method: "POST",
        headers: { Authorization: "Bearer clerk-token" },
      }),
      env,
    );
    expect(approve.status).toBe(403);
    expect(await approve.json()).toMatchObject({ ok: false, error: "Device approval requires local CLI auth" });
    expect(objectFetch).toHaveBeenCalledTimes(1);
  });

  it("allows daemon-token hosted attachment uploads", async () => {
    const bucket = new FakeR2Bucket();
    const secret = "relay-secret";
    const token = await mintDaemonToken("user_owner", secret);
    const response = await relay.fetch(
      new Request("https://relay.aimux.app/attachments/hosted", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          filename: "shot.png",
          mimeType: "image/png",
          dataBase64: btoa("png-bytes"),
          sessionId: "codex-1",
        }),
      }),
      {
        RELAY_TOKEN_SECRET: secret,
        ATTACHMENTS: bucket as unknown as R2Bucket,
      } as Env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      hostedAttachment: {
        contentUrl: expect.stringMatching(
          /^https:\/\/relay\.aimux\.app\/attachments\/hosted\/ha_[A-Za-z0-9_-]{43}\/content$/,
        ),
        sha256: "ea80334363eed145dfeee51ebae7dc3f1cd7d0c7879f8bfd2070c061d3c33f56",
        sizeBytes: 9,
      },
    });
    expect(bucket.objects.size).toBe(1);
  });

  it("rejects non-daemon hosted attachment uploads", async () => {
    const response = await relay.fetch(
      new Request("https://relay.aimux.app/attachments/hosted", {
        method: "POST",
        headers: { authorization: "Bearer clerk-token" },
        body: JSON.stringify({}),
      }),
      { ATTACHMENTS: new FakeR2Bucket() as unknown as R2Bucket } as Env,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "Hosted attachment upload requires local CLI auth",
    });
  });
});
