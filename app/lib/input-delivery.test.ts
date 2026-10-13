import { describe, expect, it } from "vitest";

import {
  formatLivePaneInputDeliveryNotice,
  formatLivePaneInputResponseRefusal,
  formatPostActionTranscriptRefreshResult,
  livePaneInputDeliveryOutcome,
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
        reason: "visible-unsubmitted-input",
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
    expect(
      formatLivePaneInputDeliveryNotice({
        state: "held",
        reason: "max-hold-elapsed",
      }),
    ).toBe(
      "Input held, not delivered yet: the 15s safety hold elapsed, so Aimux is sending the queued input now.",
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
      livePaneInputDeliveryOutcome({ state: "held", reason: "visible-unsubmitted-input" }),
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
