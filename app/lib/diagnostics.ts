/**
 * Diagnostics for the delivery messages that are mostly false positives.
 *
 * "Send not confirmed yet" and its siblings fire whenever the PARSED transcript
 * is late, not only when a send failed -- so on a flapping relay they read as
 * constant while every message actually arrived. Nothing recorded them, so
 * there was no way to tell which instances were real.
 *
 * These events exist to answer that, which sets the rules below:
 *
 * - They never interfere. No await on a user path, no throw, ever.
 * - They never carry content. The draft, attachment names and transcript text
 *   are the user's; what goes out is the connection's state.
 * - They never flood. The known-bad case is a relay dropping its socket tens
 *   of times a day, which would be a burst per drop, so repeats inside a
 *   window are counted rather than sent.
 */

import { sentryDsn, sentryEnvironment, sentryRelease } from "@/lib/sentry-config";
import { buildSentryEnvelope, parseSentryDsn, sentryAuthHeader } from "@/lib/sentry-envelope";

/** Every diagnostic this app sends. One Sentry issue each. */
export type DiagnosticName =
  | "composer.send.unconfirmed"
  | "composer.send.failed"
  | "composer.transcript_refresh.failed"
  | "composer.send.not_accepted";

export interface DiagnosticEvent {
  name: DiagnosticName;
  message: string;
  level: "info" | "warning" | "error";
  /** Low-cardinality, searchable. */
  tags: Record<string, string>;
  /** The detail, and never the user's content. */
  context: Record<string, unknown>;
}

/**
 * How long one diagnostic stays quiet after it fires.
 *
 * A minute. The burst this has to survive is a relay evicting its socket every
 * couple of seconds, where every expired echo raises the same diagnostic; one
 * event a minute carrying the count says the same thing about frequency
 * without the flood, and the count is the part that proves it was a burst.
 */
export const DIAGNOSTIC_THROTTLE_MS = 60_000;

interface ThrottleEntry {
  lastSentAtMs: number;
  /** Raised since the last one went out, this one included. */
  suppressed: number;
}

const throttle = new Map<DiagnosticName, ThrottleEntry>();

export interface ThrottleDecision {
  send: boolean;
  /** How many of this diagnostic the event speaks for, including itself. */
  occurrences: number;
}

/**
 * Whether this one goes out, and how many it stands for.
 *
 * Exported for the tests, and reset by them: the state is per app session on
 * purpose, because the question being answered -- is this user's connection
 * producing these constantly -- is a question about a session.
 */
export function decideDiagnosticThrottle(name: DiagnosticName, nowMs: number): ThrottleDecision {
  const entry = throttle.get(name);
  if (!entry || nowMs - entry.lastSentAtMs >= DIAGNOSTIC_THROTTLE_MS) {
    const occurrences = (entry?.suppressed ?? 0) + 1;
    throttle.set(name, { lastSentAtMs: nowMs, suppressed: 0 });
    return { send: true, occurrences };
  }
  entry.suppressed += 1;
  return { send: false, occurrences: entry.suppressed + 1 };
}

export function resetDiagnosticThrottleForTests(): void {
  throttle.clear();
}

function randomEventId(): string {
  // 32 hex characters, which is what Sentry wants for an event id.
  let id = "";
  for (let index = 0; index < 32; index += 1) {
    id += Math.floor(Math.random() * 16).toString(16);
  }
  return id;
}

/**
 * Record a diagnostic: to Sentry when a DSN is configured, to the console
 * either way.
 *
 * The console line stays even with Sentry on. It is what someone reads when
 * they are sitting in front of the machine that is misbehaving, and it costs
 * nothing.
 */
export function captureDiagnostic(event: DiagnosticEvent): void {
  const decision = decideDiagnosticThrottle(event.name, Date.now());
  const payload = { ...event.context, occurrences: decision.occurrences };
  console.warn(`[aimux] ${event.name}`, payload);
  if (!decision.send) return;
  void postToSentry(event, payload);
}

async function postToSentry(
  event: DiagnosticEvent,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    const dsn = parseSentryDsn(sentryDsn());
    if (!dsn) return;
    const sentAtIso = new Date().toISOString();
    const body = buildSentryEnvelope({
      eventName: event.name,
      message: event.message,
      level: event.level,
      eventId: randomEventId(),
      sentAtIso,
      environment: sentryEnvironment(),
      release: sentryRelease(),
      tags: event.tags,
      context,
    });
    await fetch(dsn.envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": sentryAuthHeader(dsn.publicKey, sentAtIso),
      },
      body,
    });
  } catch {
    // Swallowed deliberately, and the only place in this repo where that is
    // the right answer: this runs behind a send, and a diagnostic that cannot
    // be delivered must not become an error the user sees. The console line
    // above has already recorded it.
  }
}
