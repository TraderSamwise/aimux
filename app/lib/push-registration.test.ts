import { describe, expect, it } from "vitest";
import { buildSecurityPushRegistrationUrl } from "./push-registration-url";

describe("push registration", () => {
  it("routes normal security push registration to the authenticated user's relay", () => {
    expect(buildSecurityPushRegistrationUrl("wss://relay.aimux.app/").toString()).toBe(
      "https://relay.aimux.app/security/push-token",
    );
  });

  it("routes shared push registration through the owner relay context", () => {
    expect(
      buildSecurityPushRegistrationUrl("wss://relay.aimux.app", {
        ownerUserId: " user_owner ",
        shareId: " share_123 ",
      }).toString(),
    ).toBe("https://relay.aimux.app/security/push-token?ownerUserId=user_owner&shareId=share_123");
  });

  it("rejects partial shared push registration context", () => {
    expect(() =>
      buildSecurityPushRegistrationUrl("wss://relay.aimux.app", { ownerUserId: "user_owner" }),
    ).toThrow("ownerUserId and shareId must be provided together");
    expect(() =>
      buildSecurityPushRegistrationUrl("wss://relay.aimux.app", { shareId: "share_123" }),
    ).toThrow("ownerUserId and shareId must be provided together");
  });
});
