import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWrite } from "./atomic-write.js";
import { hashPrompt } from "./hosted-audit.js";
import { DEFAULT_HOSTED_CONFIG, type HostedConfig } from "./hosted-config.js";
import { resetHostedLockdownCache, setHostedLockdown } from "./hosted-lockdown.js";
import { createHostedPrincipal, loadHostedPrincipals, revokeHostedPrincipal } from "./hosted-principals.js";
import { startHostedServer, type HostedServerHandle, type StreamLimits } from "./hosted-server.js";
import { getHostedAuditPath, getHostedAuditPromptsPath, getHostedPrincipalsPath } from "./paths.js";
import type { RemoteActor } from "./remote-access.js";

let previousAimuxHome: string | undefined;
let aimuxHome = "";
let server: HostedServerHandle | null = null;
let seen: Array<{ actor: RemoteActor; method: string; path: string; body?: unknown }> = [];

const config: HostedConfig = { ...DEFAULT_HOSTED_CONFIG, enabled: true, port: 0, maxPromptBytes: 256 };

async function start(
  overrides: Partial<HostedConfig> = {},
  response?: () => { status: number; body: unknown },
  resolveHostedStream?: (
    actor: RemoteActor,
    method: string,
    path: string,
  ) => { ok: true; url: string } | { ok: false; status: number; error: string },
  streamLimits?: Partial<StreamLimits>,
) {
  server = await startHostedServer({
    config: { ...config, ...overrides },
    routeHostedRequest: async (actor, method, path, body) => {
      seen.push({ actor, method, path, body });
      return response ? response() : { status: 200, body: { ok: true, echoed: body ?? null } };
    },
    resolveHostedStream,
    streamLimits,
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

describe("hosted streaming", () => {
  let upstream: import("node:http").Server | null = null;
  let upstreamPort = 0;
  let upstreamAborts = 0;
  let upstreamOpens = 0;
  const upstreamSockets = new Set<import("node:net").Socket>();

  async function startUpstream(behaviour: (res: import("node:http").ServerResponse) => void): Promise<void> {
    const { createServer } = await import("node:http");
    upstream = createServer((req, res) => {
      upstreamOpens += 1;
      req.on("close", () => {
        upstreamAborts += 1;
      });
      behaviour(res);
    });
    // These streams never end on their own, so close() would wait forever.
    upstream.on("connection", (socket) => upstreamSockets.add(socket));
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const address = upstream!.address();
    upstreamPort = typeof address === "object" && address ? address.port : 0;
  }

  function sseUpstream(res: import("node:http").ServerResponse): void {
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    // The real project service sets this; forwarding it onto an authenticated
    // cross-origin surface is the hole this must not reproduce.
    res.setHeader("access-control-allow-origin", "*");
    res.write("event: ready\ndata: {}\n\n");
    res.write('event: output\ndata: {"output":"hello from the pane"}\n\n');
  }

  function streamUrl(handle: HostedServerHandle, sessionId = "assistant"): string {
    return url(handle, `/proxy/127.0.0.1/${upstreamPort}/agents/output/stream?sessionId=${sessionId}`);
  }

  async function startWithStream(granted = true) {
    return start({}, undefined, (actor, method, path) => {
      if (!granted) return { ok: false as const, status: 403, error: "operator is not granted this session" };
      const query = path.slice(path.indexOf("?"));
      return { ok: true as const, url: `http://127.0.0.1:${upstreamPort}/agents/output/stream${query}` };
    });
  }

  beforeEach(() => {
    upstreamAborts = 0;
    upstreamOpens = 0;
    upstreamSockets.clear();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    for (const socket of upstreamSockets) socket.destroy();
    upstreamSockets.clear();
    if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = null;
  });

  it("pipes upstream events to the client", async () => {
    await startUpstream(sseUpstream);
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await startWithStream();

    const res = await fetch(streamUrl(handle), { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain("ready");
    await reader.cancel();
  });

  it("never forwards the upstream's wildcard CORS header", async () => {
    await startUpstream(sseUpstream);
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await startWithStream();

    const res = await fetch(streamUrl(handle), { headers: { authorization: `Bearer ${token}` } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    // `connection: close` would end the stream at the first chunk.
    expect(res.headers.get("connection")).not.toBe("close");
    await res.body!.cancel();
  });

  it("tears the upstream down when the client hangs up", async () => {
    // Otherwise the project service keeps running capture-pane forever for a
    // client that is gone.
    await startUpstream(sseUpstream);
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await startWithStream();

    const controller = new AbortController();
    const res = await fetch(streamUrl(handle), {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    const before = upstreamAborts;
    controller.abort();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(upstreamAborts).toBeGreaterThan(before);
  });

  it("refuses a stream the principal was not granted, without opening the upstream", async () => {
    await startUpstream(sseUpstream);
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await startWithStream(false);

    const res = await fetch(streamUrl(handle, "not-granted"), { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    expect(upstreamOpens).toBe(0);
  });

  it("requires a credential for the stream route like any other", async () => {
    await startUpstream(sseUpstream);
    const handle = await startWithStream();
    const res = await fetch(streamUrl(handle));
    expect(res.status).toBe(401);
    expect(upstreamOpens).toBe(0);
  });

  it("404s the stream route when streaming is not wired", async () => {
    await startUpstream(sseUpstream);
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start();
    const res = await fetch(streamUrl(handle), { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });

  it("caps concurrent streams per principal", async () => {
    await startUpstream(sseUpstream);
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await startWithStream();

    const open: Array<{ cancel: () => Promise<void> }> = [];
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(streamUrl(handle), { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      open.push({ cancel: () => res.body!.cancel() });
    }

    const third = await fetch(streamUrl(handle), { headers: { authorization: `Bearer ${token}` } });
    expect(third.status).toBe(429);

    for (const entry of open) await entry.cancel();
  });

  it("audits the stream on open and on close", async () => {
    await startUpstream(sseUpstream);
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await startWithStream();

    const res = await fetch(streamUrl(handle), { headers: { authorization: `Bearer ${token}` } });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    await new Promise((resolve) => setTimeout(resolve, 300));
    const events = readFileSync(getHostedAuditPath(), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string })
      .map((entry) => entry.event)
      .filter((event): event is string => Boolean(event?.startsWith("hosted_stream_")));

    // A stream can outlive the daemon, so a record written only at close would
    // leave no trace of one that never closed.
    expect(events).toContain("hosted_stream_open");
    expect(events.some((event) => event.startsWith("hosted_stream_closed"))).toBe(true);
  });
});

describe("hosted stream teardown", () => {
  let upstream: import("node:http").Server | null = null;
  let upstreamPort = 0;
  const sockets = new Set<import("node:net").Socket>();

  afterEach(async () => {
    await server?.close();
    server = null;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = null;
  });

  async function startFlooding(): Promise<void> {
    const { createServer } = await import("node:http");
    upstream = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      const pump = () => {
        // Faster than any consumer, so the pipe hits backpressure.
        while (res.write(`data: ${"x".repeat(64 * 1024)}\n\n`)) {
          if (res.writableEnded) return;
        }
        res.once("drain", pump);
      };
      pump();
    });
    upstream.on("connection", (socket) => sockets.add(socket));
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const address = upstream!.address();
    upstreamPort = typeof address === "object" && address ? address.port : 0;
  }

  it("releases the stream slot when a backpressured client vanishes", async () => {
    // The deadlock this covers: waiting on `drain` alone never resolves for a
    // socket that died mid-write, so the pipe stays suspended, its `finally`
    // never runs, and the principal's stream slots leak permanently.
    await startFlooding();
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start({}, undefined, (_actor, _method, path) => ({
      ok: true as const,
      url: `http://127.0.0.1:${upstreamPort}/agents/output/stream${path.slice(path.indexOf("?"))}`,
    }));
    const target = url(handle, `/proxy/127.0.0.1/${upstreamPort}/agents/output/stream?sessionId=assistant`);

    // Open two (the cap), read nothing so both back up, then kill them.
    for (let i = 0; i < 2; i += 1) {
      const controller = new AbortController();
      const res = await fetch(target, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
    }

    await new Promise((resolve) => setTimeout(resolve, 400));

    // If the slots leaked, this is a 429 forever.
    const after = await fetch(target, { headers: { authorization: `Bearer ${token}` } });
    expect(after.status).toBe(200);
    await after.body!.cancel();
  });

  it("answers a real 502 when the upstream refuses, not an empty 200", async () => {
    const { createServer } = await import("node:http");
    upstream = createServer((_req, res) => {
      res.statusCode = 503;
      res.end("nope");
    });
    upstream.on("connection", (socket) => sockets.add(socket));
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const address = upstream!.address();
    upstreamPort = typeof address === "object" && address ? address.port : 0;

    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start({}, undefined, () => ({
      ok: true as const,
      url: `http://127.0.0.1:${upstreamPort}/agents/output/stream?sessionId=assistant`,
    }));

    const res = await fetch(url(handle, `/proxy/127.0.0.1/${upstreamPort}/agents/output/stream?sessionId=assistant`), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(502);
  });
});

describe("hosted stream bounds", () => {
  let upstream: import("node:http").Server | null = null;
  let upstreamPort = 0;
  const sockets = new Set<import("node:net").Socket>();

  afterEach(async () => {
    await server?.close();
    server = null;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = null;
  });

  async function startUpstream(pump: (res: import("node:http").ServerResponse) => void): Promise<void> {
    const { createServer } = await import("node:http");
    upstream = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      pump(res);
    });
    upstream.on("connection", (socket) => sockets.add(socket));
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const address = upstream!.address();
    upstreamPort = typeof address === "object" && address ? address.port : 0;
  }

  async function openStream(limits: Partial<StreamLimits>) {
    const { token } = createHostedPrincipal({ label: "grand" });
    const handle = await start(
      {},
      undefined,
      (_actor, _method, path) => ({
        ok: true as const,
        url: `http://127.0.0.1:${upstreamPort}/agents/output/stream${path.slice(path.indexOf("?"))}`,
      }),
      limits,
    );
    const target = url(handle, `/proxy/127.0.0.1/${upstreamPort}/agents/output/stream?sessionId=assistant`);
    return { handle, target, token };
  }

  function closeReasons(): string[] {
    return readFileSync(getHostedAuditPath(), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { event?: string }).event ?? "")
      .filter((event) => event.startsWith("hosted_stream_closed"));
  }

  it("ends a stream that has gone quiet", async () => {
    await startUpstream((res) => res.write("event: ready\ndata: {}\n\n"));
    const { target, token } = await openStream({ idleTimeoutMs: 150 });

    const res = await fetch(target, { headers: { authorization: `Bearer ${token}` } });
    const reader = res.body!.getReader();
    await reader.read();
    // Upstream never sends again; the idle timer should end it for us.
    await reader.read();

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closeReasons()).toContain("hosted_stream_closed:idle");
  });

  it("ends a stream at its lifetime even while data is flowing", async () => {
    await startUpstream((res) => {
      const timer = setInterval(() => {
        if (res.writableEnded) clearInterval(timer);
        else res.write("event: output\ndata: {}\n\n");
      }, 20);
      timer.unref?.();
    });
    const { target, token } = await openStream({ maxLifetimeMs: 200 });

    const res = await fetch(target, { headers: { authorization: `Bearer ${token}` } });
    const reader = res.body!.getReader();
    await reader.read();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closeReasons()).toContain("hosted_stream_closed:lifetime");
  });

  it("ends a stream that exceeds its byte budget", async () => {
    await startUpstream((res) => {
      const timer = setInterval(() => {
        if (res.writableEnded) clearInterval(timer);
        else res.write(`data: ${"x".repeat(2048)}\n\n`);
      }, 10);
      timer.unref?.();
    });
    const { target, token } = await openStream({ maxBytes: 4096 });

    const res = await fetch(target, { headers: { authorization: `Bearer ${token}` } });
    const reader = res.body!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closeReasons()).toContain("hosted_stream_closed:budget");
  });

  it("releases the slot when a non-reading client is timed out", async () => {
    // The residual leak: a client that stops reading fills the window, so the
    // idle timer's res.end() can only queue — no drain, no close, no error. If
    // the drain wait does not also race the abort, the pipe parks forever and
    // the slot never comes back.
    await startUpstream((res) => {
      const pump = () => {
        while (res.write(`data: ${"x".repeat(64 * 1024)}\n\n`)) if (res.writableEnded) return;
        res.once("drain", pump);
      };
      pump();
    });
    const { target, token } = await openStream({ idleTimeoutMs: 150, maxPerPrincipal: 1 });

    const first = await fetch(target, { headers: { authorization: `Bearer ${token}` } });
    expect(first.status).toBe(200);
    // Deliberately never read it.

    await new Promise((resolve) => setTimeout(resolve, 600));

    const second = await fetch(target, { headers: { authorization: `Bearer ${token}` } });
    expect(second.status).toBe(200);
    await second.body!.cancel();
  });
});
