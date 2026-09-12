import { describe, expect, it } from "vitest";

import { formatLivePaneInputDeliveryNotice } from "./input-delivery";

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
});
