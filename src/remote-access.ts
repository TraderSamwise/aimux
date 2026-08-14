import { principalHasGrant, type HostedPrincipal } from "./hosted-principals.js";
import { PROJECT_API_ROUTES } from "./project-api-contract.js";

export type RemoteActorRole = "owner" | "guest" | "operator";

export interface RemoteActor {
  role: RemoteActorRole;
  userId?: string;
  displayName?: string;
  email?: string;
  shareId?: string;
  shareSessionId?: string;
  /**
   * Hosted-mode principal. Server-minted only — `parseRemoteActor` never
   * produces one, because the relay cannot authenticate an operator and an
   * inbound header claiming the role is forgery.
   */
  principal?: HostedPrincipal;
}

export interface RemoteAccessContext {
  /** Parsed request body: POST routes carry `sessionId` there, not in the query. */
  body?: unknown;
  /** Project root owning the proxied service port. Operators are denied without it. */
  projectRoot?: string | null;
}

export interface RemoteAccessDecision {
  ok: boolean;
  status?: number;
  error?: string;
}

const ACTOR_HEADER = "x-aimux-actor";
const ROLE_HEADER = "x-aimux-actor-role";
const USER_ID_HEADER = "x-aimux-actor-user-id";
const DISPLAY_NAME_HEADER = "x-aimux-actor-display-name";
const EMAIL_HEADER = "x-aimux-actor-email";
const SHARE_ID_HEADER = "x-aimux-share-id";
const SHARE_SESSION_ID_HEADER = "x-aimux-share-session-id";
const RELAY_HEADER_PREFIX = "x-aimux-";
const SHARED_GUEST_SESSION_READ_ROUTES = new Set<string>([
  PROJECT_API_ROUTES.agents.output,
  PROJECT_API_ROUTES.agents.history,
  PROJECT_API_ROUTES.livePane.output,
  PROJECT_API_ROUTES.events,
]);
const SHARED_GUEST_SESSION_WRITE_ROUTES = new Set<string>([
  PROJECT_API_ROUTES.livePane.input,
  PROJECT_API_ROUTES.attachments,
]);
const ATTACHMENT_CONTENT_ROUTE = /^\/attachments\/[A-Za-z0-9_-]{1,128}\/content$/;

const PROXY_PATH_PATTERN = /^\/proxy\/[^/]+\/\d+(\/.*)$/;

/**
 * Every route an operator may reach, and the only method each accepts.
 *
 * Deny-by-default: a route added elsewhere in the codebase is unreachable to
 * operators until someone deliberately lists it here. `/agents` (list) is
 * absent on purpose — it returns every session in the project, which would leak
 * other principals' session ids. `/agents/output/stream` is absent because it
 * belongs to `OPERATOR_STREAM_ROUTES` below and must never appear here, and
 * `/events` because it is project-wide rather than per-session.
 */
const OPERATOR_ROUTE_METHODS = new Map<string, "GET" | "POST">([
  [PROJECT_API_ROUTES.agents.output, "GET"],
  [PROJECT_API_ROUTES.agents.input, "POST"],
  // Write-only by construction: the route replaces or clears, and there is no
  // GET, so a principal can steer its own granted session's prompts and cannot
  // read back what any other client put there.
  [PROJECT_API_ROUTES.agents.promptContext, "POST"],
  [PROJECT_API_ROUTES.agents.interrupt, "POST"],
  [PROJECT_API_ROUTES.attachments, "POST"],
]);

/**
 * Routes whose path carries an id, and so cannot be a Map key.
 *
 * Consulted only after the exact allowlist misses, and deliberately tiny: a
 * pattern is a weaker statement than a literal, so anything expressible as a
 * literal stays one. `/attachments/<id>` (metadata) is absent — the client
 * gets everything it needs from the transcript and the upload reply, so there
 * is no reason to widen the surface for it.
 *
 * The character class is doing real work. It admits no `.`, `/`, `%`, `;` or
 * `?`, which is what stops a traversal, an encoded slash, a matrix parameter
 * or a query fragment from riding inside the id and landing on a different
 * route. Ids are `att_` plus 32 hex characters, comfortably inside it. The
 * path reaching here has already been through `new URL()`, so `.` and `..`
 * segments — and their percent-encoded spellings — are gone before matching;
 * the class is the second of the two defences, not the only one.
 */
const OPERATOR_ROUTE_PATTERNS: ReadonlyArray<{ pattern: RegExp; method: "GET" | "POST" }> = [
  { pattern: /^\/attachments\/[A-Za-z0-9_-]{1,128}\/content$/, method: "GET" },
];

/**
 * Streaming routes, kept in a SEPARATE gate reached by a separate function.
 *
 * They must never appear in `OPERATOR_ROUTE_METHODS`: that allowlist governs
 * the buffered proxy, which reads the whole response before replying, and an
 * SSE body never ends. A stream arriving there would hang the request forever.
 *
 * `/events` is absent on purpose — it is project-wide rather than per-session,
 * so it would carry other operators' sessions to whoever subscribed.
 */
const OPERATOR_STREAM_ROUTES = new Set<string>([PROJECT_API_ROUTES.agents.outputStream]);

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bodySessionId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  return trimmedString((body as Record<string, unknown>).sessionId);
}

function bodyText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  return trimmedString((body as Record<string, unknown>).text);
}

function bodyHasAttachments(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const attachmentIds = (body as Record<string, unknown>).attachmentIds;
  return Array.isArray(attachmentIds)
    ? attachmentIds.some((id) => (typeof id === "string" ? Boolean(id.trim()) : id != null))
    : false;
}

/**
 * Authorize the session id the SERVICE will actually act on.
 *
 * The project service reads `sessionId` from the body on POST routes and from
 * the query on GET routes. Checking the wrong source — or accepting either —
 * would let a request authorize one session and operate on another, so the
 * authoritative source is chosen per route and a conflicting value in the other
 * one is refused outright rather than ignored.
 */
function authorizedSessionId(
  method: "GET" | "POST",
  searchParams: URLSearchParams,
  body: unknown,
  label = "operator route",
): { ok: true; sessionId: string } | { ok: false; error: string } {
  const fromBody = bodySessionId(body);
  const fromQuery = trimmedString(searchParams.get("sessionId"));
  const authoritative = method === "POST" ? fromBody : fromQuery;
  const other = method === "POST" ? fromQuery : fromBody;

  if (!authoritative) return { ok: false, error: `${label} requires a session id` };
  if (other && other !== authoritative) {
    return { ok: false, error: "conflicting session ids in request body and query" };
  }
  return { ok: true, sessionId: authoritative };
}

function assertSharedGuestSession(
  actor: RemoteActor,
  method: "GET" | "POST",
  searchParams: URLSearchParams,
  context: RemoteAccessContext,
): RemoteAccessDecision {
  if (!actor.shareSessionId) {
    return { ok: false, status: 403, error: "shared guest route requires an authorized share session" };
  }
  const session = authorizedSessionId(method, searchParams, context.body, "shared session route");
  if (!session.ok) return { ok: false, status: 403, error: session.error };
  if (session.sessionId !== actor.shareSessionId) {
    return { ok: false, status: 403, error: "shared guest cannot access another session" };
  }
  return { ok: true };
}

/**
 * The proxied sub-path an operator is asking for, or a refusal.
 *
 * `denied` rather than an `ok` flag: `RemoteAccessDecision` is not a
 * discriminated union, so a success-shaped value returned here would type-check
 * as a decision and skip the grant check entirely.
 */
function operatorSubPath(
  actor: RemoteActor,
  pathname: string,
): { denied: RemoteAccessDecision } | { denied?: undefined; principal: HostedPrincipal; subPath: string } {
  const principal = actor.principal;
  if (!principal) {
    return { denied: { ok: false, status: 403, error: "operator actor is missing its principal" } };
  }

  const proxyMatch = pathname.match(PROXY_PATH_PATTERN);
  if (!proxyMatch) {
    return { denied: { ok: false, status: 403, error: "operators cannot access daemon routes" } };
  }

  return { principal, subPath: proxyMatch[1] || "/" };
}

/** The grant check both gates share: a session id, bound to a project root. */
function assertGrantedSession(
  principal: HostedPrincipal,
  method: "GET" | "POST",
  searchParams: URLSearchParams,
  context: RemoteAccessContext,
): RemoteAccessDecision {
  // Without a project root the grant check would compare session ids alone, and
  // a grant in one project would authorize the same name in another.
  const projectRoot = context.projectRoot;
  if (!projectRoot) return { ok: false, status: 403, error: "operator request could not be bound to a project" };

  const session = authorizedSessionId(method, searchParams, context.body);
  if (!session.ok) return { ok: false, status: 403, error: session.error };

  if (!principalHasGrant(principal, { projectRoot, sessionId: session.sessionId })) {
    return { ok: false, status: 403, error: "operator is not granted this session" };
  }

  return { ok: true };
}

function assertOperatorAllowed(
  actor: RemoteActor,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  context: RemoteAccessContext,
): RemoteAccessDecision {
  const resolved = operatorSubPath(actor, pathname);
  if (resolved.denied) return resolved.denied;

  const allowedMethod =
    OPERATOR_ROUTE_METHODS.get(resolved.subPath) ??
    OPERATOR_ROUTE_PATTERNS.find((route) => route.pattern.test(resolved.subPath))?.method;
  if (!allowedMethod) return { ok: false, status: 403, error: "route is not available to operators" };
  if (method.toUpperCase() !== allowedMethod) {
    return { ok: false, status: 403, error: "method not allowed for this route" };
  }

  return assertGrantedSession(resolved.principal, allowedMethod, searchParams, context);
}

/**
 * The streaming gate, deliberately a separate entry point.
 *
 * A boolean on the shared context would fail open: a caller that forgot to set
 * it would silently get the other allowlist. Streams and buffered requests are
 * served by different machinery and must be asked for by name.
 */
export function assertOperatorStreamAllowed(
  actor: RemoteActor | null,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  context: RemoteAccessContext = {},
): RemoteAccessDecision {
  // Null denies rather than throwing, and unlike the buffered gate it does NOT
  // mean "local, allow everything": nothing reaches this without a verified
  // token, so a null actor here is a bug, and a bug must fail closed.
  if (actor?.role !== "operator") return { ok: false, status: 403, error: "streaming requires an operator" };
  if (method.toUpperCase() !== "GET") return { ok: false, status: 403, error: "streams are GET only" };

  const resolved = operatorSubPath(actor, pathname);
  if (resolved.denied) return resolved.denied;

  if (!OPERATOR_STREAM_ROUTES.has(resolved.subPath)) {
    return { ok: false, status: 403, error: "route is not available to operators" };
  }

  return assertGrantedSession(resolved.principal, "GET", searchParams, context);
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (typeof direct === "string") return direct.trim() || undefined;
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value.trim() || undefined;
  }
  return undefined;
}

function hasRelayActorHeaders(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((key) => key.toLowerCase().startsWith(RELAY_HEADER_PREFIX));
}

function actorFromJson(value: string): Partial<RemoteActor> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return {
      role: record.role === "owner" || record.role === "guest" ? record.role : undefined,
      userId: typeof record.userId === "string" ? record.userId : undefined,
      displayName: typeof record.displayName === "string" ? record.displayName : undefined,
      email: typeof record.email === "string" ? record.email : undefined,
    };
  } catch {
    return null;
  }
}

export function parseRemoteActor(headers: Record<string, string> | undefined): RemoteActor | null {
  const actorJson = headerValue(headers, ACTOR_HEADER);
  const jsonActor = actorJson ? actorFromJson(actorJson) : null;
  const role = headerValue(headers, ROLE_HEADER) ?? jsonActor?.role;
  if (!role) {
    return hasRelayActorHeaders(headers) ? { role: "guest" } : null;
  }
  // Only owner and guest are mintable from headers. "operator" in particular
  // must degrade rather than pass: hosted mode constructs operators from a
  // verified bearer token, so a header claiming the role is forgery.
  if (role !== "owner" && role !== "guest") {
    return { role: "guest" };
  }
  return {
    role,
    userId: headerValue(headers, USER_ID_HEADER) ?? jsonActor?.userId,
    displayName: headerValue(headers, DISPLAY_NAME_HEADER) ?? jsonActor?.displayName,
    email: headerValue(headers, EMAIL_HEADER) ?? jsonActor?.email,
    shareId: headerValue(headers, SHARE_ID_HEADER),
    shareSessionId: headerValue(headers, SHARE_SESSION_ID_HEADER),
  };
}

export function assertRemoteAccessAllowed(
  actor: RemoteActor | null,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  context: RemoteAccessContext = {},
): RemoteAccessDecision {
  if (!actor || actor.role === "owner") return { ok: true };
  if (actor.role === "operator") return assertOperatorAllowed(actor, method, pathname, searchParams, context);
  if (actor.role !== "guest") return { ok: false, status: 403, error: "remote actor role is not allowed" };
  const methodName = method.toUpperCase();
  if (methodName === "GET" && pathname === "/health") return { ok: true };

  const proxyMatch = pathname.match(PROXY_PATH_PATTERN);
  if (!proxyMatch) return { ok: false, status: 403, error: "shared guests cannot access daemon routes" };

  const subPath = proxyMatch[1] || "/";
  if (
    methodName === "GET" &&
    (SHARED_GUEST_SESSION_READ_ROUTES.has(subPath) || ATTACHMENT_CONTENT_ROUTE.test(subPath))
  ) {
    return assertSharedGuestSession(actor, "GET", searchParams, context);
  }

  if (methodName === "POST" && SHARED_GUEST_SESSION_WRITE_ROUTES.has(subPath)) {
    const sessionDecision = assertSharedGuestSession(actor, "POST", searchParams, context);
    if (!sessionDecision.ok) return sessionDecision;
    if (subPath === PROJECT_API_ROUTES.livePane.input && !bodyText(context.body) && !bodyHasAttachments(context.body)) {
      return { ok: false, status: 403, error: "shared guest input requires text or attachments" };
    }
    return { ok: true };
  }

  if (methodName !== "GET") {
    return { ok: false, status: 403, error: "shared guests can only write to their shared session" };
  }
  return { ok: false, status: 403, error: "shared guests can only read shared session output and attachments" };
}
