import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
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
  getRandomBytesAsync: vi.fn(async (byteLength: number) => {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return bytes;
  }),
}));

import { deviceProofMessage, getClientDeviceProof } from "@/lib/client-device-proof";

describe("client device proof", () => {
  beforeEach(() => {
    storageMock.values.clear();
    storageMock.getItem.mockImplementation(
      async (key: string) => storageMock.values.get(key) ?? null,
    );
    storageMock.setItem.mockImplementation(async (key: string, value: string) => {
      storageMock.values.set(key, value);
    });
  });

  it("does not mint a new proof key when storage read fails", async () => {
    storageMock.getItem.mockRejectedValueOnce(new Error("keychain denied"));
    const device = {
      deviceId: "client_1",
      kind: "web" as const,
      name: "Web browser",
      platform: "web",
    };

    await expect(getClientDeviceProof(device)).rejects.toThrow(
      /Client device storage read failed for proof key: keychain denied/,
    );
    expect(storageMock.setItem).not.toHaveBeenCalledWith(
      "aimux.clientDeviceProofKey.v1",
      expect.any(String),
    );
  });

  it("creates a stored P-256 proof that verifies with the exported public key", async () => {
    const device = {
      deviceId: "client_1",
      kind: "web" as const,
      name: "Web browser",
      platform: "web",
    };

    const proof = await getClientDeviceProof(device);

    const publicKey = publicKeyBytesFromJwk(proof.publicKeyJwk);
    const digest = sha256(
      new TextEncoder().encode(deviceProofMessage(device.deviceId, proof.timestamp, proof.nonce)),
    );
    expect(
      p256.verify(base64UrlDecode(proof.signature), digest, publicKey, { prehash: false }),
    ).toBe(true);
    expect(storageMock.values.size).toBe(1);
  });
});

function publicKeyBytesFromJwk(jwk: JsonWebKey): Uint8Array {
  const x = base64UrlDecode(String(jwk.x));
  const y = base64UrlDecode(String(jwk.y));
  const bytes = new Uint8Array(65);
  bytes[0] = 4;
  bytes.set(x, 1);
  bytes.set(y, 33);
  return bytes;
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
