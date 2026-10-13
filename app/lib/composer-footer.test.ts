import { describe, expect, it } from "vitest";

import {
  COMPOSER_SEND_AWAITING_ECHO_NOTICE,
  composerFooterState,
  heldDeliveryClearDelayMs,
} from "@/lib/composer-footer";

/** Terminal mode: the one that mounts no transcript pane. */
const QUIET = {
  error: null,
  sending: false,
  heldNotice: null,
  awaitingEcho: false,
  mode: "terminal" as const,
  rawOutputAllowed: true,
  width: 1400,
  activityLabel: null,
  activityLabelShimmer: false,
};

describe("what the composer footer says", () => {
  it("says nothing when there is nothing to say", () => {
    expect(composerFooterState(QUIET)).toEqual({ kind: "empty" });
  });

  // The bug: terminal mode does not mount the transcript pane, so the one
  // thing that confirmed a send -- the message appearing in it -- was not on
  // screen, and a send that worked looked like one that did nothing.
  it("confirms the send where there is no transcript to show it in", () => {
    expect(composerFooterState({ ...QUIET, awaitingEcho: true })).toEqual({
      kind: "awaiting-echo",
      text: COMPOSER_SEND_AWAITING_ECHO_NOTICE,
    });
  });

  it("stays quiet where the transcript already shows it", () => {
    expect(composerFooterState({ ...QUIET, awaitingEcho: true, mode: "chat" as const })).toEqual({
      kind: "empty",
    });
  });

  describe("precedence, decided once", () => {
    // This order used to live in two places twenty lines apart, and they
    // disagreed about where a held send ranked.
    it("puts an error above everything", () => {
      expect(
        composerFooterState({
          ...QUIET,
          error: "nope",
          heldNotice: "held",
          sending: true,
          awaitingEcho: true,
          activityLabel: "thinking",
        }),
      ).toEqual({ kind: "error", text: "nope" });
    });

    it("puts a held send above the in-flight state", () => {
      expect(composerFooterState({ ...QUIET, heldNotice: "held", sending: true })).toEqual({
        kind: "held",
        text: "held",
      });
    });

    it("shows a held send even where the transcript is on screen", () => {
      expect(composerFooterState({ ...QUIET, heldNotice: "held", mode: "chat" as const })).toEqual({
        kind: "held",
        text: "held",
      });
    });

    it("puts the in-flight state above the awaiting notice", () => {
      expect(composerFooterState({ ...QUIET, sending: true, awaitingEcho: true })).toEqual({
        kind: "sending",
      });
    });

    it("falls back to the activity label last", () => {
      expect(
        composerFooterState({ ...QUIET, activityLabel: "thinking", activityLabelShimmer: true }),
      ).toEqual({ kind: "activity", label: "thinking", shimmer: true });
      // And the awaiting notice beats it, because it is about what the user
      // just did rather than what the agent is doing.
      expect(
        composerFooterState({ ...QUIET, awaitingEcho: true, activityLabel: "thinking" }).kind,
      ).toBe("awaiting-echo");
    });
  });
});

describe("when a held send's notice retires", () => {
  // Keyed on the service's own deadline, not on counting user messages. The
  // count was wrong in exactly the case the notice exists for: the service
  // holds BECAUSE the agent terminal has unsubmitted text, so the user
  // submitting that text moved the count and cleared the notice while our
  // input was still queued.
  it("waits the remaining time until the deadline", () => {
    expect(heldDeliveryClearDelayMs({ maxDeliverAtMs: 5_000, nowMs: 2_000 })).toBe(3_000);
  });

  it("clears immediately once the deadline has passed", () => {
    expect(heldDeliveryClearDelayMs({ maxDeliverAtMs: 5_000, nowMs: 5_000 })).toBe(0);
    // Never negative: a clock that moved, or a deadline already behind us,
    // must not become a timer that waits forever.
    expect(heldDeliveryClearDelayMs({ maxDeliverAtMs: 5_000, nowMs: 9_000 })).toBe(0);
  });

  // A service that did not say when it would deliver has given nothing to
  // count down, so the notice stays until the next send replaces it.
  it("has nothing to wait for when no deadline was given", () => {
    expect(heldDeliveryClearDelayMs({ maxDeliverAtMs: null, nowMs: 5_000 })).toBeNull();
  });
});
