import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS } from "./composer-echo";
import { buildSendTimeoutReport } from "./send-timeout-report";

const SCREEN = readFileSync(
  join(__dirname, "..", "components", "screens", "AgentChatScreen.tsx"),
  "utf8",
);

const CONTEXT = {
  sessionId: "claude-psmp2r",
  relayConfigured: true,
  relayStatus: "connected",
  droppedExpiredCount: 1,
  parsedMessageCount: 42,
  shared: false,
};

describe("the send-timeout record", () => {
  it("carries the relay state, which is what tells the two causes apart", () => {
    // A send is confirmed by the message reaching the PARSED transcript, so a
    // transcript that is late or was reset raises this just as a failed send
    // does. Without the relay state every instance looks identical -- which
    // is exactly why "all the time" was unattributable while the relay was
    // evicting the daemon socket every two seconds.
    const report = buildSendTimeoutReport({ ...CONTEXT, relayStatus: "reconnecting" });
    expect(report.relayStatus).toBe("reconnecting");
    expect(report.relayConfigured).toBe(true);
  });

  it("says which session and how far the transcript had got", () => {
    const report = buildSendTimeoutReport(CONTEXT);
    expect(report.sessionId).toBe("claude-psmp2r");
    expect(report.parsedMessageCount).toBe(42);
    expect(report.droppedExpiredCount).toBe(1);
    expect(report.timeoutMs).toBe(COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS);
  });

  it("names an unknown session rather than dropping the field", () => {
    // An absent id is a fact about the instance. Omitting the key would make
    // those reports silently unlike the others.
    expect(buildSendTimeoutReport({ ...CONTEXT, sessionId: undefined }).sessionId).toBe("unknown");
  });

  it("carries no message text or attachment names", () => {
    const report = buildSendTimeoutReport(CONTEXT);
    // A delivery diagnostic; the content is the user's.
    expect(Object.keys(report).sort()).toEqual([
      "droppedExpiredCount",
      "event",
      "parsedMessageCount",
      "relayConfigured",
      "relayStatus",
      "sessionId",
      "shared",
      "timeoutMs",
    ]);
  });
});

describe("the screen actually reports it", () => {
  it("records every unconfirmed send, not just shows the message", () => {
    // The builder is pure, so it passes while nothing calls it. This is the
    // whole point of the item: every instance should leave a trace.
    expect(SCREEN).toMatch(/reportSendTimeout\(\{/);
    const sets = SCREEN.match(/setSendError\(COMPOSER_SEND_TIMEOUT_MESSAGE\)/g) ?? [];
    expect(sets.length).toBe(1);
  });

  it("reports from the one place both drop sites go through", () => {
    // The timer is not the only thing that can drop an expired echo -- a
    // transcript update settles them too, and when IT dropped one nothing was
    // reported and nothing was shown. That is the late-transcript case the
    // record exists to measure, so it cannot be the silent one.
    const settleCalls = SCREEN.match(/settleComposerEchoes\(acceptedComposerMessages/g) ?? [];
    expect(settleCalls.length).toBe(2);
    // And exactly one definition of it, or the two sites can drift apart.
    expect((SCREEN.match(/function settleComposerEchoes\(/g) ?? []).length).toBe(1);
  });

  it("merges outside the state updater, so one timeout is one record", () => {
    // React may invoke a queued updater more than once. Reporting from inside
    // `setAcceptedComposerMessages((current) => ...)` emitted two records for
    // one timeout and double-counted the thing being counted.
    //
    // The reporting merge takes its array as an ARGUMENT, so it runs once per
    // call rather than once per updater invocation. (A second merge exists
    // for rendering with `timeoutMs: Number.POSITIVE_INFINITY`; it expires
    // nothing and reports nothing, so it is not this.)
    const settle = SCREEN.slice(SCREEN.indexOf("function settleComposerEchoes("));
    expect(settle).toMatch(/mergeAcceptedComposerEchoes\(parsedMessages, accepted,/);
    // And the single report lives in that function, not in an updater.
    expect((SCREEN.match(/reportSendTimeout\(\{/g) ?? []).length).toBe(1);
    expect(settle).toMatch(/reportSendTimeout\(\{/);
  });

  it("reports the relay state rather than hardcoding one", () => {
    expect(SCREEN).toMatch(/relayStatus,/);
    expect(SCREEN).toMatch(/relayConfigured,/);
  });
});
