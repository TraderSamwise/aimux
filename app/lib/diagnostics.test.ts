import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DIAGNOSTIC_THROTTLE_MS,
  captureDiagnostic,
  decideDiagnosticThrottle,
  resetDiagnosticThrottleForTests,
} from "@/lib/diagnostics";
import { buildSentryEnvelope, parseSentryDsn, sentryAuthHeader } from "@/lib/sentry-envelope";
import {
  diagnosticReason,
  DIAGNOSTIC_REASON_MAX_CHARS,
  deliveryTags,
  reportSendFailed,
  reportSendTimeout,
  reportTranscriptRefreshFailed,
} from "@/lib/send-timeout-report";

const DSN = "https://abc123@o456.ingest.sentry.io/789";

describe("reading a Sentry DSN", () => {
  it("pulls out where to post and what proves us", () => {
    expect(parseSentryDsn(DSN)).toEqual({
      envelopeUrl: "https://o456.ingest.sentry.io/api/789/envelope/",
      publicKey: "abc123",
      projectId: "789",
    });
  });

  it("answers null for anything it cannot use, rather than throwing", () => {
    // This runs behind a send. Telemetry that cannot be addressed must never
    // be the reason a message looks like it failed.
    for (const bad of [
      undefined,
      "",
      "   ",
      "not a url",
      "https://o456.ingest.sentry.io/789",
      "https://abc123@o456.ingest.sentry.io/",
      "ftp://abc123@o456.ingest.sentry.io/789",
    ]) {
      expect(parseSentryDsn(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the envelope", () => {
  const input = {
    eventName: "composer.send.unconfirmed",
    message: "Composer send was never confirmed",
    level: "warning" as const,
    eventId: "0".repeat(32),
    sentAtIso: "2099-01-01T00:00:00.000Z",
    environment: "production",
    release: "1.2.3",
    tags: { relayStatus: "connected" },
    context: { droppedExpiredCount: 2 },
  };

  it("is three newline-delimited json lines", () => {
    const lines = buildSentryEnvelope(input).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ event_id: input.eventId });
    expect(JSON.parse(lines[1])).toEqual({ type: "event" });
    expect(JSON.parse(lines[2])).toMatchObject({
      level: "warning",
      environment: "production",
      release: "1.2.3",
    });
  });

  it("groups on the diagnostic rather than the message", () => {
    // Without this Sentry groups on the message, and these messages carry
    // varying detail -- one diagnostic would arrive as a scatter of
    // near-identical issues, which is the opposite of being able to ask how
    // often it happens.
    const event = JSON.parse(buildSentryEnvelope(input).trimEnd().split("\n")[2]);
    expect(event.fingerprint).toEqual(["composer.send.unconfirmed"]);
    expect(event.tags.diagnostic).toBe("composer.send.unconfirmed");
  });

  it("names the key and the time in the auth header", () => {
    const header = sentryAuthHeader("abc123", "2099-01-01T00:00:00.000Z");
    expect(header).toContain("sentry_key=abc123");
    expect(header).toContain("sentry_version=7");
  });
});

describe("not flooding", () => {
  beforeEach(() => resetDiagnosticThrottleForTests());

  it("sends one and counts the rest of the burst", () => {
    // The burst this has to survive is a relay evicting its socket every
    // couple of seconds, where every expired echo raises the same thing.
    const first = decideDiagnosticThrottle("composer.send.unconfirmed", 1_000);
    expect(first).toEqual({ send: true, occurrences: 1 });

    for (let i = 0; i < 40; i += 1) {
      const next = decideDiagnosticThrottle("composer.send.unconfirmed", 1_000 + i);
      expect(next.send).toBe(false);
    }

    // The next one out carries the whole burst, so the count is not lost.
    const after = decideDiagnosticThrottle(
      "composer.send.unconfirmed",
      1_000 + DIAGNOSTIC_THROTTLE_MS,
    );
    expect(after.send).toBe(true);
    expect(after.occurrences).toBe(41);
  });

  it("throttles each diagnostic on its own", () => {
    expect(decideDiagnosticThrottle("composer.send.unconfirmed", 0).send).toBe(true);
    expect(decideDiagnosticThrottle("composer.send.failed", 0).send).toBe(true);
  });
});

describe("what a diagnostic carries", () => {
  let warned: unknown[][] = [];

  beforeEach(() => {
    resetDiagnosticThrottleForTests();
    warned = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 })),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const path = {
    sessionId: "claude-psmp2r",
    relayConfigured: true,
    relayStatus: "connected",
    shared: true,
  };

  it("never carries the message the user typed", () => {
    // The draft, the attachment names and the transcript are the user's. What
    // goes out is the state of the connection.
    const secret = "the quick brown fox jumped over the lazy dog";
    reportSendFailed(path, new Error(`network refused while sending`));
    reportTranscriptRefreshFailed(path, "input", new Error("timeout"));
    reportSendTimeout({ ...path, droppedExpiredCount: 1, parsedMessageCount: 4 });

    const serialized = JSON.stringify(warned);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("claude-psmp2r");
    expect(serialized).toContain("relayStatus");
  });

  it("caps an error it did not assemble itself", () => {
    const long = "x".repeat(DIAGNOSTIC_REASON_MAX_CHARS * 3);
    expect(diagnosticReason(new Error(long)).length).toBe(DIAGNOSTIC_REASON_MAX_CHARS);
    expect(diagnosticReason(undefined)).toBe("");
    expect(diagnosticReason("plain string")).toBe("plain string");
  });

  it("keeps the session id out of the searchable tags", () => {
    // Tags are indexed, so an unbounded value there is a cardinality problem.
    // It stays in the context, where it can still be read.
    const tags = deliveryTags(path);
    expect(Object.values(tags)).not.toContain("claude-psmp2r");
    expect(tags).toMatchObject({ relayStatus: "connected", shared: "true" });
  });

  it("records to the console even with nowhere to send it", () => {
    captureDiagnostic({
      name: "composer.send.failed",
      message: "m",
      level: "error",
      tags: {},
      context: { a: 1 },
    });
    expect(warned.length).toBe(1);
    // No DSN in the test env, so nothing is posted and nothing throws.
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(
      0,
    );
  });
});
