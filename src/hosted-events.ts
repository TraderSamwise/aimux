import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { atomicWrite, quarantineCorruptFile } from "./atomic-write.js";
import { log } from "./debug.js";
import type { HostedConfig } from "./hosted-config.js";
import { withHostedLock } from "./hosted-lock.js";
import { getHostedDevicesPath, getHostedDir } from "./paths.js";

/**
 * Connection events for hosted mode.
 *
 * Aimux reports; it does not decide what a human sees. Events are signed and
 * posted to whatever the deployer configured, so notification policy — push,
 * email, nothing — belongs to the system receiving them.
 */

export type HostedEventKind =
  | "hosted_token_first_use"
  | "hosted_new_device"
  | "hosted_auth_failed"
  | "hosted_token_revoked"
  | "hosted_grant_changed"
  | "hosted_lockdown";

export interface HostedEvent {
  id: string;
  kind: HostedEventKind;
  ts: string;
  principalId: string | null;
  label: string | null;
  sessionId?: string | null;
  fingerprint: string | null;
  /** False when no client address could be established — see clientAddress. */
  addressKnown: boolean;
  userAgent: string | null;
  detail?: string;
}

interface DeviceRecord {
  principalId: string;
  fingerprint: string;
  firstSeen: string;
  lastSeen: string;
  userAgent: string | null;
}

interface DevicesState {
  version: 1;
  /** Generated once; never leaves this file. Lets events correlate without storing addresses. */
  salt: string;
  devices: DeviceRecord[];
}

function emptyDevices(): DevicesState {
  return { version: 1, salt: randomBytes(32).toString("hex"), devices: [] };
}

function loadDevices(): DevicesState {
  const path = getHostedDevicesPath();
  if (!existsSync(path)) return emptyDevices();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<DevicesState>;
    if (typeof parsed?.salt !== "string" || !parsed.salt) return emptyDevices();
    return {
      version: 1,
      salt: parsed.salt,
      devices: Array.isArray(parsed.devices) ? (parsed.devices as DeviceRecord[]) : [],
    };
  } catch {
    quarantineCorruptFile(path);
    return emptyDevices();
  }
}

function saveDevices(state: DevicesState): void {
  mkdirSync(getHostedDir(), { recursive: true, mode: 0o700 });
  atomicWrite(getHostedDevicesPath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The client address, or null when it genuinely cannot be known.
 *
 * Behind a tunnel every request arrives from loopback, so the socket address
 * alone is useless — a "new device" alert that fires on every browser update
 * and misses every real one is worse than none. A forwarded header fixes that,
 * but only a deployer can say which header is trustworthy, and it is honoured
 * only when the immediate peer is loopback: a header from a routable peer is
 * just an attacker-supplied string.
 */
export function clientAddress(
  peerAddress: string | undefined,
  headers: Record<string, string>,
  config: HostedConfig,
): string | null {
  const peer = peerAddress?.trim() || null;
  if (!config.trustedForwardedHeader) return peer;

  const peerIsLoopback = Boolean(peer && /^(::1|::ffff:127\.|127\.)/.test(peer));
  if (!peerIsLoopback) return peer;

  // RIGHTMOST, not leftmost. Proxies append, so the last entry is the address
  // our own trusted hop observed; the leftmost is whatever the client typed
  // into the header, which would let anyone forge a new device — or rotate the
  // value to defeat the auth-failure throttle and flood the webhook.
  const entries = headers[config.trustedForwardedHeader]
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries?.at(-1) || peer;
}

export function deviceFingerprint(salt: string, address: string | null, userAgent: string | null): string {
  return createHash("sha256")
    .update(`${salt}:${address ?? "unknown"}:${userAgent ?? "unknown"}`)
    .digest("hex")
    .slice(0, 32);
}

export interface SeenDeviceInput {
  principalId: string;
  label: string;
  address: string | null;
  userAgent: string | null;
}

/**
 * Record a sighting and report what was new about it.
 *
 * First sight of a principal is `hosted_token_first_use`; a fingerprint never
 * seen for an already-known principal is `hosted_new_device`. Anything else is
 * routine and produces nothing.
 */
const LAST_SEEN_THROTTLE_MS = 60_000;

export function recordDeviceSighting(input: SeenDeviceInput): HostedEvent | null {
  // Under the lock throughout: without it two concurrent requests both see no
  // record, both emit "first use", and one device row is lost — which later
  // surfaces as a spurious "new device". Both are user-visible alerts.
  return (
    withHostedLock(
      getHostedDevicesPath(),
      () => {
        const state = loadDevices();
        const fingerprint = deviceFingerprint(state.salt, input.address, input.userAgent);
        const now = new Date().toISOString();

        const known = state.devices.find(
          (device) => device.principalId === input.principalId && device.fingerprint === fingerprint,
        );
        if (known) {
          // Rewriting the file on every request is the cost this avoids; a
          // last-seen stamp does not need per-request precision.
          if (Date.now() - Date.parse(known.lastSeen) >= LAST_SEEN_THROTTLE_MS) {
            known.lastSeen = now;
            known.userAgent = input.userAgent;
            saveDevices(state);
          }
          return null;
        }

        const principalSeenBefore = state.devices.some((device) => device.principalId === input.principalId);
        state.devices.push({
          principalId: input.principalId,
          fingerprint,
          firstSeen: now,
          lastSeen: now,
          userAgent: input.userAgent,
        });
        saveDevices(state);

        return {
          id: randomUUID(),
          kind: principalSeenBefore ? "hosted_new_device" : "hosted_token_first_use",
          ts: now,
          principalId: input.principalId,
          label: input.label,
          fingerprint,
          addressKnown: input.address !== null,
          userAgent: input.userAgent,
        } satisfies HostedEvent;
      },
      // Reached from a request. A contended sighting is worth giving up on;
      // holding the event loop for the default five seconds is not.
      { timeoutMs: 200 },
    ) ?? null
  );
}

export function pruneHostedDevices(retentionDays: number, now = Date.now()): void {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  // Under the lock like every other read-modify-write here: pruning unlocked
  // could clobber a device added concurrently, and the next request from it
  // would alert as new.
  withHostedLock(
    getHostedDevicesPath(),
    () => {
      const state = loadDevices();
      const kept = state.devices.filter((device) => Date.parse(device.lastSeen) >= cutoff);
      if (kept.length === state.devices.length) return;
      state.devices = kept;
      saveDevices(state);
    },
    { timeoutMs: 200 },
  );
}

const MAX_QUEUE = 100;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000];

export function signHostedEvent(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * Bounded, retrying webhook delivery.
 *
 * A webhook outage must never block, slow, or fail the request that produced
 * the event, so the queue is fire-and-forget with a hard ceiling: past it,
 * events are dropped with a log line rather than growing without limit. The
 * audit log keeps the record either way, so an outage costs timeliness, not
 * history.
 */
export class HostedEventDelivery {
  private queue: HostedEvent[] = [];
  private sending = false;
  private timer: NodeJS.Timeout | null = null;
  private resolveSleep: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly config: HostedConfig) {}

  /** Absent secret means events are recorded but never sent — never unsigned. */
  private secret(): string | null {
    return process.env[this.config.webhookSecretEnv]?.trim() || null;
  }

  enqueue(event: HostedEvent): void {
    if (this.stopped || !this.config.webhookUrl || !this.secret()) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      log.warn("hosted event queue full, dropping oldest", "hosted", { kind: event.kind });
    }
    this.queue.push(event);
    void this.drain().catch(() => {
      // drain never throws; this satisfies the no-floating-rejection rule.
    });
  }

  private async drain(): Promise<void> {
    if (this.sending || this.stopped) return;
    this.sending = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const event = this.queue[0]!;
        const delivered = await this.attempt(event);
        this.queue.shift();
        if (!delivered) {
          log.warn("hosted event delivery gave up", "hosted", { kind: event.kind, id: event.id });
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private async attempt(event: HostedEvent): Promise<boolean> {
    for (let index = 0; index <= RETRY_DELAYS_MS.length; index += 1) {
      if (this.stopped) return false;
      try {
        await this.post(event);
        return true;
      } catch {
        const delay = RETRY_DELAYS_MS[index];
        if (delay === undefined) return false;
        await this.sleep(delay);
      }
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.resolveSleep = resolve;
      this.timer = setTimeout(resolve, ms);
      this.timer.unref?.();
    });
  }

  /**
   * Posted directly rather than through the shared http client, which logs the
   * request's origin and path — and the webhook URL is itself a credential for
   * most receivers.
   */
  private post(event: HostedEvent): Promise<void> {
    const secret = this.secret();
    const url = this.config.webhookUrl;
    if (!secret || !url) return Promise.resolve();

    const body = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<void>((resolve, reject) => {
      const req = send(
        target,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            // Timestamp is signed alongside the body so a captured delivery
            // cannot be replayed indefinitely.
            "x-aimux-timestamp": timestamp,
            "x-aimux-signature": signHostedEvent(secret, timestamp, body),
          },
          timeout: 10_000,
        },
        (res) => {
          res.resume();
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else reject(new Error(`webhook responded ${status}`));
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("webhook timeout")));
      req.end(body);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Resolve rather than abandon: clearing the timer alone would leave the
    // in-flight backoff awaiting a promise that can never settle.
    this.resolveSleep?.();
    this.resolveSleep = null;
    this.queue = [];
  }
}
