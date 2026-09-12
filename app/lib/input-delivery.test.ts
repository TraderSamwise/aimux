import { describe, expect, it } from "vitest";

import {
  formatLivePaneInputDeliveryNotice,
  formatLivePaneInputResponseRefusal,
  formatPostActionTranscriptRefreshResult,
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
