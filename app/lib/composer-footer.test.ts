import { describe, expect, it } from "vitest";

import {
  COMPOSER_SEND_AWAITING_ECHO_NOTICE,
  composerFooterState,
  heldNoticeDurationMs,
  MAX_HELD_NOTICE_MS,
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

  it("keeps an accepted warning distinct from a hold or failure in every output mode", () => {
    for (const mode of ["chat", "terminal", "split"] as const) {
      expect(
        composerFooterState({
          ...QUIET,
          mode,
          warningNotice: "server notice",
          awaitingEcho: true,
          activityLabel: "Ready",
        }),
      ).toEqual({ kind: "warning", text: "server notice" });
    }
    expect(composerFooterState({ ...QUIET, warningNotice: "warning", error: "failed" })).toEqual({
      kind: "error",
      text: "failed",
    });
    expect(composerFooterState({ ...QUIET, warningNotice: "warning", heldNotice: "held" })).toEqual(
      { kind: "held", text: "held" },
    );
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

describe("how long a held send's notice stays up", () => {
  // The duration the service published, not a deadline compared against the
  // client's clock: `maxDeliverAtMs` is the SERVICE's epoch-ms, so any skew
  // distorted the countdown, and a device far enough behind produced a delay
  // `setTimeout` clamps -- firing immediately for what should be a long hold.
  it("uses the duration the service gave", () => {
    expect(heldNoticeDurationMs({ holdMs: 3_000 })).toBe(3_000);
  });

  it("never waits a negative amount", () => {
    expect(heldNoticeDurationMs({ holdMs: -5 })).toBe(0);
  });

  // Above `setTimeout`'s 32-bit delay the timer fires after 1ms, which is the
  // opposite of what a long hold should do, so it is clamped.
  it("clamps a duration long enough to overflow the timer", () => {
    expect(heldNoticeDurationMs({ holdMs: 2_147_483_648 })).toBe(MAX_HELD_NOTICE_MS);
    expect(MAX_HELD_NOTICE_MS).toBeLessThan(2_147_483_647);
  });

  // A service that did not say has given nothing to count down, so the notice
  // stays until the next send replaces it.
  it("has nothing to wait for when no duration was given", () => {
    expect(heldNoticeDurationMs({ holdMs: null })).toBeNull();
  });
});
