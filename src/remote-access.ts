export type RemoteActorRole = "owner" | "guest";

export interface RemoteActor {
  role: RemoteActorRole;
  userId?: string;
  displayName?: string;
  email?: string;
  shareId?: string;
  shareSessionId?: string;
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
): RemoteAccessDecision {
  if (!actor || actor.role === "owner") return { ok: true };
  if (actor.role !== "guest") return { ok: false, status: 403, error: "remote actor role is not allowed" };
  if (method !== "GET") return { ok: false, status: 403, error: "shared guests are read-only" };
  if (pathname === "/health") return { ok: true };

  const proxyMatch = pathname.match(/^\/proxy\/[^/]+\/\d+(\/.*)$/);
  if (!proxyMatch) return { ok: false, status: 403, error: "shared guests cannot access daemon routes" };

  const subPath = proxyMatch[1] || "/";
  if (subPath === "/agents/output" || subPath === "/agents/history" || subPath === "/events") {
    if (!actor.shareSessionId) {
      return { ok: false, status: 403, error: "shared guest route requires an authorized share session" };
    }
    const requestedSessionId = searchParams.get("sessionId") ?? searchParams.get("session");
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
