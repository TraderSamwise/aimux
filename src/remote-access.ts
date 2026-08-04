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

const PROXY_PATH_PATTERN = /^\/proxy\/[^/]+\/\d+(\/.*)$/;

/**
 * Every route an operator may reach, and the only method each accepts.
 *
 * Deny-by-default: a route added elsewhere in the codebase is unreachable to
 * operators until someone deliberately lists it here. `/agents` (list) is
 * absent on purpose — it returns every session in the project, which would leak
 * other principals' session ids. So are `/agents/output/stream` and `/events`,
 * which need a streaming path this gate does not yet cover.
 */
const OPERATOR_ROUTE_METHODS = new Map<string, "GET" | "POST">([
  [PROJECT_API_ROUTES.agents.output, "GET"],
  [PROJECT_API_ROUTES.agents.input, "POST"],
  [PROJECT_API_ROUTES.agents.interrupt, "POST"],
]);

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bodySessionId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  return trimmedString((body as Record<string, unknown>).sessionId);
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
): { ok: true; sessionId: string } | { ok: false; error: string } {
  const fromBody = bodySessionId(body);
  const fromQuery = trimmedString(searchParams.get("sessionId"));
  const authoritative = method === "POST" ? fromBody : fromQuery;
  const other = method === "POST" ? fromQuery : fromBody;

  if (!authoritative) return { ok: false, error: "operator route requires a session id" };
  if (other && other !== authoritative) {
    return { ok: false, error: "conflicting session ids in request body and query" };
  }
  return { ok: true, sessionId: authoritative };
}

function assertOperatorAllowed(
  actor: RemoteActor,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  context: RemoteAccessContext,
): RemoteAccessDecision {
  const principal = actor.principal;
  if (!principal) return { ok: false, status: 403, error: "operator actor is missing its principal" };

  const proxyMatch = pathname.match(PROXY_PATH_PATTERN);
  if (!proxyMatch) return { ok: false, status: 403, error: "operators cannot access daemon routes" };

  const subPath = proxyMatch[1] || "/";
  const allowedMethod = OPERATOR_ROUTE_METHODS.get(subPath);
  if (!allowedMethod) return { ok: false, status: 403, error: "route is not available to operators" };
  if (method.toUpperCase() !== allowedMethod) {
    return { ok: false, status: 403, error: "method not allowed for this route" };
  }

  // Without a project root the grant check would compare session ids alone, and
  // a grant in one project would authorize the same name in another.
  const projectRoot = context.projectRoot;
  if (!projectRoot) return { ok: false, status: 403, error: "operator request could not be bound to a project" };

  const session = authorizedSessionId(allowedMethod, searchParams, context.body);
  if (!session.ok) return { ok: false, status: 403, error: session.error };

  if (!principalHasGrant(principal, { projectRoot, sessionId: session.sessionId })) {
    return { ok: false, status: 403, error: "operator is not granted this session" };
  }

  return { ok: true };
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
  if (method !== "GET") return { ok: false, status: 403, error: "shared guests are read-only" };
  if (pathname === "/health") return { ok: true };

  const proxyMatch = pathname.match(/^\/proxy\/[^/]+\/\d+(\/.*)$/);
  if (!proxyMatch) return { ok: false, status: 403, error: "shared guests cannot access daemon routes" };

  const subPath = proxyMatch[1] || "/";
  if (SHARED_GUEST_SESSION_READ_ROUTES.has(subPath)) {
    if (!actor.shareSessionId) {
      return { ok: false, status: 403, error: "shared guest route requires an authorized share session" };
    }
    const requestedSessionId = searchParams.get("sessionId");
    if (!requestedSessionId) {
      return { ok: false, status: 403, error: "shared session route requires a session id" };
    }
    if (requestedSessionId !== actor.shareSessionId) {
      return { ok: false, status: 403, error: "shared guest cannot access another session" };
    }
    return { ok: true };
  }

  return { ok: false, status: 403, error: "shared guests can only read shared session output" };
}
