import { COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS } from "@/lib/composer-echo";

export interface SendTimeoutContext {
  sessionId: string | undefined;
  /** Whether this client talks to the daemon through the relay. */
  relayConfigured: boolean;
  /** The relay's state at the moment the send went unconfirmed. */
  relayStatus: string;
  /** How many queued echoes expired in this sweep. */
  droppedExpiredCount: number;
  /** Messages the transcript held when the echo was given up on. */
  parsedMessageCount: number;
  /** True for a shared chat, where the route goes through someone else's host. */
  shared: boolean;
}

export interface SendTimeoutReport {
  event: "composer.send.unconfirmed";
  sessionId: string;
  relayConfigured: boolean;
  relayStatus: string;
  droppedExpiredCount: number;
  parsedMessageCount: number;
  shared: boolean;
  timeoutMs: number;
}

/**
 * What to record when a send is never confirmed.
 *
 * A send is confirmed by the message appearing in the PARSED transcript, so
 * this fires whenever that transcript is late or incomplete -- not only when
 * the send itself failed. That is why it read as constant while the relay was
 * evicting sam-mini's socket every two seconds: the transcript kept being
 * reset, the echo never landed inside the window, and the composer blamed the
 * connection with nothing to point at.
 *
 * So the relay state is in the record. Without it every instance looks the
 * same and there is no way to tell a dropped transcript from a send that
 * genuinely did not arrive, which is the distinction worth having.
 *
 * No message text, no attachment names: this is a diagnostic about delivery,
 * and the content is the user's.
 */
export function buildSendTimeoutReport(context: SendTimeoutContext): SendTimeoutReport {
  return {
    event: "composer.send.unconfirmed",
    sessionId: context.sessionId ?? "unknown",
    relayConfigured: context.relayConfigured,
    relayStatus: context.relayStatus,
    droppedExpiredCount: context.droppedExpiredCount,
    parsedMessageCount: context.parsedMessageCount,
    shared: context.shared,
    timeoutMs: COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS,
  };
}

/**
 * Emit the record.
 *
 * One `console.warn` with a structured payload, because aimux has no error
 * reporter: there is no Sentry dependency anywhere in this repo, and wiring
 * one needs a DSN. When that exists this is the single call site to change --
 * the record is already the shape an event wants.
 */
export function reportSendTimeout(context: SendTimeoutContext): void {
  const report = buildSendTimeoutReport(context);
  console.warn("[aimux] send not confirmed", report);
}
