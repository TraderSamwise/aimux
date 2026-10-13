import { describe, expect, it } from "vitest";

import {
  formatLivePaneInputDeliveryNotice,
  formatLivePaneInputResponseRefusal,
  formatPostActionTranscriptRefreshResult,
  livePaneInputDeliveryOutcome,
  sendDeliveryStateAfterResponse,
} from "./input-delivery";

describe("formatLivePaneInputDeliveryNotice", () => {
  it("keeps immediate delivery quiet", () => {
    expect(formatLivePaneInputDeliveryNotice(undefined)).toBeNull();
    expect(formatLivePaneInputDeliveryNotice({ state: "delivered" })).toBeNull();
  });

  it("reports held input as not delivered yet", () => {
    expect(
      formatLivePaneInputDeliveryNotice({
        state: "held",
        reason: "active client is still attached",
      }),
    ).toBe("Input held, not delivered yet: active client is still attached");
  });

  it("explains each held-input reason in user-facing language", () => {
    expect(
      formatLivePaneInputDeliveryNotice({
        state: "held",
        // The reason the service actually emits for typed-ahead text. It was
        // `visible-unsubmitted-input` here, which nothing emits.
        reason: "visible-unsubmitted-input-recent-user-input",
      }),
    ).toBe(
      "Input held, not delivered yet: the agent terminal already has typed text. Clear or send that terminal draft, or Aimux will send this after the 15s safety hold.",
    );
    expect(
      formatLivePaneInputDeliveryNotice({
        state: "held",
        reason: "active-client-recent-input",
      }),
    ).toBe(
      "Input held, not delivered yet: a tmux client typed in the agent terminal recently. Aimux will retry after the terminal is quiet for a moment.",
    );
    // `max-hold-elapsed` used to be asserted here and the service never emits
    // it; this is the hold reason it does emit for typed-ahead text, which
    // was rendering as a raw slug because the formatter keyed on a string
    // that does not exist.
    expect(
      formatLivePaneInputDeliveryNotice({
        state: "held",
        reason: "visible-unsubmitted-input-recent-user-input",
      }),
    ).toBe(
      "Input held, not delivered yet: the agent terminal already has typed text. Clear or send that terminal draft, or Aimux will send this after the 15s safety hold.",
    );
    // A bare slug the formatter does not know is not shown to the user.
    expect(formatLivePaneInputDeliveryNotice({ state: "held", reason: "some-future-reason" })).toBe(
      "Input held, not delivered yet: Aimux will retry shortly; the agent terminal was busy.",
    );
  });

  it("reports accepted-false input responses as refusal", () => {
    expect(
      formatLivePaneInputResponseRefusal({
        ok: true,
        sessionId: "codex-one",
        accepted: false,
        error: "input delivery queue unavailable",
      }),
    ).toBe("Input not accepted: input delivery queue unavailable");
    expect(
      formatLivePaneInputResponseRefusal({
        ok: true,
        sessionId: "codex-one",
        accepted: true,
      }),
    ).toBeNull();
  });

  it("reports post-action transcript refresh failures without rewriting the action result", () => {
    expect(
      formatPostActionTranscriptRefreshResult(
        "Input sent",
        new Error("live-pane output request timed out"),
      ),
    ).toBe("Input sent, but transcript refresh failed: live-pane output request timed out");
  });

  it("keeps successful post-action transcript refreshes quiet", () => {
    expect(formatPostActionTranscriptRefreshResult("Input sent", null)).toBeNull();
  });
});

describe("whether a delivery notice is a failure or a wait", () => {
  // `held` comes back with `accepted: true` -- the input is queued and the
  // service delivers it within the 15s safety hold. It went to the same red
  // error line as a genuine failure, so an accepted send read as a failed one.
  it("calls a held send pending, not failed", () => {
    expect(
      livePaneInputDeliveryOutcome({
        state: "held",
        reason: "visible-unsubmitted-input-recent-user-input",
      }),
    ).toBe("pending");
  });

  it("still calls a real failure failed", () => {
    expect(livePaneInputDeliveryOutcome({ state: "failed", error: "tmux is gone" })).toBe("failed");
    // Any future state that is neither delivered nor held is a failure until
    // something says otherwise, which is the safe direction for this one.
    expect(livePaneInputDeliveryOutcome({ state: "unknown-future" } as never)).toBe("failed");
  });

  it("treats a delivered send, and an absent delivery, as delivered", () => {
    expect(livePaneInputDeliveryOutcome({ state: "delivered" })).toBe("delivered");
    expect(livePaneInputDeliveryOutcome(undefined)).toBe("delivered");
  });
});

describe("what a send response means for the composer", () => {
  // The screen used to decide this inline with
  // `livePaneInputDeliveryOutcome(...) === "pending" ? setHeld : setError`,
  // and nothing could reach that expression -- flipping it to `=== "failed"`
  // put an accepted send back on the red error line with every test green.
  it("routes a held send to a wait, carrying the service's deadline", () => {
    expect(
      sendDeliveryStateAfterResponse({
        delivery: {
          state: "held",
          reason: "visible-unsubmitted-input-recent-user-input",
          retryAfterMs: 4_000,
        },
      }),
    ).toEqual({
      kind: "held",
      notice:
        "Input held, not delivered yet: the agent terminal already has typed text. Clear or send that terminal draft, or Aimux will send this after the 15s safety hold.",
      holdMs: 4_000,
    });
  });

  it("routes a real failure to the error line", () => {
    expect(
      sendDeliveryStateAfterResponse({ delivery: { state: "failed", error: "tmux is gone" } }),
    ).toEqual({ kind: "error", text: "Input not delivered: tmux is gone" });
  });

  it("says nothing for a delivered send, or one with no delivery block", () => {
    expect(sendDeliveryStateAfterResponse({ delivery: { state: "delivered" } })).toEqual({
      kind: "none",
    });
    expect(sendDeliveryStateAfterResponse({ delivery: undefined })).toEqual({ kind: "none" });
  });

  // No duration means nothing to count down, which `heldNoticeDurationMs`
  // treats as nothing to wait for rather than guessing.
  it("carries a null duration when the service sent none", () => {
    const state = sendDeliveryStateAfterResponse({
      delivery: { state: "held", reason: "active-client-recent-input" },
    });
    expect(state).toMatchObject({ kind: "held", holdMs: null });
  });
});
