import AsyncStorage from "@react-native-async-storage/async-storage";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { ClientDeviceInfo } from "@/lib/client-device";

const DEVICE_KEY_STORE_KEY = "aimux.clientDeviceProofKey.v1";

interface StoredDeviceProofKey {
  version: 1;
  privateKey: string;
  publicKeyJwk: JsonWebKey;
}

export interface ClientDeviceProof {
  alg: "ES256";
  publicKeyJwk: JsonWebKey;
  timestamp: string;
  nonce: string;
  signature: string;
}

let cachedKey: StoredDeviceProofKey | null = null;
let keyPromise: Promise<StoredDeviceProofKey> | null = null;

export async function getClientDeviceProof(device: ClientDeviceInfo): Promise<ClientDeviceProof> {
  const key = await getOrCreateDeviceProofKey();
  const timestamp = new Date().toISOString();
  const nonce = base64UrlEncode(await randomBytes(16));
  const message = deviceProofMessage(device.deviceId, timestamp, nonce);
  const digest = sha256(new TextEncoder().encode(message));
  const signature = p256
    .sign(digest, base64UrlDecode(key.privateKey), { prehash: false })
    .toCompactRawBytes();
  return {
    alg: "ES256",
    publicKeyJwk: key.publicKeyJwk,
    timestamp,
    nonce,
    signature: base64UrlEncode(signature),
  };
}

export function encodeDevicePublicKey(publicKeyJwk: JsonWebKey): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(publicKeyJwk)));
}

export function deviceProofMessage(deviceId: string, timestamp: string, nonce: string): string {
  return `aimux-device-proof-v1\n${deviceId}\n${timestamp}\n${nonce}`;
}

async function getOrCreateDeviceProofKey(): Promise<StoredDeviceProofKey> {
  if (cachedKey) return cachedKey;
  if (!keyPromise) {
    keyPromise = (async () => {
      const existing = await readStoredKey();
      if (existing) {
        cachedKey = existing;
        return existing;
      }
      const created = await createStoredKey();
      await writeStoredKey(created);
      cachedKey = created;
      return created;
    })().finally(() => {
      keyPromise = null;
    });
  }
  return keyPromise;
}

async function readStoredKey(): Promise<StoredDeviceProofKey | null> {
  try {
    const raw =
      Platform.OS === "web"
        ? await AsyncStorage.getItem(DEVICE_KEY_STORE_KEY)
        : await SecureStore.getItemAsync(DEVICE_KEY_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDeviceProofKey>;
    if (
      parsed.version !== 1 ||
      typeof parsed.privateKey !== "string" ||
      !isValidPublicJwk(parsed.publicKeyJwk)
    ) {
      return null;
    }
    const privateKey = base64UrlDecode(parsed.privateKey);
    if (!p256.utils.isValidSecretKey(privateKey)) return null;
    return { version: 1, privateKey: parsed.privateKey, publicKeyJwk: parsed.publicKeyJwk };
  } catch {
    return null;
  }
}

async function writeStoredKey(key: StoredDeviceProofKey): Promise<void> {
  const raw = JSON.stringify(key);
  if (Platform.OS === "web") {
    await AsyncStorage.setItem(DEVICE_KEY_STORE_KEY, raw);
    return;
  }
  await SecureStore.setItemAsync(DEVICE_KEY_STORE_KEY, raw);
}

async function createStoredKey(): Promise<StoredDeviceProofKey> {
  let privateKey = await randomBytes(32);
  for (let attempt = 0; attempt < 10 && !p256.utils.isValidSecretKey(privateKey); attempt += 1) {
    privateKey = await randomBytes(32);
  }
  if (!p256.utils.isValidSecretKey(privateKey)) {
    throw new Error("Failed to generate device proof key");
  }
  const publicKey = p256.getPublicKey(privateKey, false);
  return {
    version: 1,
    privateKey: base64UrlEncode(privateKey),
    publicKeyJwk: {
      kty: "EC",
      crv: "P-256",
      x: base64UrlEncode(publicKey.slice(1, 33)),
      y: base64UrlEncode(publicKey.slice(33, 65)),
      ext: true,
      key_ops: ["verify"],
    },
  };
}

async function randomBytes(byteLength: number): Promise<Uint8Array> {
  return Crypto.getRandomBytesAsync(byteLength);
}

function isValidPublicJwk(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as JsonWebKey;
  return (
    key.kty === "EC" &&
    key.crv === "P-256" &&
    typeof key.x === "string" &&
    typeof key.y === "string"
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
