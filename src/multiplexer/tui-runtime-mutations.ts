import { debug } from "../debug.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import { mutateDashboardApi } from "./dashboard-api-client.js";

type TuiRuntimeMutationHost = any;

type NotificationContextPatch = {
  screen?: string;
  sessionId?: string;
  panelOpen?: boolean;
};

type MutationQueue = {
  context?: NotificationContextPatch;
  seen: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  attempt: number;
  disposed: boolean;
};

const RETRY_DELAYS_MS = [250, 1_000, 3_000, 10_000];

function getQueue(host: TuiRuntimeMutationHost): MutationQueue {
  if (!host.tuiRuntimeMutationQueue) {
    host.tuiRuntimeMutationQueue = {
      seen: new Set<string>(),
      timer: null,
      inFlight: false,
      attempt: 0,
      disposed: false,
    } satisfies MutationQueue;
  }
  return host.tuiRuntimeMutationQueue;
}

function scheduleFlush(host: TuiRuntimeMutationHost, delayMs = 0, opts: { preempt?: boolean } = {}): void {
  const queue = getQueue(host);
  if (queue.disposed) return;
  if (queue.timer && opts.preempt === true && !queue.inFlight) {
    clearTimeout(queue.timer);
    queue.timer = null;
  }
  if (queue.inFlight || queue.timer) return;
  queue.timer = setTimeout(() => {
    queue.timer = null;
    if (host.tuiRuntimeMutationQueue !== queue || queue.disposed) return;
    void flushQueue(host).catch(() => undefined);
  }, delayMs);
  queue.timer.unref?.();
}

function retryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

function requeueContext(host: TuiRuntimeMutationHost, context: NotificationContextPatch): void {
  const queue = getQueue(host);
  if (queue.disposed) return;
  queue.context ??= context;
}

async function flushQueue(host: TuiRuntimeMutationHost): Promise<void> {
  const queue = getQueue(host);
  if (queue.inFlight) return;
  if (!queue.context && queue.seen.size === 0) return;
  queue.inFlight = true;
  const context = queue.context;
  const seen = [...queue.seen];
  queue.context = undefined;
  queue.seen.clear();
  const failedSeen: string[] = [];
  let failed = false;
  try {
    if (context) {
      try {
        await mutateDashboardApi(host, PROJECT_API_ROUTES.runtime.notificationContext, {
          source: "tui",
          focused: true,
          ...context,
        });
      } catch {
        requeueContext(host, context);
        failed = true;
      }
    }
    for (const session of seen) {
      try {
        await mutateDashboardApi(host, PROJECT_API_ROUTES.runtime.markSeen, { session });
      } catch {
        failedSeen.push(session);
        failed = true;
      }
    }
  } finally {
    queue.inFlight = false;
  }
  if (queue.disposed || host.tuiRuntimeMutationQueue !== queue) return;
  if (!failed) {
    queue.attempt = 0;
    if (queue.context || queue.seen.size > 0) scheduleFlush(host);
    return;
  }
  for (const session of failedSeen) queue.seen.add(session);
  queue.attempt += 1;
  debug(`TUI runtime mutation retry scheduled after failed attempt ${queue.attempt}`, "dashboard");
  scheduleFlush(host, queue.context ? 0 : retryDelay(queue.attempt - 1));
}

export function queueTuiNotificationContext(
  host: TuiRuntimeMutationHost,
  patch: NotificationContextPatch,
): void {
  const queue = getQueue(host);
  queue.context = patch;
  scheduleFlush(host, 0, { preempt: true });
}

export function queueTuiSessionSeen(host: TuiRuntimeMutationHost, sessionId: string): void {
  getQueue(host).seen.add(sessionId);
  scheduleFlush(host);
}

export function clearTuiRuntimeMutationQueue(host: TuiRuntimeMutationHost): void {
  const queue = host.tuiRuntimeMutationQueue as MutationQueue | undefined;
  if (!queue) return;
  queue.disposed = true;
  if (queue.timer) clearTimeout(queue.timer);
  queue.context = undefined;
  queue.seen.clear();
  host.tuiRuntimeMutationQueue = undefined;
}
