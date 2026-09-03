export type RemoteActorRole = "owner" | "guest" | "operator";

export interface RemoteOperatorGrant {
  projectRoot: string;
  sessionId: string;
}

export interface RemoteOperatorPrincipal {
  id: string;
  label: string;
  role: "operator";
  grants: RemoteOperatorGrant[];
}

export interface RemoteActor {
  role: RemoteActorRole;
  userId?: string;
  displayName?: string;
  email?: string;
  shareId?: string;
  shareSessionId?: string;
  principal?: RemoteOperatorPrincipal;
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
