import { beforeEach, describe, expect, it, vi } from "vitest";

const storageMock = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "test" } } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: storageMock.getItem,
    setItem: storageMock.setItem,
  },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => storageMock.values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    storageMock.values.set(key, value);
  }),
}));
vi.mock("expo-crypto", () => ({
  getRandomBytesAsync: vi.fn(async (byteLength: number) => new Uint8Array(byteLength)),
}));

import { getClientDeviceInfo } from "@/lib/client-device";

describe("client device identity", () => {
  beforeEach(() => {
    storageMock.values.clear();
    storageMock.getItem.mockImplementation(
      async (key: string) => storageMock.values.get(key) ?? null,
    );
    storageMock.setItem.mockImplementation(async (key: string, value: string) => {
      storageMock.values.set(key, value);
    });
  });

  it("does not mint a new device id when storage read fails", async () => {
    storageMock.getItem.mockRejectedValueOnce(new Error("keychain denied"));

    await expect(getClientDeviceInfo()).rejects.toThrow(
      /Client device storage read failed for device id: keychain denied/,
    );
    expect(storageMock.setItem).not.toHaveBeenCalledWith(
      "aimux.clientDeviceId.v1",
      expect.stringMatching(/^client_/),
    );
  });

  it("mints and stores a device id when storage read succeeds with no existing value", async () => {
    const device = await getClientDeviceInfo();

    expect(device.deviceId).toMatch(/^client_/);
    expect(storageMock.setItem).toHaveBeenCalledWith(
      "aimux.clientDeviceId.v1",
      expect.stringMatching(/^client_/),
    );
    expect(storageMock.setItem).toHaveBeenCalledWith(
      "aimux.clientApprovalCode.v1",
      expect.stringMatching(/^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/),
    );
  });
});
