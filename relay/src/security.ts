const SECURITY_STATE_KEY = "security-state:v1";
const SECURITY_ACTION_TOKEN_BYTES = 32;
export const SECURITY_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SECURITY_EVENTS = 100;
const MAX_SECURITY_ACTIONS = 100;
const MAX_DEVICE_PROOF_NONCES = 1000;
const DEVICE_PROOF_WINDOW_MS = 5 * 60 * 1000;

export type SecurityDeviceKind = "web" | "ios" | "android" | "daemon" | "unknown";

export interface SecurityDeviceInfo {
  deviceId: string;
  kind: SecurityDeviceKind;
  name?: string;
  platform?: string;
  appVersion?: string;
  approvalCode?: string;
}

export interface SecurityConnectionContext {
  ipHash?: string;
  country?: string;
  userAgent?: string;
  deviceProof?: VerifiedDeviceProof;
  shared?: {
    shareId: string;
    sessionId: string;
    actorUserId: string;
    actorName: string;
    actorEmail?: string;
  };
}

export interface SecurityDeviceRecord extends SecurityDeviceInfo {
  id: string;
  firstSeenAt: string;
  lastSeenAt: string;
  approvedAt?: string;
  blockedAt?: string;
  publicKeyAlg?: "ES256";
  publicKeyJwk?: JsonWebKey;
  publicKeyRegisteredAt?: string;
  lastProofAt?: string;
  lastIpHash?: string;
  lastCountry?: string;
  lastUserAgent?: string;
}

export interface DeviceProofInput {
  alg?: string | null;
  publicKeyJwk?: unknown;
  timestamp?: string | null;
  nonce?: string | null;
  signature?: string | null;
}

export interface VerifiedDeviceProof {
  alg: "ES256";
  publicKeyJwk: JsonWebKey;
  verifiedAt: string;
  nonce: string;
}

export type DeviceProofPolicy = "warn" | "enforce" | undefined;

export type DeviceProofVerificationResult =
  | { ok: true; proof: VerifiedDeviceProof; firstRegistration: boolean }
  | { ok: false; reason: string };

export type SecurityEventKind =
  | "client_connected"
  | "new_client_detected"
  | "shared_client_connected"
  | "shared_invite_accepted"
  | "shared_participant_left"
  | "shared_participant_removed"
  | "device_approved"
  | "device_blocked"
  | "emergency_lockdown"
  | "security_unlocked";

export interface SecurityEventRecord {
  id: string;
  kind: SecurityEventKind;
  deviceId?: string;
  shareId?: string;
  sessionId?: string;
  actorUserId?: string;
  actorName?: string;
  actorEmail?: string;
  targetUserId?: string;
  targetName?: string;
  targetEmail?: string;
  title: string;
  body: string;
  createdAt: string;
  approvalCode?: string;
  country?: string;
  userAgent?: string;
}

export type SecurityActionKind = "approve_device" | "emergency_lockdown";

export interface SecurityActionRecord {
  id: string;
  kind: SecurityActionKind;
  tokenHash: string;
  deviceId?: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

export interface SecurityLockdownRecord {
  active: boolean;
  startedAt: string;
  reason: string;
}

export interface SecurityPushTokenRecord {
  userId?: string;
  deviceId: string;
  token: string;
  platform: "ios" | "android" | "web" | "unknown";
  agentAlerts?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SecurityState {
  version: 1;
  devices: Record<string, SecurityDeviceRecord>;
  pushTokens: Record<string, SecurityPushTokenRecord>;
  actions: Record<string, SecurityActionRecord>;
  proofNonces?: Record<string, SecurityProofNonceRecord>;
  events: SecurityEventRecord[];
  lockdown?: SecurityLockdownRecord;
  revokedBefore?: string;
}

export interface SecurityProofNonceRecord {
  deviceId: string;
  nonce: string;
  expiresAt: string;
}

export interface SecurityActionToken {
  token: string;
  action: SecurityActionRecord;
}

export function emptySecurityState(): SecurityState {
  return {
    version: 1,
    devices: {},
    pushTokens: {},
    actions: {},
    proofNonces: {},
    events: [],
  };
}

export async function loadSecurityState(storage: DurableObjectStorage): Promise<SecurityState> {
  const stored = await storage.get<SecurityState>(SECURITY_STATE_KEY);
  if (!stored || stored.version !== 1) return emptySecurityState();
  return normalizeSecurityState(stored);
}

export async function saveSecurityState(storage: DurableObjectStorage, state: SecurityState): Promise<void> {
  await storage.put(SECURITY_STATE_KEY, normalizeSecurityState(state));
}

export function normalizeSecurityState(state: SecurityState): SecurityState {
  const nowMs = Date.now();
  const actions = Object.fromEntries(
    Object.entries(state.actions ?? {})
      .filter(([, action]) => {
        if (action.usedAt) return false;
        const expiresAtMs = Date.parse(action.expiresAt);
        return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
      })
      .sort(([, a], [, b]) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, MAX_SECURITY_ACTIONS),
  );
  const proofNonces = Object.fromEntries(
    Object.entries(state.proofNonces ?? {})
      .filter(([, nonce]) => {
        const expiresAtMs = Date.parse(nonce.expiresAt);
        return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
      })
      .sort(([, a], [, b]) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))
      .slice(0, MAX_DEVICE_PROOF_NONCES),
  );

  return {
    version: 1,
    devices: state.devices ?? {},
    pushTokens: state.pushTokens ?? {},
    actions,
    proofNonces,
    events: Array.isArray(state.events) ? state.events.slice(0, MAX_SECURITY_EVENTS) : [],
    lockdown: state.lockdown,
    revokedBefore: state.revokedBefore,
  };
}

export function sanitizeDeviceInfo(
  input:
    | {
        deviceId?: string;
        kind?: string;
        name?: string;
        platform?: string;
        appVersion?: string;
        approvalCode?: string;
      }
    | null
    | undefined,
): SecurityDeviceInfo {
  const rawKind = input?.kind;
  const kind: SecurityDeviceKind =
    rawKind === "web" || rawKind === "ios" || rawKind === "android" || rawKind === "daemon" ? rawKind : "unknown";
  const deviceId = sanitizeId(input?.deviceId);
  if (!deviceId) {
    throw new Error("Missing or invalid deviceId");
  }
  return {
    deviceId,
    kind,
    name: sanitizeText(input?.name, 80),
    platform: sanitizeText(input?.platform, 80),
    appVersion: sanitizeText(input?.appVersion, 40),
    approvalCode: sanitizeApprovalCode(input?.approvalCode),
  };
}

export async function hashIpAddress(
  ip: string | null | undefined,
  secret: string | null | undefined,
): Promise<string | undefined> {
  const normalized = ip?.trim();
  const key = secret?.trim();
  if (!normalized || !key) return undefined;
  return hmacSha256Base64Url(key, normalized);
}

export function recordClientConnection(
  state: SecurityState,
  deviceInfo: SecurityDeviceInfo,
  context: SecurityConnectionContext,
  now = new Date().toISOString(),
): { state: SecurityState; device: SecurityDeviceRecord; firstSeen: boolean; events: SecurityEventRecord[] } {
  const next = normalizeSecurityState(state);
  const normalizedDeviceInfo = context.shared
    ? {
        ...deviceInfo,
        deviceId: sharedDeviceId(context.shared, deviceInfo.deviceId),
      }
    : deviceInfo;
  const previous = next.devices[normalizedDeviceInfo.deviceId];
  if (
    context.deviceProof &&
    previous?.publicKeyJwk &&
    !sameDevicePublicKey(previous.publicKeyJwk, context.deviceProof.publicKeyJwk)
  ) {
    throw new Error("Device proof key mismatch");
  }
  const firstSeen = !previous;
  const firstProofRegistration = Boolean(context.deviceProof && !previous?.publicKeyJwk);
  const device: SecurityDeviceRecord = {
    ...previous,
    ...normalizedDeviceInfo,
    id: normalizedDeviceInfo.deviceId,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    approvedAt: firstProofRegistration ? undefined : previous?.approvedAt,
    blockedAt: previous?.blockedAt,
    publicKeyAlg: context.deviceProof?.alg ?? previous?.publicKeyAlg,
    publicKeyJwk: context.deviceProof?.publicKeyJwk ?? previous?.publicKeyJwk,
    publicKeyRegisteredAt:
      context.deviceProof && !previous?.publicKeyJwk ? context.deviceProof.verifiedAt : previous?.publicKeyRegisteredAt,
    lastProofAt: context.deviceProof?.verifiedAt ?? previous?.lastProofAt,
    lastIpHash: context.ipHash ?? previous?.lastIpHash,
    lastCountry: context.country ?? previous?.lastCountry,
    lastUserAgent: context.userAgent ?? previous?.lastUserAgent,
  };
  next.devices[device.id] = device;

  const events: SecurityEventRecord[] = context.shared
    ? [buildSecurityEvent("shared_client_connected", device, context, now)]
    : [buildSecurityEvent("client_connected", device, context, now)];
  if (!context.shared && firstSeen) events.push(buildSecurityEvent("new_client_detected", device, context, now));
  for (const event of events) appendSecurityEvent(next, event);
  return { state: next, device, firstSeen, events };
}

export function isSecurityLockedDown(state: SecurityState): boolean {
  return state.lockdown?.active === true;
}

export function isDaemonTokenRevoked(state: SecurityState, issuedAtSeconds: number): boolean {
  if (!state.revokedBefore) return false;
  const revokedBeforeMs = Date.parse(state.revokedBefore);
  if (!Number.isFinite(revokedBeforeMs)) return false;
  return issuedAtSeconds * 1000 < revokedBeforeMs;
}

export function isDeviceApproved(device: SecurityDeviceRecord | undefined): boolean {
  return Boolean(device?.approvedAt && !device.blockedAt);
}

export function securityDeviceApprovalCode(device: SecurityDeviceRecord | SecurityDeviceInfo): string {
  if (device.approvalCode) return device.approvalCode;
  const input = [
    device.deviceId,
    device.kind,
    device.name ?? "",
    device.platform ?? "",
    "publicKeyJwk" in device && device.publicKeyJwk ? JSON.stringify(device.publicKeyJwk) : "",
  ].join("\n");
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let value = hash;
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[value & 31];
    value >>>= 5;
  }
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

export function normalizeSecurityDeviceApprovalCode(value: string | undefined | null): string | undefined {
  return sanitizeApprovalCode(value);
}

export function shouldEnforceDeviceProof(policy: DeviceProofPolicy): boolean {
  return policy === "enforce";
}

export function deviceProofMatchesRecord(
  device: SecurityDeviceRecord | undefined,
  proof: VerifiedDeviceProof | undefined,
): boolean {
  if (!proof || !device?.publicKeyJwk) return true;
  return sameDevicePublicKey(device.publicKeyJwk, proof.publicKeyJwk);
}

export function consumeDeviceProofNonce(
  state: SecurityState,
  deviceId: string,
  proof: VerifiedDeviceProof,
): { ok: true; state: SecurityState } | { ok: false; state: SecurityState; reason: string } {
  const next = normalizeSecurityState(state);
  const key = deviceProofNonceKey(deviceId, proof.nonce);
  if (next.proofNonces?.[key]) {
    return { ok: false, state: next, reason: "Device proof replay detected" };
  }
  const verifiedAtMs = Date.parse(proof.verifiedAt);
  const expiresAt = new Date((Number.isFinite(verifiedAtMs) ? verifiedAtMs : Date.now()) + DEVICE_PROOF_WINDOW_MS);
  next.proofNonces = {
    ...(next.proofNonces ?? {}),
    [key]: {
      deviceId,
      nonce: proof.nonce,
      expiresAt: expiresAt.toISOString(),
    },
  };
  return { ok: true, state: next };
}

export async function verifyDeviceProof(
  device: SecurityDeviceRecord | undefined,
  deviceId: string,
  input: DeviceProofInput,
  now = new Date(),
): Promise<DeviceProofVerificationResult> {
  if (input.alg !== "ES256") return { ok: false, reason: "Missing device proof algorithm" };
  if (!isValidProofText(input.timestamp, 80)) return { ok: false, reason: "Missing device proof timestamp" };
  if (!isValidProofText(input.nonce, 160)) return { ok: false, reason: "Missing device proof nonce" };
  if (!isValidProofText(input.signature, 2000)) return { ok: false, reason: "Missing device proof signature" };
  const timestampMs = Date.parse(input.timestamp);
  if (!Number.isFinite(timestampMs)) return { ok: false, reason: "Invalid device proof timestamp" };
  if (Math.abs(now.getTime() - timestampMs) > 5 * 60 * 1000) {
    return { ok: false, reason: "Expired device proof timestamp" };
  }
  const publicKeyJwk = sanitizeDevicePublicKey(input.publicKeyJwk);
  if (!publicKeyJwk) return { ok: false, reason: "Invalid device proof public key" };
  if (device?.publicKeyJwk && !sameDevicePublicKey(device.publicKeyJwk, publicKeyJwk)) {
    return { ok: false, reason: "Device proof key mismatch" };
  }

  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(input.signature);
  } catch {
    return { ok: false, reason: "Invalid device proof signature encoding" };
  }

  const message = deviceProofMessage(deviceId, input.timestamp, input.nonce);
  try {
    const key = await crypto.subtle.importKey("jwk", publicKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      exactArrayBuffer(signature),
      exactArrayBuffer(new TextEncoder().encode(message)),
    );
    if (!verified) return { ok: false, reason: "Invalid device proof signature" };
  } catch {
    return { ok: false, reason: "Invalid device proof public key" };
  }

  return {
    ok: true,
    firstRegistration: !device?.publicKeyJwk,
    proof: {
      alg: "ES256",
      publicKeyJwk,
      verifiedAt: new Date(timestampMs).toISOString(),
      nonce: input.nonce,
    },
  };
}

export function deviceProofMessage(deviceId: string, timestamp: string, nonce: string): string {
  return `aimux-device-proof-v1\n${deviceId}\n${timestamp}\n${nonce}`;
}

export function notificationPushTokensForDevicePolicy(
  state: SecurityState,
  policy: "warn" | "enforce" | undefined,
): SecurityPushTokenRecord[] {
  const tokens = Object.values(state.pushTokens);
  if (policy !== "enforce") return tokens;
  return tokens.filter((record) => isDeviceApproved(state.devices[record.deviceId]));
}

export function approveSecurityDevice(
  state: SecurityState,
  deviceId: string,
  now = new Date().toISOString(),
): { state: SecurityState; device: SecurityDeviceRecord | null; event: SecurityEventRecord | null } {
  const next = normalizeSecurityState(state);
  const device = next.devices[sanitizeId(deviceId) ?? ""];
  if (!device) return { state: next, device: null, event: null };
  const approvedDevice: SecurityDeviceRecord = {
    ...device,
    approvedAt: now,
    blockedAt: undefined,
  };
  next.devices[approvedDevice.id] = approvedDevice;
  const event = buildDeviceActionEvent("device_approved", approvedDevice, now);
  appendSecurityEvent(next, event);
  return { state: next, device: approvedDevice, event };
}

export function blockSecurityDevice(
  state: SecurityState,
  deviceId: string,
  now = new Date().toISOString(),
): { state: SecurityState; device: SecurityDeviceRecord | null; event: SecurityEventRecord | null } {
  const next = normalizeSecurityState(state);
  const device = next.devices[sanitizeId(deviceId) ?? ""];
  if (!device) return { state: next, device: null, event: null };
  const blockedDevice: SecurityDeviceRecord = {
    ...device,
    approvedAt: undefined,
    blockedAt: now,
  };
  next.devices[blockedDevice.id] = blockedDevice;
  const event = buildDeviceActionEvent("device_blocked", blockedDevice, now);
  appendSecurityEvent(next, event);
  return { state: next, device: blockedDevice, event };
}

export function unblockSecurityDevice(
  state: SecurityState,
  deviceId: string,
): { state: SecurityState; device: SecurityDeviceRecord | null } {
  const next = normalizeSecurityState(state);
  const device = next.devices[sanitizeId(deviceId) ?? ""];
  if (!device) return { state: next, device: null };
  const unblockedDevice: SecurityDeviceRecord = {
    ...device,
    blockedAt: undefined,
  };
  next.devices[unblockedDevice.id] = unblockedDevice;
  return { state: next, device: unblockedDevice };
}

export async function createSecurityActionToken(
  kind: SecurityActionKind,
  opts: { deviceId?: string; now?: string } = {},
): Promise<SecurityActionToken> {
  const now = opts.now ?? new Date().toISOString();
  const token = randomBase64Url(SECURITY_ACTION_TOKEN_BYTES);
  const tokenHash = await sha256Base64Url(token);
  const action: SecurityActionRecord = {
    id: randomBase64Url(16),
    kind,
    tokenHash,
    deviceId: opts.deviceId,
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + SECURITY_ACTION_TTL_MS).toISOString(),
  };
  return { token, action };
}

export async function findSecurityActionByToken(
  state: SecurityState,
  token: string,
  now = new Date().toISOString(),
): Promise<SecurityActionRecord | null> {
  const tokenHash = await sha256Base64Url(token);
  for (const action of Object.values(state.actions)) {
    if (action.tokenHash !== tokenHash) continue;
    if (action.usedAt) return null;
    if (Date.parse(action.expiresAt) <= Date.parse(now)) return null;
    return action;
  }
  return null;
}

export function markSecurityActionUsed(
  state: SecurityState,
  actionId: string,
  now = new Date().toISOString(),
): SecurityState {
  const next = normalizeSecurityState(state);
  const action = next.actions[actionId];
  if (action) {
    next.actions[actionId] = { ...action, usedAt: now };
  }
  return next;
}

export function appendSecurityEvent(state: SecurityState, event: SecurityEventRecord): SecurityState {
  state.events = [event, ...(state.events ?? [])].slice(0, MAX_SECURITY_EVENTS);
  return state;
}

export function createShareSecurityEvent(input: {
  kind: Extract<SecurityEventKind, "shared_invite_accepted" | "shared_participant_left" | "shared_participant_removed">;
  shareId: string;
  sessionId: string;
  actor: { userId: string; displayName: string; email?: string };
  target?: { userId: string; displayName: string; email?: string };
  now?: string;
}): SecurityEventRecord {
  const now = input.now ?? new Date().toISOString();
  const actorName = sanitizeText(input.actor.displayName, 80) || input.actor.userId;
  const targetName = input.target ? sanitizeText(input.target.displayName, 80) || input.target.userId : undefined;
  const session = sanitizeText(input.sessionId, 160) || "shared chat";
  const titles: Record<typeof input.kind, string> = {
    shared_invite_accepted: "Shared chat invite accepted",
    shared_participant_left: "Shared chat participant left",
    shared_participant_removed: "Shared chat access removed",
  };
  const bodies: Record<typeof input.kind, string> = {
    shared_invite_accepted: `${actorName} joined ${session}.`,
    shared_participant_left: `${actorName} left ${session}.`,
    shared_participant_removed: targetName
      ? `${targetName} was removed from ${session} by ${actorName}.`
      : `${actorName} removed a participant from ${session}.`,
  };
  return {
    id: randomBase64Url(16),
    kind: input.kind,
    shareId: sanitizeText(input.shareId, 160),
    sessionId: session,
    actorUserId: sanitizeText(input.actor.userId, 160),
    actorName,
    actorEmail: sanitizeText(input.actor.email, 160),
    targetUserId: sanitizeText(input.target?.userId, 160),
    targetName,
    targetEmail: sanitizeText(input.target?.email, 160),
    title: titles[input.kind],
    body: bodies[input.kind],
    createdAt: now,
  };
}

export function activateSecurityLockdown(
  state: SecurityState,
  reason: string,
  now = new Date().toISOString(),
): SecurityState {
  const next = normalizeSecurityState(state);
  next.lockdown = { active: true, startedAt: now, reason };
  next.revokedBefore = now;
  appendSecurityEvent(next, {
    id: randomBase64Url(16),
    kind: "emergency_lockdown",
    title: "Remote access disabled",
    body: reason,
    createdAt: now,
  });
  return next;
}

export function deactivateSecurityLockdown(
  state: SecurityState,
  reason: string,
  now = new Date().toISOString(),
): SecurityState {
  const next = normalizeSecurityState(state);
  next.lockdown = next.lockdown ? { ...next.lockdown, active: false } : undefined;
  appendSecurityEvent(next, {
    id: randomBase64Url(16),
    kind: "security_unlocked",
    title: "Remote access unlocked",
    body: reason,
    createdAt: now,
  });
  return next;
}

function buildSecurityEvent(
  kind: "client_connected" | "new_client_detected" | "shared_client_connected",
  device: SecurityDeviceRecord,
  context: SecurityConnectionContext,
  now: string,
): SecurityEventRecord {
  const name = device.name || device.platform || device.kind;
  const location = context.country ? ` from ${context.country}` : "";
  if (context.shared) {
    const actorName = sanitizeText(context.shared.actorName, 80) || context.shared.actorUserId;
    const session = sanitizeText(context.shared.sessionId, 160) || "shared chat";
    return {
      id: randomBase64Url(16),
      kind,
      deviceId: device.id,
      shareId: sanitizeText(context.shared.shareId, 160),
      sessionId: session,
      actorUserId: sanitizeText(context.shared.actorUserId, 160),
      actorName,
      actorEmail: sanitizeText(context.shared.actorEmail, 160),
      title: kind === "shared_client_connected" ? "Shared chat participant connected" : "Remote client connected",
      body: `${actorName} connected to ${session}${location}.`,
      createdAt: now,
      country: context.country,
      userAgent: context.userAgent,
    };
  }
  if (kind === "new_client_detected") {
    const approvalCode = securityDeviceApprovalCode(device);
    return {
      id: randomBase64Url(16),
      kind,
      deviceId: device.id,
      title: "Remote approval needed",
      body: `${name}${location} is waiting for approval. Code ${approvalCode}.`,
      createdAt: now,
      approvalCode,
      country: context.country,
      userAgent: context.userAgent,
    };
  }
  return {
    id: randomBase64Url(16),
    kind,
    deviceId: device.id,
    title: "Remote client connected",
    body: `${name}${location}`,
    createdAt: now,
    country: context.country,
    userAgent: context.userAgent,
  };
}

function buildDeviceActionEvent(
  kind: "device_approved" | "device_blocked",
  device: SecurityDeviceRecord,
  now: string,
): SecurityEventRecord {
  const name = device.name || device.platform || device.kind;
  const verb = kind === "device_approved" ? "approved" : "blocked";
  return {
    id: randomBase64Url(16),
    kind,
    deviceId: device.id,
    title: kind === "device_approved" ? "Remote device approved" : "Remote device blocked",
    body: `${name} was ${verb}.`,
    createdAt: now,
    country: device.lastCountry,
    userAgent: device.lastUserAgent,
  };
}

function sanitizeId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 120) || undefined;
}

function sanitizeApprovalCode(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim().toUpperCase();
  if (!trimmed) return undefined;
  const compact = trimmed.replace(/[^2-9A-HJ-NP-Z]/g, "");
  if (compact.length !== 6) return undefined;
  return `${compact.slice(0, 3)}-${compact.slice(3)}`;
}

function sharedDeviceId(shared: NonNullable<SecurityConnectionContext["shared"]>, deviceId: string): string {
  const shareId = sanitizeId(shared.shareId) ?? "share";
  const actorUserId = sanitizeId(shared.actorUserId) ?? "user";
  const rawDeviceId = sanitizeId(deviceId) ?? "device";
  return `shared:${shareId}:${actorUserId}:${rawDeviceId}`.slice(0, 120);
}

function sanitizeText(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function sanitizeDevicePublicKey(value: unknown): JsonWebKey | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = value as JsonWebKey;
  if (key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string") return null;
  return {
    kty: "EC",
    crv: "P-256",
    x: key.x,
    y: key.y,
    ext: true,
    key_ops: ["verify"],
  };
}

function isValidProofText(value: string | null | undefined, maxLength: number): value is string {
  return Boolean(value && value.length <= maxLength && !/[\r\n]/.test(value));
}

function sameDevicePublicKey(a: JsonWebKey, b: JsonWebKey): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deviceProofNonceKey(deviceId: string, nonce: string): string {
  return `${deviceId}:${nonce}`.slice(0, 320);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
