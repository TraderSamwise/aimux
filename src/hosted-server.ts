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
import { PROJECT_API_ROUTES } from "./project-api-contract.js";
import { parseProxyTarget } from "./proxy-project-binding.js";
import { isHostedLockedDown } from "./hosted-lockdown.js";
import { drainHostedOutbox } from "./hosted-outbox.js";
import { findPrincipalById, markPrincipalSeen, principalHasGrant, type HostedPrincipal } from "./hosted-principals.js";
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
  /** Absent means streaming is unavailable and the route 404s. */
  resolveHostedStream?: (
    actor: RemoteActor,
    method: string,
    path: string,
  ) => { ok: true; url: string; projectRoot: string } | { ok: false; status: number; error: string };
  /** Overrides for the stream bounds. Tests need them small; nothing else sets them. */
  streamLimits?: Partial<StreamLimits>;
}

export interface StreamLimits {
  maxPerPrincipal: number;
  maxLifetimeMs: number;
  idleTimeoutMs: number;
  maxBytes: number;
  reauthIntervalMs: number;
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
/** Concurrent streams one principal may hold. */
const MAX_STREAMS_PER_PRINCIPAL = 2;
/** Hard stop, so a forgotten tab cannot hold a connection indefinitely. */
const STREAM_MAX_LIFETIME_MS = 600_000;
/** The upstream sends a keepalive comment every poll, so silence means trouble. */
const STREAM_IDLE_TIMEOUT_MS = 120_000;
/** `maxResponseBytes` is meaningless on a stream; this ends one instead. */
const STREAM_MAX_BYTES = 64 * 1024 * 1024;
/**
 * How often an open stream re-checks that its principal is still allowed.
 *
 * A stream authenticates once, at open. Without this a revoked token would keep
 * reading a session until the stream's own lifetime ran out — which is the one
 * moment revocation most needs to work, and the idle timeout cannot help
 * because the project service sends a keepalive every poll.
 */
const STREAM_REAUTH_INTERVAL_MS = 5_000;

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
 * Content types this listener will serve as bytes.
 *
 * A fixed list, and the upstream's own header is never echoed into it. Two
 * reasons: the project service sets `access-control-allow-origin: *` on its
 * routes, so copying its headers onto an authenticated surface is a hole; and
 * a content type chosen by whatever produced the file is how a stored upload
 * gets served back as something executable. SVG is absent on purpose — it is a
 * script-execution vector wearing an image's name.
 */
const SERVABLE_BINARY_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Returns what was ACTUALLY sent, because it may refuse and answer 502 itself.
 * The caller records the result in the audit log, and a log that reports the
 * status the upstream wanted rather than the one the client received is worse
 * than no log — it is a log that disagrees with reality.
 */
function sendBytes(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string | undefined,
): { status: number; bytes: number } {
  const declared = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!SERVABLE_BINARY_TYPES.has(declared)) {
    const payload = { ok: false, error: "upstream returned an unsupported content type" };
    send(res, 502, payload);
    return { status: 502, bytes: Buffer.byteLength(JSON.stringify(payload)) };
  }
  res.statusCode = status;
  res.setHeader("content-type", declared);
  res.setHeader("content-length", body.byteLength);
  res.setHeader("cache-control", "no-store");
  // The type is from our allowlist, so sniffing can only ever disagree with a
  // correct answer.
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-disposition", "inline");
  res.setHeader("connection", "close");
  res.end(body);
  return { status, bytes: body.byteLength };
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
): Promise<{ ok: true; body: unknown; bytes: number } | { ok: false; reason: "too_large" | "invalid_json" }> {
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
  // The size is returned rather than recomputed later: the audit record needs
  // it, and re-serializing the parsed body to measure it would make a second
  // full copy of an attachment-sized upload on the shared event loop.
  if (!raw) return { ok: true, body: {}, bytes: total };
  try {
    return { ok: true, body: JSON.parse(raw), bytes: total };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

function isProxyPath(pathname: string): boolean {
  return /^\/proxy\/[^/]+\/\d+\/.+/.test(pathname);
}

/**
 * Which requests get the larger body ceiling.
 *
 * Matched loosely on purpose: it decides only how many bytes may be BUFFERED,
 * never who may reach anything. A path that looks like an attachment route but
 * is not still faces the same allowlist and the same grant check a moment
 * later, so the worst a false positive can do is let an authenticated
 * principal spend its own byte budget faster.
 */
function isAttachmentProxyPath(pathname: string): boolean {
  return isProxyPath(pathname) && /\/attachments(\/|$)/.test(pathname);
}

/**
 * Which requests get the smaller one.
 *
 * The context is the one body a client may rewrite on every navigation, so it
 * is the cheapest way to flood the audit sink at prompt-sized bodies. Matched
 * as loosely as the attachment check above, and safe for the same reason: it
 * decides buffer size, never access.
 */
function isPromptContextProxyPath(pathname: string): boolean {
  return isProxyPath(pathname) && /\/agents\/prompt-context$/.test(pathname);
}

/**
 * Wait for backpressure to clear, for the socket to die, or for the stream to
 * be given up on.
 *
 * Waiting on `drain` alone deadlocks two different ways, and both leak the
 * stream slot permanently: a socket that dies while we are suspended emits
 * `close`/`error` and never `drain`; and a client that simply stops reading
 * fills the window, so the idle and lifetime timers fire into a `res.end()`
 * that can only queue — emitting nothing at all. The abort signal is the one
 * thing every teardown path raises, so it is what makes this always resolve.
 */
function drainOrDie(res: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (res.writableEnded || res.destroyed || signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
    res.on("error", done);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Routed to the streaming path purely on shape — authorization still happens in
 * `resolveHostedStream`. Getting this wrong sends a stream to the buffered
 * proxy (which waits for a body that never ends) or a buffered call to the
 * pipe; it can never grant access.
 */
function isStreamPath(pathname: string): boolean {
  const target = parseProxyTarget(pathname);
  return target?.subPath === PROJECT_API_ROUTES.agents.outputStream;
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
  const { config, routeHostedRequest, resolveHostedStream } = options;
  const streamLimits: StreamLimits = {
    maxPerPrincipal: MAX_STREAMS_PER_PRINCIPAL,
    maxLifetimeMs: STREAM_MAX_LIFETIME_MS,
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    maxBytes: STREAM_MAX_BYTES,
    reauthIntervalMs: STREAM_REAUTH_INTERVAL_MS,
    ...options.streamLimits,
  };
  const limiter = new HostedRateLimiter({
    requestsPerMinute: config.rateLimit.requestsPerMinute,
    maxConcurrent: config.rateLimit.maxConcurrent,
    bytesPerMinute: config.rateLimit.bytesPerMinute,
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
    // Never charged — see the note at the `limiter.charge` call. Present only
    // because the option is required; it bounds nothing here.
    bytesPerMinute: config.rateLimit.bytesPerMinute * PEER_BUDGET_MULTIPLIER,
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

  /**
   * Concurrency for streams, counted separately from the token bucket.
   *
   * `HostedRateLimiter` spends a token AND a slot per request, which is the
   * wrong shape for one request that lives ten minutes: it would either consume
   * a single token and then run unmetered, or hold a bucket slot for the
   * duration and starve the principal's ordinary calls.
   */
  const streamsByPrincipal = new Map<string, number>();

  function acquireStream(principalId: string): boolean {
    const open = streamsByPrincipal.get(principalId) ?? 0;
    if (open >= streamLimits.maxPerPrincipal) return false;
    streamsByPrincipal.set(principalId, open + 1);
    return true;
  }

  function releaseStream(principalId: string): void {
    const open = (streamsByPrincipal.get(principalId) ?? 1) - 1;
    if (open <= 0) streamsByPrincipal.delete(principalId);
    else streamsByPrincipal.set(principalId, open);
  }

  async function handleStream(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    url: URL,
    actor: RemoteActor,
    principal: HostedPrincipal,
    headers: Record<string, string>,
    releasePeer: () => void,
  ): Promise<void> {
    // Opening a stream is metered like any other request. The concurrency
    // counter below bounds how many run at once; without this a token holder
    // could still hammer open/refuse cycles unmetered, each one writing a
    // record. The bucket's own concurrency slot is released immediately —
    // streams are counted by `streamsByPrincipal`, which understands that one
    // of these lives for minutes.
    const openSlot = limiter.acquire(principal.id);
    if (!openSlot.ok) {
      send(res, 429, { ok: false, error: openSlot.reason === "rate" ? "rate limit exceeded" : "too many requests" });
      return;
    }
    openSlot.release();

    if (!resolveHostedStream) {
      send(res, 404, { ok: false, error: "not found" });
      return;
    }

    const address = clientAddress(req.socket.remoteAddress, headers, config);
    const resolved = resolveHostedStream(actor, method, `${url.pathname}${url.search}`);
    if (!resolved.ok) {
      send(res, resolved.status, { ok: false, error: resolved.error });
      auditStream(principal, url, resolved.status, "denied", 0, 0);
      return;
    }

    if (!acquireStream(principal.id)) {
      send(res, 429, { ok: false, error: "too many concurrent streams" });
      return;
    }

    // Everything below runs inside the try/finally that releases the slot.
    const streamRef = randomUUID();
    const startedAt = Date.now();
    let bytes = 0;
    let closeReason = "open";
    let auditStatus = 200;
    // Recorded at OPEN as well as close: a stream can outlive the daemon, and a
    // record written only on close would leave no trace of one that never got
    // to close.
    auditStream(principal, url, 200, "open", 0, 0, streamRef);

    const controller = new AbortController();
    let settled = false;
    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      // First reason wins: a client that hung up mid-write must not be
      // relabelled by the teardown that hangup itself triggers.
      closeReason = reason;
      controller.abort();
      if (!res.writableEnded) res.end();
      // A client that stopped reading leaves `end()` queued behind a full
      // window, so the socket would linger until the OS gave up on it. Anything
      // other than a clean finish gets the socket taken away.
      if (reason !== "eof" && reason !== "client" && !res.destroyed) res.destroy();
    };

    // Without this the upstream capture-pane poll keeps running after the
    // client is gone — the project service only stops when its socket closes.
    res.once("close", () => finish("client"));
    res.once("error", () => finish("error"));

    const lifetime = setTimeout(() => finish("lifetime"), streamLimits.maxLifetimeMs);
    lifetime.unref?.();

    const grantedSessionId = url.searchParams.get("sessionId")?.trim() ?? "";
    const reauth = setInterval(() => {
      // Every other caller of the principal store sits behind the request
      // handler's catch; a timer callback does not, and `loadHostedPrincipals`
      // rethrows a store it cannot read. An unhandled throw here would take the
      // whole daemon down — every local project with it — so a store we cannot
      // consult ends this stream rather than the process.
      let allowed = false;
      try {
        const current = findPrincipalById(principal.id);
        allowed =
          current !== null &&
          principalHasGrant(current, { projectRoot: resolved.projectRoot, sessionId: grantedSessionId });
      } catch (error) {
        log.warn("hosted stream re-authorization failed", "hosted", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!allowed) finish("revoked");
    }, streamLimits.reauthIntervalMs);
    reauth.unref?.();
    let idle = setTimeout(() => finish("idle"), streamLimits.idleTimeoutMs);
    idle.unref?.();

    try {
      const upstream = await fetch(resolved.url, {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!upstream.ok || !upstream.body) {
        // Answered BEFORE finish(): finish ends the response, which flushes a
        // 200, and the 502 would then die on ERR_HTTP_HEADERS_SENT leaving the
        // client an empty success.
        auditStatus = 502;
        send(res, 502, { ok: false, error: "upstream stream unavailable" });
        finish("upstream");
        return;
      }

      // Synthesized, never forwarded: the project service sets
      // `access-control-allow-origin: *` on this route, and copying that onto an
      // authenticated cross-origin surface is a hole. No `connection: close`
      // either — that would end the stream at the first chunk.
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-accel-buffering", "no");
      res.flushHeaders?.();
      releasePeer();

      for await (const chunk of upstream.body) {
        if (settled) break;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > streamLimits.maxBytes) {
          finish("budget");
          break;
        }
        clearTimeout(idle);
        idle = setTimeout(() => finish("idle"), streamLimits.idleTimeoutMs);
        idle.unref?.();
        if (!res.write(buffer)) {
          await drainOrDie(res, controller.signal);
          if (settled) break;
        }
      }
      finish("eof");
    } catch (error) {
      if (!settled && !res.headersSent) {
        auditStatus = 502;
        send(res, 502, { ok: false, error: error instanceof Error ? error.message : "stream failed" });
      }
      finish("error");
    } finally {
      clearTimeout(lifetime);
      clearTimeout(idle);
      clearInterval(reauth);
      releaseStream(principal.id);
      const durationMs = Date.now() - startedAt;
      auditStream(principal, url, auditStatus, `closed:${closeReason}`, bytes, durationMs, streamRef);
      setImmediate(() => {
        try {
          markPrincipalSeen(principal.id);
          const sighting = recordDeviceSighting({
            principalId: principal.id,
            label: principal.label,
            address,
            userAgent: headers["user-agent"] ?? null,
          });
          if (sighting) delivery.enqueue(sighting);
        } catch {
          // Bookkeeping must never fail a stream that already ended.
        }
      });
    }
  }

  function auditStream(
    principal: HostedPrincipal,
    url: URL,
    status: number,
    event: string,
    bytes: number,
    durationMs: number,
    streamRef?: string,
  ): void {
    setImmediate(() => {
      try {
        appendHostedAudit({
          ts: new Date().toISOString(),
          principalId: principal.id,
          label: boundedField(principal.label),
          method: "GET",
          path: boundedField(url.pathname),
          sessionId: boundedField(url.searchParams.get("sessionId")?.trim() || null),
          status,
          requestBytes: 0,
          responseBytes: bytes,
          event: `hosted_stream_${event}`,
          detail: streamRef ? `${streamRef} ${durationMs}ms` : undefined,
        });
      } catch {
        // An audit failure must never fail the stream it describes.
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

    // Released early by a long-lived request. Behind a tunnel every request
    // keys to the same loopback address, so a handful of ten-minute streams
    // holding peer slots would block everyone else's ordinary calls. Streams
    // are bounded by their own concurrency counter instead.
    let peerReleased = false;
    const releasePeer = () => {
      if (peerReleased) return;
      peerReleased = true;
      peerSlot.release();
    };

    try {
      await handleAuthenticated(req, res, method, url, releasePeer);
    } finally {
      releasePeer();
    }
  }

  async function handleAuthenticated(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    url: URL,
    releasePeer: () => void,
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

    // Streams take a different path entirely: no body to read, no token bucket
    // (one request lives for minutes), and a response synthesized rather than
    // forwarded. Handled before the buffered machinery so a never-ending body
    // can never reach code that waits for one to finish.
    if (isStreamPath(url.pathname)) {
      await handleStream(req, res, method, url, auth.actor, auth.principal, headers, releasePeer);
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

    // 16 KB is the right ceiling on a prompt and a useless one on an image, so
    // the attachment routes get their own. Raising the prompt cap instead
    // would let an operator push megabytes into an append-only audit sink.
    const attachmentRoute = isAttachmentProxyPath(url.pathname);
    const bodyCap = attachmentRoute
      ? config.maxAttachmentBytes
      : isPromptContextProxyPath(url.pathname)
        ? config.maxContextBytes
        : config.maxPromptBytes;

    try {
      if (method !== "GET" && method !== "HEAD") {
        const read = await readCappedJson(req, bodyCap);
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
        requestBytes = read.bytes;
        // Charged before routing, because routing is where authorization
        // happens and the bytes have already been spent by then. Without this
        // a token holding no grants at all could still make the listener
        // buffer a full attachment on every one of its 60 requests a minute.
        //
        // The peer budget is deliberately not charged: behind a tunnel every
        // request shares one peer address, so a byte ceiling there would let
        // one admin's upload refuse everyone else's.
        if (!limiter.charge(auth.principal.id, read.bytes)) {
          status = 429;
          send(res, 429, { ok: false, error: "upload volume limit exceeded" });
          return;
        }
        body = read.body;
      }

      const result = await routeHostedRequest(auth.actor, method, `${url.pathname}${url.search}`, body);

      if (Buffer.isBuffer(result.body)) {
        if (result.body.byteLength > config.maxAttachmentBytes) {
          status = 502;
          responseBytes = result.body.byteLength;
          send(res, 502, { ok: false, error: "upstream response too large" });
          return;
        }
        const sent = sendBytes(res, result.status, result.body, result.contentType);
        status = sent.status;
        responseBytes = sent.bytes;
        return;
      }

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
          // `requestBytes` was measured as the body streamed in. Re-serializing
          // the parsed body to measure it here would make a second full copy of
          // an attachment-sized upload, on the event loop every other request
          // shares.

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
