import { readFileSync } from "node:fs";
import { join } from "node:path";

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

  it("strips the path, query and credentials out of a URL an error quoted", () => {
    // The free-form half. A transport error quotes the request it failed on,
    // and an Aimux request URL carries the session id, the share id and a
    // token in its path and query -- so this is the one place the rest of the
    // module's care could be undone. The host is kept, because "relay or
    // loopback" is the question these events exist to answer.
    const url =
      "https://user:pa55word@relay.aimux.app:8443/shares/user_3E0h/Fozqw2SsTCciooYkzx-XYQ" +
      "/proxy/127.0.0.1/44659/agents/input?sessionId=claude-psmp2r&token=sk-live-abcdef#frag";
    reportSendFailed(path, new Error(`Failed to POST ${url}`));
    reportTranscriptRefreshFailed(path, "input", `GET ${url} timed out`);
    // The one with no free-form field at all, for the contrast.
    reportSendTimeout({ ...path, droppedExpiredCount: 1, parsedMessageCount: 4 });

    const serialized = JSON.stringify(warned);
    for (const leaked of [
      "pa55word",
      "sk-live-abcdef",
      "Fozqw2SsTCciooYkzx-XYQ",
      "user_3E0h",
      "/agents/input",
      "frag",
    ]) {
      expect(serialized, `${leaked} must not ride in on an error`).not.toContain(leaked);
    }
    // Still useful: which host failed, and the session, from the fields this
    // module assembles itself.
    expect(serialized).toContain("https://relay.aimux.app:8443");
    expect(serialized).toContain("claude-psmp2r");
    expect(serialized).toContain("relayStatus");
  });

  it("is never handed the draft in the first place", () => {
    // What makes "no message text" a fact rather than a hope: the screen's
    // reporter calls take the connection state and an error, and the draft is
    // in scope at every one of them. Asserting the payload alone passes while
    // nothing is passed in, which is how this started.
    const screen = readFileSync(
      join(__dirname, "..", "components", "screens", "AgentChatScreen.tsx"),
      "utf8",
    );
    const content = ["text", "draft", "acceptedMessage", "parsedMessages", "attachments"];
    const calls: string[] = [];
    for (const match of screen.matchAll(/\breport[A-Z][A-Za-z]*\(/g)) {
      let depth = 0;
      let index = match.index! + match[0].length - 1;
      for (; index < screen.length; index += 1) {
        if (screen[index] === "(") depth += 1;
        else if (screen[index] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      calls.push(screen.slice(match.index! + match[0].length, index));
    }
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const raw of calls) {
      // A COUNT of the user's content is not the content. `parsedMessages.length`
      // is how far the transcript had got, which is the whole point of the
      // record; `parsedMessages` itself would be the transcript.
      const args = raw.replace(/\b[A-Za-z]\w*\.(?:length|size)\b/g, "COUNT");
      for (const name of content) {
        expect(args, `a reporter is given ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
      }
    }
  });

  it("caps an error it did not assemble itself", () => {
    const long = "x".repeat(DIAGNOSTIC_REASON_MAX_CHARS * 3);
    expect(diagnosticReason(new Error(long)).length).toBe(DIAGNOSTIC_REASON_MAX_CHARS);
    expect(diagnosticReason(undefined)).toBe("");
    expect(diagnosticReason("plain string")).toBe("plain string");
    // Redacting before the cap spends the 300 characters on the message
    // instead of on a path about to be thrown away. Both orders redact, so
    // this is about what survives, not about what leaks.
    const buried = `${"y".repeat(DIAGNOSTIC_REASON_MAX_CHARS - 30)}https://h/a-very-long-path`;
    const reason = diagnosticReason(new Error(buried));
    expect(reason).not.toContain("a-very-long-path");
    expect(reason).toContain("https://h");
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
