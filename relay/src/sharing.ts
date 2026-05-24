const SHARING_STATE_KEY = "sharing-state:v1";
const INVITE_TOKEN_BYTES = 32;
const MAX_SHARES = 200;
const MAX_INVITES_PER_SHARE = 50;
export const SHARE_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ShareParticipantRole = "owner" | "guest";
export type ShareParticipantStatus = "active" | "removed";
export type ShareInviteStatus = "pending" | "accepted" | "revoked";
export type ShareChatMode = "single" | "multi";

export interface ShareActor {
  userId: string;
  displayName: string;
  email?: string;
  role: ShareParticipantRole;
}

export interface ShareParticipantRecord extends ShareActor {
  status: ShareParticipantStatus;
  joinedAt: string;
  removedAt?: string;
  lastSeenAt?: string;
}

export interface ShareInviteRecord {
  id: string;
  email: string;
  tokenHash: string;
  status: ShareInviteStatus;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  acceptedByUserId?: string;
  revokedAt?: string;
}

export interface SharedSessionRecord {
  id: string;
  ownerUserId: string;
  projectRoot: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  participants: Record<string, ShareParticipantRecord>;
  invites: Record<string, ShareInviteRecord>;
}

export interface SharingState {
  version: 1;
  shares: Record<string, SharedSessionRecord>;
}

export interface ShareInviteToken {
  token: string;
  share: SharedSessionRecord;
  invite: ShareInviteRecord;
}

export interface CreateShareInviteInput {
  owner: ShareActor;
  projectRoot: string;
  sessionId: string;
  email: string;
  now?: string;
}

export interface AcceptShareInviteInput {
  token: string;
  actor: ShareActor;
  now?: string;
}

export function emptySharingState(): SharingState {
  return { version: 1, shares: {} };
}

export async function loadSharingState(storage: DurableObjectStorage): Promise<SharingState> {
  const stored = await storage.get<SharingState>(SHARING_STATE_KEY);
  if (!stored || stored.version !== 1) return emptySharingState();
  return normalizeSharingState(stored);
}

export async function saveSharingState(storage: DurableObjectStorage, state: SharingState): Promise<void> {
  await storage.put(SHARING_STATE_KEY, normalizeSharingState(state));
}

export function normalizeSharingState(state: SharingState): SharingState {
  const shares = Object.fromEntries(
    Object.values(state.shares ?? {})
      .map(normalizeShare)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, MAX_SHARES)
      .map((share) => [share.id, share]),
  );
  return { version: 1, shares };
}

export function getShareChatMode(share: SharedSessionRecord): ShareChatMode {
  return activeParticipants(share).length >= 2 ? "multi" : "single";
}

export function activeParticipants(share: SharedSessionRecord): ShareParticipantRecord[] {
  return Object.values(share.participants).filter((participant) => participant.status === "active");
}

export function findShareForSession(
  state: SharingState,
  ownerUserId: string,
  sessionId: string,
): SharedSessionRecord | undefined {
  return Object.values(state.shares).find(
    (share) => share.ownerUserId === ownerUserId && share.sessionId === sessionId,
  );
}

export async function createShareInvite(
  state: SharingState,
  input: CreateShareInviteInput,
): Promise<{ state: SharingState; token: ShareInviteToken }> {
  const now = input.now ?? new Date().toISOString();
  const owner = sanitizeActor(input.owner, "owner");
  const email = normalizeEmail(input.email);
  if (!email) throw new Error("Invite email is required");
  const sessionId = sanitizeRequiredText(input.sessionId, 160, "sessionId");
  const projectRoot = sanitizeRequiredText(input.projectRoot, 600, "projectRoot");
  const current = normalizeSharingState(state);
  const share =
    findShareForSession(current, owner.userId, sessionId) ?? createShare({ owner, projectRoot, sessionId, now });

  const token = randomBase64Url(INVITE_TOKEN_BYTES);
  const invite: ShareInviteRecord = {
    id: randomBase64Url(16),
    email,
    tokenHash: await sha256Base64Url(token),
    status: "pending",
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + SHARE_INVITE_TTL_MS).toISOString(),
  };
  share.invites[invite.id] = invite;
  share.updatedAt = now;
  share.version += 1;
  current.shares[share.id] = normalizeShare(share);
  return { state: normalizeSharingState(current), token: { token, share: current.shares[share.id], invite } };
}

export async function acceptShareInvite(
  state: SharingState,
  input: AcceptShareInviteInput,
): Promise<{ state: SharingState; share: SharedSessionRecord; participant: ShareParticipantRecord }> {
  const now = input.now ?? new Date().toISOString();
  const tokenHash = await sha256Base64Url(input.token);
  const current = normalizeSharingState(state);
  const match = findInviteByTokenHash(current, tokenHash);
  if (!match) throw new Error("Invite is invalid, expired, or already used");
  const { share, invite } = match;
  const actor = sanitizeActor(input.actor, "guest");
  const actorEmail = normalizeEmail(actor.email);
  if (actorEmail && actorEmail !== invite.email) {
    throw new Error("Invite email does not match authenticated user");
  }

  const participant: ShareParticipantRecord = {
    ...actor,
    email: actorEmail ?? invite.email,
    role: "guest",
    status: "active",
    joinedAt: now,
    lastSeenAt: now,
  };
  invite.status = "accepted";
  invite.acceptedAt = now;
  invite.acceptedByUserId = actor.userId;
  share.participants[participant.userId] = participant;
  share.updatedAt = now;
  share.version += 1;
  current.shares[share.id] = normalizeShare(share);
  return { state: normalizeSharingState(current), share: current.shares[share.id], participant };
}

export function removeShareParticipant(
  state: SharingState,
  shareId: string,
  userId: string,
  now = new Date().toISOString(),
): { state: SharingState; share?: SharedSessionRecord } {
  const current = normalizeSharingState(state);
  const share = current.shares[shareId];
  if (!share) return { state: current };
  const participant = share.participants[userId];
  if (!participant || participant.role === "owner") return { state: current, share };
  share.participants[userId] = { ...participant, status: "removed", removedAt: now };
  share.updatedAt = now;
  share.version += 1;
  current.shares[share.id] = normalizeShare(share);
  return { state: normalizeSharingState(current), share: current.shares[share.id] };
}

export function isSharedRelayRequestAllowed(
  input: { method: string; path: string; sessionId?: string },
  share: SharedSessionRecord,
): boolean {
  const method = input.method.toUpperCase();
  const path = normalizePath(input.path);
  const sessionId = input.sessionId?.trim();

  if (sessionId && sessionId !== share.sessionId) return false;
  if (method === "GET" && (path === "/agents/history" || path === "/agents/output" || path === "/events")) return true;
  if (method === "POST" && path === "/agents/input") return true;
  if ((method === "GET" || method === "POST") && (path === "/attachments" || path.startsWith("/attachments/"))) {
    return true;
  }
  return false;
}

export function actorDisplayPrefix(actor: ShareActor): string {
  return `[${sanitizeDisplayName(actor.displayName)}]:`;
}

function createShare(input: {
  owner: ShareActor;
  projectRoot: string;
  sessionId: string;
  now: string;
}): SharedSessionRecord {
  const owner: ShareParticipantRecord = {
    ...input.owner,
    role: "owner",
    status: "active",
    joinedAt: input.now,
    lastSeenAt: input.now,
  };
  return {
    id: randomBase64Url(16),
    ownerUserId: owner.userId,
    projectRoot: input.projectRoot,
    sessionId: input.sessionId,
    createdAt: input.now,
    updatedAt: input.now,
    version: 1,
    participants: { [owner.userId]: owner },
    invites: {},
  };
}

function normalizeShare(share: SharedSessionRecord): SharedSessionRecord {
  const nowMs = Date.now();
  const invites = Object.fromEntries(
    Object.values(share.invites ?? {})
      .filter((invite) => {
        if (invite.status !== "pending") return true;
        const expiresAtMs = Date.parse(invite.expiresAt);
        return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, MAX_INVITES_PER_SHARE)
      .map((invite) => [invite.id, invite]),
  );
  return {
    ...share,
    version: Number.isFinite(share.version) ? share.version : 1,
    participants: share.participants ?? {},
    invites,
  };
}

function findInviteByTokenHash(
  state: SharingState,
  tokenHash: string,
): { share: SharedSessionRecord; invite: ShareInviteRecord } | undefined {
  const nowMs = Date.now();
  for (const share of Object.values(state.shares)) {
    for (const invite of Object.values(share.invites)) {
      if (invite.tokenHash !== tokenHash) continue;
      if (invite.status !== "pending") return undefined;
      const expiresAtMs = Date.parse(invite.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return undefined;
      return { share, invite };
    }
  }
  return undefined;
}

function sanitizeActor(actor: ShareActor, fallbackRole: ShareParticipantRole): ShareActor {
  return {
    userId: sanitizeRequiredText(actor.userId, 160, "userId"),
    displayName: sanitizeDisplayName(actor.displayName),
    email: normalizeEmail(actor.email),
    role: actor.role === "owner" || actor.role === "guest" ? actor.role : fallbackRole,
  };
}

function sanitizeDisplayName(value: string | undefined): string {
  const trimmed = value?.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, 80) : "User";
}

function sanitizeRequiredText(value: string | undefined, maxLength: number, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed.slice(0, maxLength);
}

function normalizeEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) throw new Error("Invalid email address");
  return trimmed.slice(0, 254);
}

function normalizePath(path: string): string {
  const pathname = path.startsWith("http") ? new URL(path).pathname : path.split("?")[0];
  return pathname.replace(/\/+$/, "") || "/";
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
