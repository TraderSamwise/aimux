import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { randomUUID } from "node:crypto";

import { log } from "./debug.js";
import type { HostedConfig } from "./hosted-config.js";
import { authenticateHosted, stripTrustedHeaders } from "./hosted-auth.js";
import {
  appendHostedAudit,
  appendHostedPrompt,
  hashPrompt,
  pruneHostedAudit,
  type HostedAuditRecord,
} from "./hosted-audit.js";
import { clientAddress, HostedEventDelivery, pruneHostedDevices, recordDeviceSighting } from "./hosted-events.js";
import { isHostedLockedDown } from "./hosted-lockdown.js";
import { drainHostedOutbox } from "./hosted-outbox.js";
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
/**
 * Generous, because this is not where a flood is stopped.
 *
 * A low ceiling is itself the denial of service: anyone who can reach the
 * listener holds every slot with silent sockets and no operator connects. The
 * control that actually works is an authenticating front door (Cloudflare
 * Access, mTLS) — see docs/hosted-mode.md. This only bounds memory.
 */
const MAX_CONNECTIONS = 512;
const REQUEST_TIMEOUT_MS = 30_000;
/** Short, so a socket that never sends headers cannot occupy a slot for long. */
const HEADERS_TIMEOUT_MS = 3_000;
/**
 * Prompt bodies are retained as a prefix.
 *
 * The hash covers the WHOLE body, so a retained prefix cannot be verified
 * against it — the hash is for correlating records, not for proving content.
 */
const MAX_AUDIT_PROMPT_CHARS = 1_024;
/**
 * Every other caller-chosen string that reaches a record.
 *
 * A record must have a bounded size, because rotation is size-driven: anyone
 * who can make records arbitrarily large pushes everyone else's out of the
 * ring. The body was only the most obvious of these — the request path, the
 * session id and the principal's label are all chosen elsewhere and were all
 * unbounded.
 */
const MAX_AUDIT_FIELD_CHARS = 256;

function boundedField<T extends string | null>(value: T): T {
  if (typeof value !== "string" || value.length <= MAX_AUDIT_FIELD_CHARS) return value;
  return `${value.slice(0, MAX_AUDIT_FIELD_CHARS)}…` as T;
}
/** Headroom over the per-principal budget: one peer may carry several tokens. */
const PEER_BUDGET_MULTIPLIER = 4;
const PRUNE_INTERVAL_MS = 300_000;
/** A security alert should not wait five minutes for the next prune tick. */
const OUTBOX_INTERVAL_MS = 5_000;

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

/**
 * The session a record is about, read the same way the access gate read it —
 * body on POST, query on GET — so the audit names the session that was actually
 * authorized rather than whichever id happened to appear somewhere.
 */
function auditedSessionId(method: string, url: URL, body: unknown): string | null {
  if (method === "GET") return url.searchParams.get("sessionId")?.trim() || null;
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).sessionId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function promptTextOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const text = (body as Record<string, unknown>).text;
  return typeof text === "string" ? text : null;
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
  const delivery = new HostedEventDelivery(config);
  /**
   * Failed-auth events are throttled per peer.
   *
   * A credential-stuffing run is one event worth knowing about, not thousands —
   * and without this an attacker could turn the daemon into a webhook flood
   * against whoever receives them.
   */
  const authFailureThrottle = new Map<string, number>();
  const AUTH_FAILURE_WINDOW_MS = 60_000;
  /**
   * A ceiling across all keys, applied to DELIVERY only.
   *
   * The per-key throttle is keyed on the client address, which behind a tunnel
   * comes from a forwarded header — a client that rotates it gets a fresh key
   * every request and slips past. Bounding the webhook stops that being an
   * amplifier pointed at whoever receives it.
   *
   * It deliberately does not gate the audit record. Suppressing those would let
   * an attacker go quiet in the log simply by making enough noise first, and
   * every field of such a record is bounded; the peer rate limiter bounds how
   * fast they can arrive.
   */
  const AUTH_FAILURE_DELIVERY_MAX = 10;
  let authFailureWindowStart = 0;
  let authFailureWindowCount = 0;

  function deliverAuthFailure(): boolean {
    const now = Date.now();
    if (now - authFailureWindowStart >= AUTH_FAILURE_WINDOW_MS) {
      authFailureWindowStart = now;
      authFailureWindowCount = 0;
    }
    if (authFailureWindowCount >= AUTH_FAILURE_DELIVERY_MAX) return false;
    authFailureWindowCount += 1;
    return true;
  }

  function reportAuthFailure(req: IncomingMessage, headers: Record<string, string>, reason: string): void {
    const address = clientAddress(req.socket.remoteAddress, headers, config);
    const key = address ?? "unknown";
    const last = authFailureThrottle.get(key) ?? 0;
    if (Date.now() - last < AUTH_FAILURE_WINDOW_MS) return;
    authFailureThrottle.set(key, Date.now());

    setImmediate(() => {
      try {
        const event = {
          id: randomUUID(),
          kind: "hosted_auth_failed" as const,
          ts: new Date().toISOString(),
          principalId: null,
          label: null,
          fingerprint: null,
          addressKnown: address !== null,
          userAgent: headers["user-agent"] ?? null,
          detail: reason,
        };
        appendHostedAudit({
          ts: event.ts,
          principalId: "-",
          label: "-",
          method: req.method ?? "GET",
          path: "-",
          sessionId: null,
          status: 401,
          requestBytes: 0,
          responseBytes: 0,
          event: event.kind,
          detail: reason,
        });
        if (deliverAuthFailure()) delivery.enqueue(event);
      } catch {
        // Never let reporting a failed login fail anything else.
      }
    });
  }

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

    const lockedDown = isHostedLockedDown();

    // Answered before the limiter and without a credential. It touches no
    // store, so throttling it would only let a flood convince the tunnel that
    // a healthy daemon is dead — and for the same reason it stays 200 under
    // lockdown, which is a closed door rather than a dead box.
    if (method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true, mode: "hosted", lockdown: lockedDown });
      return;
    }

    // Checked before authentication: under lockdown nothing should reach the
    // principal store at all, and a uniform refusal leaks nothing about which
    // tokens are real.
    if (lockedDown) {
      send(res, 503, { ok: false, error: "hosted mode is locked down" });
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
      reportAuthFailure(req, headers, auth.reason);
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

    let status = 500;
    let requestBytes = 0;
    let responseBytes = 0;
    let body: unknown;
    // Captured NOW, not in the deferred block: by the time that runs the socket
    // may be destroyed and remoteAddress undefined, which would silently change
    // the device fingerprint and fire a spurious "new device" alert.
    const address = clientAddress(req.socket.remoteAddress, headers, config);

    try {
      if (method !== "GET" && method !== "HEAD") {
        const read = await readCappedJson(req, config.maxPromptBytes);
        if (!read.ok) {
          const oversized = read.reason === "too_large";
          if (oversized) res.once("finish", () => req.destroy());
          status = oversized ? 413 : 400;
          send(res, status, {
            ok: false,
            error: oversized ? "request body too large" : "invalid json body",
          });
          return;
        }
        body = read.body;
      }

      const result = await routeHostedRequest(auth.actor, method, `${url.pathname}${url.search}`, body);
      const payload = JSON.stringify(result.body ?? null);
      responseBytes = Buffer.byteLength(payload);
      if (responseBytes > config.maxResponseBytes) {
        status = 502;
        send(res, 502, { ok: false, error: "upstream response too large" });
        return;
      }
      status = result.status;
      send(res, result.status, result.body);
    } finally {
      slot.release();
      // Everything below is bookkeeping: synchronous file writes and a webhook
      // enqueue have no business on the path that answers the request.
      const principal = (auth as { principal: HostedPrincipal }).principal;
      const promptText = promptTextOf(body);
      setImmediate(() => {
        try {
          markPrincipalSeen(principal.id);
          // Re-serializing the body is bookkeeping, so it belongs here rather
          // than on the path that answers the request.
          requestBytes = body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body ?? null));

          const record: HostedAuditRecord = {
            ts: new Date().toISOString(),
            principalId: principal.id,
            label: boundedField(principal.label),
            method,
            path: boundedField(url.pathname),
            sessionId: boundedField(auditedSessionId(method, url, body)),
            status,
            requestBytes,
            responseBytes,
          };
          if (promptText !== null) {
            record.promptHash = hashPrompt(promptText);
            // Bodies are kept only for requests that were actually carried out.
            // A refused request still gets a record and a hash, but storing its
            // body would let anyone holding a token — including one with no
            // grants at all, whose every request is a 403 — push every other
            // operator's history out of a size-rotated file.
            if (config.auditPromptBodies && status >= 200 && status < 300) {
              const kept = promptText.slice(0, MAX_AUDIT_PROMPT_CHARS);
              record.promptRef = randomUUID();
              appendHostedPrompt({
                ts: record.ts,
                promptRef: record.promptRef,
                principalId: principal.id,
                promptHash: record.promptHash,
                promptText: kept,
                truncated: kept.length < promptText.length ? true : undefined,
              });
            }
          }
          appendHostedAudit(record);

          const sighting = recordDeviceSighting({
            principalId: principal.id,
            label: boundedField(principal.label),
            address,
            userAgent: headers["user-agent"] ?? null,
          });
          if (sighting) {
            // Audited as well as delivered, so a webhook outage costs
            // timeliness rather than the record itself.
            // No method/path/status: an event row is not a request row, and a
            // consumer counting requests must not double-count it.
            appendHostedAudit({
              ts: sighting.ts,
              principalId: principal.id,
              label: boundedField(principal.label),
              method: "-",
              path: "-",
              sessionId: null,
              status: 0,
              requestBytes: 0,
              responseBytes: 0,
              event: sighting.kind,
              detail: sighting.fingerprint ?? undefined,
            });
            delivery.enqueue(sighting);
          }
        } catch (error) {
          log.warn("hosted post-request bookkeeping failed", "hosted", {
            error: error instanceof Error ? error.message : String(error),
          });
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

  // Events raised by the CLI live in a spool file; this process holds the
  // webhook secret and the retry budget, so it is the one that delivers them.
  const outboxTimer = setInterval(() => {
    try {
      for (const event of drainHostedOutbox()) delivery.enqueue(event);
    } catch (error) {
      log.warn("hosted outbox drain failed", "hosted", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, OUTBOX_INTERVAL_MS);
  outboxTimer.unref?.();

  const pruneTimer = setInterval(() => {
    limiter.prune();
    peerLimiter.prune();
    for (const [key, at] of authFailureThrottle) {
      if (Date.now() - at > AUTH_FAILURE_WINDOW_MS) authFailureThrottle.delete(key);
    }
    try {
      pruneHostedAudit(config.retentionDays);
      pruneHostedDevices(config.retentionDays);
    } catch (error) {
      log.warn("hosted retention prune failed", "hosted", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
        clearInterval(outboxTimer);
        delivery.stop();
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
