import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWrite } from "./atomic-write.js";
import { hashPrompt } from "./hosted-audit.js";
import { DEFAULT_HOSTED_CONFIG, type HostedConfig } from "./hosted-config.js";
import { resetHostedLockdownCache, setHostedLockdown } from "./hosted-lockdown.js";
import { createHostedPrincipal, loadHostedPrincipals, revokeHostedPrincipal } from "./hosted-principals.js";
import { startHostedServer, type HostedServerHandle } from "./hosted-server.js";
import { getHostedAuditPath, getHostedAuditPromptsPath, getHostedPrincipalsPath } from "./paths.js";
import type { RemoteActor } from "./remote-access.js";

let previousAimuxHome: string | undefined;
let aimuxHome = "";
let server: HostedServerHandle | null = null;
let seen: Array<{ actor: RemoteActor; method: string; path: string; body?: unknown }> = [];

const config: HostedConfig = { ...DEFAULT_HOSTED_CONFIG, enabled: true, port: 0, maxPromptBytes: 256 };

async function start(overrides: Partial<HostedConfig> = {}, response?: () => { status: number; body: unknown }) {
  server = await startHostedServer({
    config: { ...config, ...overrides },
    routeHostedRequest: async (actor, method, path, body) => {
      seen.push({ actor, method, path, body });
      return response ? response() : { status: 200, body: { ok: true, echoed: body ?? null } };
    },
  });
  return server;
}

function url(handle: HostedServerHandle, path: string): string {
  return `http://127.0.0.1:${handle.port}${path}`;
}

beforeEach(() => {
  previousAimuxHome = process.env.AIMUX_HOME;
  aimuxHome = mkdtempSync(join(tmpdir(), "aimux-hosted-server-"));
  process.env.AIMUX_HOME = aimuxHome;
  seen = [];
});

afterEach(async () => {
  await server?.close();
  server = null;
  if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
  else process.env.AIMUX_HOME = previousAimuxHome;
  rmSync(aimuxHome, { recursive: true, force: true });
});

describe("hosted listener", () => {
  it("serves health without a credential and without reaching the daemon", async () => {
    const handle = await start();
    const res = await fetch(url(handle, "/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: "hosted", lockdown: false });
    expect(seen).toHaveLength(0);
  });

  it("rejects an unauthenticated request identically to an unknown token", async () => {
    const handle = await start();
    const anonymous = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"));
    const wrong = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: "Bearer amx_nope" },
    });

    expect(anonymous.status).toBe(401);
    expect(wrong.status).toBe(401);
    // Identical bodies: a prober must not learn whether a token was recognised.
    expect(await anonymous.json()).toEqual(await wrong.json());
    expect(seen).toHaveLength(0);
  });

  it("refuses a forged actor header outright", async () => {
    const handle = await start();
    const res = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { "x-aimux-actor-role": "owner", "x-aimux-actor-user-id": "attacker" },
    });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("forwards an authenticated request with a server-minted operator actor", async () => {
    const { token, principal } = createHostedPrincipal({ label: "grand" });
    const handle = await start();

    const res = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.actor.role).toBe("operator");
    expect(seen[0]!.actor.principal?.id).toBe(principal.id);
    expect(seen[0]!.path).toBe("/proxy/127.0.0.1/43210/agents/output?sessionId=s");
  });

  it("stops honouring a token once it is revoked", async () => {
    const { token, principal } = createHostedPrincipal({ label: "grand" });
    const handle = await start();
    revokeHostedPrincipal(principal.id);

    const res = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("404s any path that is not the proxy form", async () => {
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start();

    for (const path of ["/agents/output", "/core/commands", "/projects/stop", "/proxy/127.0.0.1/43210"]) {
      const res = await fetch(url(handle, path), { headers: { authorization: `Bearer ${token}` } });
      expect(res.status, path).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses a body over the prompt cap", async () => {
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start({ maxPromptBytes: 64 });

    const res = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/input"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s", text: "x".repeat(500) }),
    });

    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("refuses a malformed json body", async () => {
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start();

    const res = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/input"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{ not json",
    });

    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("passes a parsed body through to the daemon", async () => {
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start();

    await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/input"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s", text: "hello" }),
    });

    expect(seen[0]!.body).toEqual({ sessionId: "s", text: "hello" });
  });

  it("refuses an upstream response over the response cap", async () => {
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start({ maxResponseBytes: 4_096 }, () => ({
      status: 200,
      body: { output: "x".repeat(10_000) },
    }));

    const res = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(502);
  });

  it("rate limits per principal", async () => {
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start({ rateLimit: { requestsPerMinute: 2, maxConcurrent: 4 } });

    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
        headers: { authorization: `Bearer ${token}` },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  it("caps concurrency per principal and releases the slot afterwards", async () => {
    const { token } = createHostedPrincipal({ label: "grand" });
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (release = resolve));

    server = await startHostedServer({
      config: { ...config, rateLimit: { requestsPerMinute: 100, maxConcurrent: 1 } },
      routeHostedRequest: async () => {
        await gate;
        return { status: 200, body: { ok: true } };
      },
    });
    const handle = server;

    const first = fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: `Bearer ${token}` },
    });
    // Give the first request time to occupy the only slot.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.status).toBe(429);

    release!();
    expect((await first).status).toBe(200);

    // Slot freed: a later request succeeds.
    const third = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(third.status).toBe(200);
  });

  it("releases the slot when the daemon call throws", async () => {
    const { token } = createHostedPrincipal({ label: "grand" });
    server = await startHostedServer({
      config: { ...config, rateLimit: { requestsPerMinute: 100, maxConcurrent: 1 } },
      routeHostedRequest: async () => {
        throw new Error("boom");
      },
    });
    const handle = server;

    const first = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.status).toBe(500);

    // A leaked slot would make this 429 forever.
    const second = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.status).toBe(500);
  });

  it("404s traversal and other odd request targets rather than reaching the daemon", async () => {
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start();

    for (const path of ["/proxy/127.0.0.1/43210/../../core/commands", "/..%2f..%2fhealth", "/proxy//43210/agents"]) {
      const res = await fetch(url(handle, path), { headers: { authorization: `Bearer ${token}` } });
      expect(res.status, path).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it("does not serve a revoked token from a cached store", async () => {
    const { token, principal } = createHostedPrincipal({ label: "grand" });
    const handle = await start();

    const before = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.status).toBe(200);

    // Written the way another process would — bypassing saveHostedPrincipals,
    // so only the stat-keyed cache invalidation can catch it. An in-process
    // revoke would pass on the cache-clear alone and prove nothing.
    const state = loadHostedPrincipals();
    const target = state.principals.find((entry) => entry.id === principal.id)!;
    target.revokedAt = new Date().toISOString();
    atomicWrite(getHostedPrincipalsPath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

    const after = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
  });

  it("frees the port on close", async () => {
    const handle = await start({ port: 0 });
    const port = handle.port;
    await handle.close();
    server = null;

    const rebound = await startHostedServer({
      config: { ...config, port },
      routeHostedRequest: async () => ({ status: 200, body: { ok: true } }),
    });
    expect(rebound.port).toBe(port);
    await rebound.close();
  });

  it("audits a request off the response path", async () => {
    const { token, principal } = createHostedPrincipal({ label: "grand" });
    const handle = await start();

    await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/input"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "assistant", text: "hello" }),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const written = readFileSync(getHostedAuditPath(), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    // The request record, not the device-sighting record written alongside it.
    const entry = written.find((line) => !line.event)!;
    expect(entry.principalId).toBe(principal.id);
    expect(entry.sessionId).toBe("assistant");
    expect(entry.status).toBe(200);
    expect(entry.promptHash).toBe(hashPrompt("hello"));

    // The first sighting of a principal is recorded even if no webhook exists.
    expect(written.some((line) => line.event === "hosted_token_first_use")).toBe(true);
  });

  it("omits prompt text from the audit when bodies are not audited", async () => {
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start({ auditPromptBodies: false });

    await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/input"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "assistant", text: "commercially sensitive" }),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const raw = readFileSync(getHostedAuditPath(), "utf-8");
    expect(raw).not.toContain("commercially sensitive");
    expect(raw).toContain(hashPrompt("commercially sensitive"));
  });

  it("never stores the body of a refused request", async () => {
    // The bug this closes: a 403 stored its full body, so a token with NO grants
    // could flood large refused requests and rotate every other operator's
    // history out of a size-rotated file.
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start({ auditPromptBodies: true }, () => ({
      status: 403,
      body: { ok: false, error: "operator is not granted this session" },
    }));

    const response = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/input"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "not-granted", text: "refused but sensitive" }),
    });
    expect(response.status).toBe(403);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(getHostedAuditPath(), "utf-8")).not.toContain("refused but sensitive");
    expect(existsSync(getHostedAuditPromptsPath())).toBe(false);
  });

  it("bounds every caller-controlled field so one record cannot be huge", async () => {
    // Rotation is size-driven, so a caller who can make records arbitrarily
    // large pushes everyone else's out of the ring. The body is not the only
    // field they choose: the session id and the request path are theirs too.
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start({ maxPromptBytes: 65_536 }, () => ({ status: 403, body: { ok: false } }));

    await fetch(url(handle, `/proxy/127.0.0.1/43210/agents/${"p".repeat(4_000)}`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s".repeat(4_000), text: "x" }),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const record = readFileSync(getHostedAuditPath(), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { path: string; sessionId: string | null })
      .find((entry) => entry.path.includes("ppp"));

    expect(record).toBeDefined();
    expect(record!.path.length).toBeLessThan(300);
    expect(record!.sessionId!.length).toBeLessThan(300);
  });

  it("audits a failed authentication without ever recording the token", async () => {
    const handle = await start();
    await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: "Bearer amx_supersecret" },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const raw = readFileSync(getHostedAuditPath(), "utf-8");
    expect(raw).toContain("hosted_auth_failed");
    expect(raw).not.toContain("amx_supersecret");
  });

  it("refuses every route under lockdown but keeps health answering", async () => {
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start();
    setHostedLockdown(true);
    resetHostedLockdownCache();

    try {
      const refused = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(refused.status).toBe(503);
      expect(seen).toHaveLength(0);

      // A closed door is not a dead box: the tunnel must still see a healthy
      // origin, or we lose the ability to observe it at all.
      const health = await fetch(url(handle, "/health"));
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, mode: "hosted", lockdown: true });

      // Unauthenticated requests get the same refusal — lockdown must not
      // become an oracle for which tokens are real.
      const anonymous = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"));
      expect(anonymous.status).toBe(503);
    } finally {
      setHostedLockdown(false);
      resetHostedLockdownCache();
    }

    const allowed = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allowed.status).toBe(200);
  });

  it("sets no CORS headers", async () => {
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start();
    const res = await fetch(url(handle, "/proxy/127.0.0.1/43210/agents/output?sessionId=s"), {
      headers: { authorization: `Bearer ${token}`, origin: "http://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
