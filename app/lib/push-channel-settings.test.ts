import { describe, expect, it, vi } from "vitest";

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

import { defaultNotificationSettings } from "./notification-settings";
import { resolvePushChannelDisable } from "./push-channel-settings";
import type { PushRegistrationResult } from "./push-registration";

function pushEnabledSettings() {
  return {
    ...defaultNotificationSettings,
    enabled: true,
    channels: {
      ...defaultNotificationSettings.channels,
      push: true,
    },
  };
}

describe("resolvePushChannelDisable", () => {
  it("turns push off after the relay confirms agent alerts are disabled", async () => {
    const calls: unknown[] = [];
    const result = await resolvePushChannelDisable({
      notificationSettings: pushEnabledSettings(),
      relayUrl: "wss://relay.aimux.app",
      getToken: async () => "token",
      ownerUserId: "owner_123",
      shareId: "share_123",
      registerPushToken: async (...args) => {
        calls.push(args);
        return { status: "registered", deviceId: "device", token: "expo" };
      },
    });

    expect(result.status).toBe("disabled");
    expect(result.notificationSettings?.channels.push).toBe(false);
    expect(result.message).toBe("Off");
    expect(calls).toEqual([
      [
        "wss://relay.aimux.app",
        expect.any(Function),
        {
          ownerUserId: "owner_123",
          shareId: "share_123",
          agentAlerts: false,
        },
      ],
    ]);
  });

  it("turns push off locally when no relay registration exists to update", async () => {
    const result = await resolvePushChannelDisable({
      notificationSettings: pushEnabledSettings(),
      getToken: async () => "token",
      registerPushToken: async () => {
        throw new Error("must not register without a relay");
      },
    });

    expect(result.status).toBe("disabled");
    expect(result.notificationSettings?.channels.push).toBe(false);
    expect(result.message).toBe("Off");
  });

  it("does not claim push is off when the relay update fails", async () => {
    const result = await resolvePushChannelDisable({
      notificationSettings: pushEnabledSettings(),
      relayUrl: "wss://relay.aimux.app",
      getToken: async () => "token",
      registerPushToken: async () => {
        throw new Error("relay unavailable");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.notificationSettings).toBeNull();
    expect(result.message).toBe("Could not turn push off: relay unavailable");
  });

  it("keeps push enabled when the relay cannot confirm the disable", async () => {
    const result = await resolvePushChannelDisable({
      notificationSettings: pushEnabledSettings(),
      relayUrl: "wss://relay.aimux.app",
      getToken: async () => "token",
      registerPushToken: async () => ({ status: "missing_auth" }) satisfies PushRegistrationResult,
    });

    expect(result.status).toBe("failed");
    expect(result.notificationSettings).toBeNull();
    expect(result.message).toBe("Sign in required to turn push off");
  });
});
