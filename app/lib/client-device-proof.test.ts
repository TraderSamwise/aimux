import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
  },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => storage.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    storage.set(key, value);
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
    storage.clear();
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
    expect(storage.size).toBe(1);
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
