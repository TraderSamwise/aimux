import { describe, expect, it } from "vitest";

import { pairingPromptDeviceKey, shouldOpenPairingPrompt } from "./pairing-prompt";

describe("the approval prompt opens itself while a device is waiting", () => {
  it("opens when a device starts waiting", () => {
    expect(
      shouldOpenPairingPrompt({
        pending: true,
        deviceId: "client_abc",
        lastPromptedDeviceId: null,
      }),
    ).toBe(true);
  });

  it("opens without a device id, since the user is still blocked", () => {
    expect(shouldOpenPairingPrompt({ pending: true, lastPromptedDeviceId: null })).toBe(true);
  });

  it("stays shut once it has opened for that device", () => {
    expect(
      shouldOpenPairingPrompt({
        pending: true,
        deviceId: "client_abc",
        lastPromptedDeviceId: "client_abc",
      }),
    ).toBe(false);
  });

  it("opens again for a different device", () => {
    expect(
      shouldOpenPairingPrompt({
        pending: true,
        deviceId: "client_xyz",
        lastPromptedDeviceId: "client_abc",
      }),
    ).toBe(true);
  });

  it("stays shut when nothing is waiting", () => {
    expect(
      shouldOpenPairingPrompt({
        pending: false,
        deviceId: "client_abc",
        lastPromptedDeviceId: null,
      }),
    ).toBe(false);
  });
});

describe("the device key", () => {
  it("falls back to a stable key so a blank id does not reprompt forever", () => {
    expect(pairingPromptDeviceKey(undefined)).toBe(pairingPromptDeviceKey("   "));
    expect(
      shouldOpenPairingPrompt({
        pending: true,
        deviceId: "   ",
        lastPromptedDeviceId: pairingPromptDeviceKey(undefined),
      }),
    ).toBe(false);
  });
});
