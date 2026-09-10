import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("expo-notifications", () => ({
  AndroidImportance: { DEFAULT: 3 },
  getPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
}));
vi.mock("@/lib/client-device", () => ({ getClientDeviceInfo: vi.fn() }));
vi.mock("@/lib/client-device-proof", () => ({ getClientDeviceProof: vi.fn() }));

import { ensureSecurityNotificationChannel, sendSecurityTestPush } from "./push-registration";
import {
  buildSecurityPushRegistrationUrl,
  buildSecurityPushTestUrl,
} from "./push-registration-url";

describe("push registration", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    Platform.OS = "ios";
  });

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

  it("routes test pushes through the same relay context", () => {
    expect(
      buildSecurityPushTestUrl("wss://relay.aimux.app", {
        ownerUserId: " user_owner ",
        shareId: " share_123 ",
      }).toString(),
    ).toBe("https://relay.aimux.app/security/test-push?ownerUserId=user_owner&shareId=share_123");
  });

  it("configures the Android security notification channel", async () => {
    Platform.OS = "android";

    await expect(ensureSecurityNotificationChannel()).resolves.toBeUndefined();

    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith("security", {
      name: "Security alerts",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  });

  it("reports the sent device count from readable test push responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ sent: 2 }),
      })),
    );

    await expect(
      sendSecurityTestPush("wss://relay.aimux.app", async () => "token"),
    ).resolves.toEqual({ sent: 2 });
  });

  it("rejects successful test push responses with unreadable JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new Error("invalid json");
        },
      })),
    );

    await expect(
      sendSecurityTestPush("wss://relay.aimux.app", async () => "token"),
    ).rejects.toThrow("Test push response was not valid JSON: invalid json");
  });
});
