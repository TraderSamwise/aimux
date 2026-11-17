/**
 * Just enough of Sentry's ingest protocol to post a diagnostic event.
 *
 * No SDK on purpose. `@sentry/react-native` is a native dependency, so adding
 * it would turn every JS-only change in this app into a native build -- and
 * what these events need is a handful of fields we already assemble, not
 * breadcrumbs, stack traces or session tracking. The envelope endpoint takes a
 * plain POST, works the same on web and native, and ships over the air.
 *
 * If this ever needs real crash reporting, that is when the SDK earns its
 * place; the shape here is deliberately the shape the SDK sends.
 */

export interface SentryDsnParts {
  /** Where the envelope goes, fully formed. */
  envelopeUrl: string;
  /** The DSN's public key, which authenticates the post. */
  publicKey: string;
  projectId: string;
}

/**
 * Pull the pieces out of a DSN, or answer `null` for anything unusable.
 *
 * `null` rather than a throw: this runs behind a user action, and telemetry
 * that cannot be addressed must never be the reason a send appears to fail.
 * A misconfigured DSN therefore degrades to no reporting, which is exactly
 * what an absent DSN does.
 */
export function parseSentryDsn(dsn: string | undefined): SentryDsnParts | null {
  const trimmed = dsn?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const publicKey = url.username;
  // The path is `/<project id>`, and anything else is not a DSN.
  const projectId = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!publicKey || !projectId || projectId.includes("/")) return null;
  return {
    envelopeUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
    publicKey,
    projectId,
  };
}

/** The `X-Sentry-Auth` header value for a post. */
export function sentryAuthHeader(publicKey: string, sentAtIso: string): string {
  return [
    "Sentry sentry_version=7",
    "sentry_client=aimux-app/1",
    `sentry_key=${publicKey}`,
    `sentry_timestamp=${sentAtIso}`,
  ].join(", ");
}

export interface SentryEventInput {
  /** Groups the issue in Sentry; one per diagnostic, stable across sends. */
  eventName: string;
  message: string;
  level: "info" | "warning" | "error";
  eventId: string;
  sentAtIso: string;
  environment: string;
  release?: string;
  /** Searchable in Sentry, so only low-cardinality values belong here. */
  tags: Record<string, string>;
  /** The detail. Not indexed, and never the user's content. */
  context: Record<string, unknown>;
}

/**
 * Build the newline-delimited envelope: header, item header, item.
 *
 * `fingerprint` pins the grouping to the diagnostic's own name. Without it
 * Sentry groups on the message, and these messages carry varying detail, so
 * one diagnostic would arrive as a scatter of near-identical issues -- which
 * is the opposite of being able to ask how often it happens.
 */
export function buildSentryEnvelope(input: SentryEventInput): string {
  const event = {
    event_id: input.eventId,
    timestamp: input.sentAtIso,
    platform: "javascript",
    level: input.level,
    logger: "aimux.diagnostics",
    environment: input.environment,
    ...(input.release ? { release: input.release } : {}),
    message: { formatted: input.message },
    fingerprint: [input.eventName],
    tags: { ...input.tags, diagnostic: input.eventName },
    extra: input.context,
  };
  const envelopeHeader = { event_id: input.eventId, sent_at: input.sentAtIso };
  const itemHeader = { type: "event" };
  return `${JSON.stringify(envelopeHeader)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(event)}\n`;
}
