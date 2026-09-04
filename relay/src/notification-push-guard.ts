export interface NotificationPushGuardInput {
  userId: string;
  sessionId?: string;
  kind?: string;
  title?: string;
  body?: string;
  dedupeKey?: string;
}

export type NotificationPushGuardReason = "dedupe" | "session_rate_limited" | "global_rate_limited";

export type NotificationPushGuardResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: NotificationPushGuardReason;
      retryAfterMs: number;
    };

interface NotificationPushGuardState {
  version: 1;
  dedupe: Record<string, number>;
  globalHits: number[];
  sessionHits: Record<string, number[]>;
  updatedAt: string;
}

const STATE_KEY = "notification-push-guard:v1";
export const NOTIFICATION_PUSH_DEDUPE_TTL_MS = 60_000;
export const NOTIFICATION_PUSH_GLOBAL_WINDOW_MS = 60_000;
export const NOTIFICATION_PUSH_GLOBAL_LIMIT = 20;
export const NOTIFICATION_PUSH_SESSION_WINDOW_MS = 60_000;
export const NOTIFICATION_PUSH_SESSION_LIMIT = 5;

export async function checkNotificationPushGuard(
  storage: DurableObjectStorage,
  input: NotificationPushGuardInput,
  options: {
    now?: () => number;
    dedupeTtlMs?: number;
    globalLimit?: number;
    globalWindowMs?: number;
    sessionLimit?: number;
    sessionWindowMs?: number;
  } = {},
): Promise<NotificationPushGuardResult> {
  const now = options.now?.() ?? Date.now();
  const dedupeTtlMs = options.dedupeTtlMs ?? NOTIFICATION_PUSH_DEDUPE_TTL_MS;
  const globalLimit = options.globalLimit ?? NOTIFICATION_PUSH_GLOBAL_LIMIT;
  const globalWindowMs = options.globalWindowMs ?? NOTIFICATION_PUSH_GLOBAL_WINDOW_MS;
  const sessionLimit = options.sessionLimit ?? NOTIFICATION_PUSH_SESSION_LIMIT;
  const sessionWindowMs = options.sessionWindowMs ?? NOTIFICATION_PUSH_SESSION_WINDOW_MS;
  const state = pruneState((await storage.get<NotificationPushGuardState>(STATE_KEY)) ?? emptyState(now), now, {
    dedupeTtlMs,
    globalWindowMs,
    sessionWindowMs,
  });

  const dedupeKey = notificationDedupeKey(input);
  const lastSeenAt = state.dedupe[dedupeKey];
  if (lastSeenAt !== undefined && now - lastSeenAt < dedupeTtlMs) {
    await saveState(storage, state, now);
    return {
      allowed: false,
      reason: "dedupe",
      retryAfterMs: dedupeTtlMs - (now - lastSeenAt),
    };
  }

  if (state.globalHits.length >= globalLimit) {
    await saveState(storage, state, now);
    return {
      allowed: false,
      reason: "global_rate_limited",
      retryAfterMs: retryAfterMs(state.globalHits, now, globalWindowMs),
    };
  }

  const sessionKey = input.sessionId?.trim() || "_global";
  const sessionHits = state.sessionHits[sessionKey] ?? [];
  if (sessionHits.length >= sessionLimit) {
    await saveState(storage, state, now);
    return {
      allowed: false,
      reason: "session_rate_limited",
      retryAfterMs: retryAfterMs(sessionHits, now, sessionWindowMs),
    };
  }

  state.dedupe[dedupeKey] = now;
  state.globalHits.push(now);
  state.sessionHits[sessionKey] = [...sessionHits, now];
  await saveState(storage, state, now);
  return { allowed: true };
}

export function notificationPushGuardMessage(result: Exclude<NotificationPushGuardResult, { allowed: true }>): string {
  if (result.reason === "dedupe") return "Duplicate push notification suppressed";
  if (result.reason === "session_rate_limited") return "Push notification session rate limit exceeded";
  return "Push notification global rate limit exceeded";
}

function emptyState(now: number): NotificationPushGuardState {
  return {
    version: 1,
    dedupe: {},
    globalHits: [],
    sessionHits: {},
    updatedAt: new Date(now).toISOString(),
  };
}

function pruneState(
  state: NotificationPushGuardState,
  now: number,
  windows: { dedupeTtlMs: number; globalWindowMs: number; sessionWindowMs: number },
): NotificationPushGuardState {
  const dedupe = Object.fromEntries(
    Object.entries(state.version === 1 ? state.dedupe ?? {} : {}).filter(
      ([, seenAt]) => now - seenAt < windows.dedupeTtlMs,
    ),
  );
  const globalHits = (state.version === 1 ? state.globalHits ?? [] : []).filter(
    (hit) => now - hit < windows.globalWindowMs,
  );
  const sessionHits = Object.fromEntries(
    Object.entries(state.version === 1 ? state.sessionHits ?? {} : {})
      .map(([sessionId, hits]) => [
        sessionId,
        hits.filter((hit) => now - hit < windows.sessionWindowMs),
      ])
      .filter(([, hits]) => hits.length > 0),
  );
  return {
    version: 1,
    dedupe,
    globalHits,
    sessionHits,
    updatedAt: new Date(now).toISOString(),
  };
}

async function saveState(
  storage: DurableObjectStorage,
  state: NotificationPushGuardState,
  now: number,
): Promise<void> {
  await storage.put(STATE_KEY, { ...state, updatedAt: new Date(now).toISOString() });
}

function retryAfterMs(hits: number[], now: number, windowMs: number): number {
  const oldest = Math.min(...hits);
  return Math.max(1, windowMs - (now - oldest));
}

function notificationDedupeKey(input: NotificationPushGuardInput): string {
  const raw =
    input.dedupeKey?.trim() ||
    [input.sessionId, input.kind, input.title, input.body].map((part) => part?.trim() ?? "").join("|");
  return hashString(`${input.userId.trim()}|${raw}`);
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
