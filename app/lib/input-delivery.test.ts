import { describe, expect, it } from "vitest";

import {
  formatLivePaneInputDeliveryNotice,
  formatLivePaneInputResponseRefusal,
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
});
