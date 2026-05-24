const SECURITY_STATE_KEY = "security-state:v1";
const SECURITY_ACTION_TOKEN_BYTES = 32;
export const SECURITY_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SECURITY_EVENTS = 100;

export type SecurityDeviceKind = "web" | "ios" | "android" | "daemon" | "unknown";

export interface SecurityDeviceInfo {
  deviceId: string;
  kind: SecurityDeviceKind;
  name?: string;
  platform?: string;
  appVersion?: string;
}

export interface SecurityConnectionContext {
  ipHash?: string;
  country?: string;
  userAgent?: string;
}

export interface SecurityDeviceRecord extends SecurityDeviceInfo {
  id: string;
  firstSeenAt: string;
  lastSeenAt: string;
  approvedAt?: string;
  blockedAt?: string;
  lastIpHash?: string;
  lastCountry?: string;
  lastUserAgent?: string;
}

export type SecurityEventKind =
  | "client_connected"
  | "new_client_detected"
  | "device_approved"
  | "device_blocked"
  | "emergency_lockdown"
  | "security_unlocked";

export interface SecurityEventRecord {
  id: string;
  kind: SecurityEventKind;
  deviceId?: string;
  title: string;
  body: string;
  createdAt: string;
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
  deviceId: string;
  token: string;
  platform: "ios" | "android" | "web" | "unknown";
  createdAt: string;
  updatedAt: string;
}

export interface SecurityState {
  version: 1;
  devices: Record<string, SecurityDeviceRecord>;
  pushTokens: Record<string, SecurityPushTokenRecord>;
  actions: Record<string, SecurityActionRecord>;
  events: SecurityEventRecord[];
  lockdown?: SecurityLockdownRecord;
  revokedBefore?: string;
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
    events: [],
  };
}

export async function loadSecurityState(storage: DurableObjectStorage): Promise<SecurityState> {
  const stored = await storage.get<SecurityState>(SECURITY_STATE_KEY);
  if (!stored || stored.version !== 1) return emptySecurityState();
  return normalizeSecurityState(stored);
}

export async function saveSecurityState(
  storage: DurableObjectStorage,
  state: SecurityState,
): Promise<void> {
  await storage.put(SECURITY_STATE_KEY, normalizeSecurityState(state));
}

export function normalizeSecurityState(state: SecurityState): SecurityState {
  return {
    version: 1,
    devices: state.devices ?? {},
    pushTokens: state.pushTokens ?? {},
    actions: state.actions ?? {},
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
      }
    | null
    | undefined,
): SecurityDeviceInfo {
  const rawKind = input?.kind;
  const kind: SecurityDeviceKind =
    rawKind === "web" || rawKind === "ios" || rawKind === "android" || rawKind === "daemon"
      ? rawKind
      : "unknown";
  return {
    deviceId: sanitizeId(input?.deviceId) || "unknown",
    kind,
    name: sanitizeText(input?.name, 80),
    platform: sanitizeText(input?.platform, 80),
    appVersion: sanitizeText(input?.appVersion, 40),
  };
}

export async function hashIpAddress(ip: string | null | undefined): Promise<string | undefined> {
  const normalized = ip?.trim();
  if (!normalized) return undefined;
  return sha256Base64Url(normalized);
}

export function recordClientConnection(
  state: SecurityState,
  deviceInfo: SecurityDeviceInfo,
  context: SecurityConnectionContext,
  now = new Date().toISOString(),
): { state: SecurityState; device: SecurityDeviceRecord; firstSeen: boolean; events: SecurityEventRecord[] } {
  const next = normalizeSecurityState(state);
  const previous = next.devices[deviceInfo.deviceId];
  const firstSeen = !previous;
  const device: SecurityDeviceRecord = {
    ...previous,
    ...deviceInfo,
    id: deviceInfo.deviceId,
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    approvedAt: previous?.approvedAt,
    blockedAt: previous?.blockedAt,
    lastIpHash: context.ipHash ?? previous?.lastIpHash,
    lastCountry: context.country ?? previous?.lastCountry,
    lastUserAgent: context.userAgent ?? previous?.lastUserAgent,
  };
  next.devices[device.id] = device;

  const events: SecurityEventRecord[] = [
    buildSecurityEvent("client_connected", device, context, now),
  ];
  if (firstSeen) {
    events.push(buildSecurityEvent("new_client_detected", device, context, now));
  }
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

function buildSecurityEvent(
  kind: "client_connected" | "new_client_detected",
  device: SecurityDeviceRecord,
  context: SecurityConnectionContext,
  now: string,
): SecurityEventRecord {
  const name = device.name || device.platform || device.kind;
  const title = kind === "new_client_detected" ? "New remote client detected" : "Remote client connected";
  const location = context.country ? ` from ${context.country}` : "";
  return {
    id: randomBase64Url(16),
    kind,
    deviceId: device.id,
    title,
    body: `${name}${location}`,
    createdAt: now,
    country: context.country,
    userAgent: context.userAgent,
  };
}

function sanitizeId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 120) || undefined;
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

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
