import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { log } from "./debug.js";
import type { HostedConfig } from "./hosted-config.js";
import { authenticateHosted, stripTrustedHeaders } from "./hosted-auth.js";
import { markPrincipalSeen, type HostedPrincipal } from "./hosted-principals.js";
import { HostedRateLimiter } from "./hosted-rate-limit.js";
import type { RemoteActor } from "./remote-access.js";

/**
 * The hosted listener: the only door hosted mode opens.
 *
 * It authenticates a bearer token, mints an operator actor, applies limits, and
 * hands the request to the daemon through `routeHostedRequest` — which takes
 * the actor as a required argument rather than deriving it from headers, so
 * there is no code path where a hosted request is mistaken for a local one.
 *
 * It deliberately sets no CORS headers. The daemon's own surface allows any
 * localhost origin, which is fine on loopback and a DNS-rebinding hole the
 * moment a tunnel is in front.
 */

export interface HostedRouteResponse {
  status: number;
  body: unknown;
  contentType?: string;
}

export interface HostedServerOptions {
  config: HostedConfig;
  routeHostedRequest: (
    actor: RemoteActor,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<HostedRouteResponse>;
}

export interface HostedServerHandle {
  host: string;
  port: number;
  close: () => Promise<void>;
}

const CLOSE_GRACE_MS = 3_000;
const MAX_CONNECTIONS = 64;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
/** Headroom over the per-principal budget: one peer may carry several tokens. */
const PEER_BUDGET_MULTIPLIER = 4;
const PRUNE_INTERVAL_MS = 300_000;

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.setHeader("cache-control", "no-store");
  res.setHeader("connection", "close");
  res.end(payload);
}

/**
 * Read a JSON body, refusing anything over the cap mid-stream.
 *
 * Buffering first and checking afterwards would make the size limit useless
 * against the case it exists for: a client that sends a body far larger than
 * the daemon should ever hold in memory.
 */
async function readCappedJson(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: "too_large" | "invalid_json" }> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      // Pause rather than destroy: destroying here kills the socket before the
      // 413 can be written, and the client sees a connection reset instead of
      // the reason it was refused. The handler tears down after the response
      // flushes, so the rest of the body is still never read.
      req.pause();
      return { ok: false, reason: "too_large" };
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

function isProxyPath(pathname: string): boolean {
  return /^\/proxy\/[^/]+\/\d+\/.+/.test(pathname);
}

export async function startHostedServer(options: HostedServerOptions): Promise<HostedServerHandle> {
  const { config, routeHostedRequest } = options;
  const limiter = new HostedRateLimiter({
    requestsPerMinute: config.rateLimit.requestsPerMinute,
    maxConcurrent: config.rateLimit.maxConcurrent,
  });
  /**
   * Applied before authentication, keyed by peer address.
   *
   * Verifying a token reads and parses the principal store synchronously, so an
   * unauthenticated flood would stall the event loop this daemon shares with
   * every local project and PTY. Refusing early keeps the cost of an anonymous
   * request near zero.
   *
   * Behind a tunnel every request arrives from loopback, so in practice this is
   * a single global ceiling rather than a per-client one. That is the right
   * shape for the DoS it defends against, but it does mean one noisy client can
   * consume the budget — size it above the per-principal budget accordingly.
   */
  const peerLimiter = new HostedRateLimiter({
    requestsPerMinute: config.rateLimit.requestsPerMinute * PEER_BUDGET_MULTIPLIER,
    maxConcurrent: config.rateLimit.maxConcurrent * PEER_BUDGET_MULTIPLIER,
  });
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      log.warn("hosted request failed", "hosted", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) send(res, 500, { ok: false, error: "internal error" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();

    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://hosted.invalid");
    } catch {
      // A request target the URL parser rejects is a bad request, not a server
      // fault — answering 500 here also amplifies logs on a malformed flood.
      send(res, 400, { ok: false, error: "bad request" });
      return;
    }

    // Answered before the limiter and without a credential. It touches no
    // store, so throttling it would only let a flood convince the tunnel that
    // a healthy daemon is dead.
    if (method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true, mode: "hosted" });
      return;
    }

    const peerSlot = peerLimiter.acquire(req.socket.remoteAddress ?? "unknown");
    if (!peerSlot.ok) {
      send(res, 429, { ok: false, error: "too many requests" });
      return;
    }

    try {
      await handleAuthenticated(req, res, method, url);
    } finally {
      peerSlot.release();
    }
  }

  async function handleAuthenticated(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    url: URL,
  ): Promise<void> {
    const headers = stripTrustedHeaders(req.headers);
    const auth = authenticateHosted(headers);
    if (!auth.ok) {
      // Identical response either way: distinguishing "no token" from "wrong
      // token" tells a prober whether a token was recognised.
      send(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    if (!isProxyPath(url.pathname)) {
      send(res, 404, { ok: false, error: "not found" });
      return;
    }

    const slot = limiter.acquire(auth.principal.id);
    if (!slot.ok) {
      send(res, 429, { ok: false, error: slot.reason === "rate" ? "rate limit exceeded" : "too many requests" });
      return;
    }

    try {
      let body: unknown;
      if (method !== "GET" && method !== "HEAD") {
        const read = await readCappedJson(req, config.maxPromptBytes);
        if (!read.ok) {
          const oversized = read.reason === "too_large";
          if (oversized) res.once("finish", () => req.destroy());
          send(res, oversized ? 413 : 400, {
            ok: false,
            error: oversized ? "request body too large" : "invalid json body",
          });
          return;
        }
        body = read.body;
      }

      const result = await routeHostedRequest(auth.actor, method, `${url.pathname}${url.search}`, body);
      const payload = JSON.stringify(result.body ?? null);
      if (Buffer.byteLength(payload) > config.maxResponseBytes) {
        send(res, 502, { ok: false, error: "upstream response too large" });
        return;
      }
      send(res, result.status, result.body);
    } finally {
      slot.release();
      // After the response, and never blocking on the store lock: a last-seen
      // stamp is not worth stalling the process that serves every request.
      setImmediate(() => {
        try {
          markPrincipalSeen((auth as { principal: HostedPrincipal }).principal.id);
        } catch {
          // Best effort only.
        }
      });
    }
  }

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  // Bounded connections and short timeouts so a slow client cannot hold a slot
  // (or a socket) open indefinitely against the daemon.
  server.maxConnections = MAX_CONNECTIONS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;

  const pruneTimer = setInterval(() => {
    limiter.prune();
    peerLimiter.prune();
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();

  await new Promise<void>((resolve, reject) => {
    // Fail loudly on EADDRINUSE. Falling back to a random port is right for a
    // discoverable project service and wrong here — the operator's tunnel
    // points at this exact address.
    server.once("error", reject);
    server.listen(config.port, config.bindAddress, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // Report what was actually bound, not what was asked for — they differ
  // whenever port 0 is used, which is how tests and ephemeral binds work.
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : config.port;

  log.info("hosted listener started", "hosted", { host: config.bindAddress, port: boundPort });

  return {
    host: config.bindAddress,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(pruneTimer);
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          resolve();
        }, CLOSE_GRACE_MS);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}
