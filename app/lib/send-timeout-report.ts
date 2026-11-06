import { COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS } from "@/lib/composer-echo";
import { captureDiagnostic } from "@/lib/diagnostics";

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

export function reportSendTimeout(context: SendTimeoutContext): void {
  const report = buildSendTimeoutReport(context);
  captureDiagnostic({
    name: "composer.send.unconfirmed",
    message: "Composer send was never confirmed by the parsed transcript",
    level: "warning",
    tags: deliveryTags(context),
    context: { ...report },
  });
}

/** The state of the path a send took, shared by every diagnostic here. */
export interface DeliveryPathContext {
  sessionId: string | undefined;
  relayConfigured: boolean;
  relayStatus: string;
  shared: boolean;
}

/**
 * The searchable half of a delivery diagnostic.
 *
 * Tags are indexed, so only values with few possibilities belong here -- that
 * is what makes "how many of these happened while the relay was reconnecting"
 * a question Sentry can answer, which is the whole reason these events exist.
 * The session id is deliberately NOT a tag: it is unbounded, and it is in the
 * context where it can still be read.
 */
export function deliveryTags(context: DeliveryPathContext): Record<string, string> {
  return {
    relayConfigured: String(context.relayConfigured),
    relayStatus: context.relayStatus,
    shared: String(context.shared),
  };
}

/**
 * Keep an error short, and keep the user's content out of it.
 *
 * These strings come from a transport or an HTTP status, never from the draft
 * -- but they are the one field here built from something this module did not
 * assemble itself, so they are capped rather than trusted.
 */
export const DIAGNOSTIC_REASON_MAX_CHARS = 300;

export function diagnosticReason(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error == null
          ? ""
          : String(error);
  return raw.slice(0, DIAGNOSTIC_REASON_MAX_CHARS);
}

/** The send itself was refused: a real failure, and the useful contrast. */
export function reportSendFailed(context: DeliveryPathContext, error: unknown): void {
  captureDiagnostic({
    name: "composer.send.failed",
    message: "Composer send was refused",
    level: "error",
    tags: deliveryTags(context),
    context: {
      event: "composer.send.failed",
      sessionId: context.sessionId ?? "unknown",
      relayConfigured: context.relayConfigured,
      relayStatus: context.relayStatus,
      shared: context.shared,
      reason: diagnosticReason(error),
    },
  });
}

/**
 * The action went out and the transcript refresh after it did not.
 *
 * The most false-positive-shaped of the family: the user is told their input
 * was sent AND shown an error, because the only thing that failed was the
 * reread afterwards.
 */
export function reportTranscriptRefreshFailed(
  context: DeliveryPathContext,
  action: string,
  error: unknown,
): void {
  captureDiagnostic({
    name: "composer.transcript_refresh.failed",
    message: "Transcript refresh after a delivered action failed",
    level: "warning",
    tags: { ...deliveryTags(context), action },
    context: {
      event: "composer.transcript_refresh.failed",
      sessionId: context.sessionId ?? "unknown",
      relayConfigured: context.relayConfigured,
      relayStatus: context.relayStatus,
      shared: context.shared,
      action,
      reason: diagnosticReason(error),
    },
  });
}

/** The daemon answered, and the answer was not "accepted". */
export function reportSendNotAccepted(context: DeliveryPathContext, deliveryKind: string): void {
  captureDiagnostic({
    name: "composer.send.not_accepted",
    message: "Composer send was not accepted by the agent",
    level: "warning",
    tags: { ...deliveryTags(context), deliveryKind },
    context: {
      event: "composer.send.not_accepted",
      sessionId: context.sessionId ?? "unknown",
      relayConfigured: context.relayConfigured,
      relayStatus: context.relayStatus,
      shared: context.shared,
      deliveryKind,
    },
  });
}
