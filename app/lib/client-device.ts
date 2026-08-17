import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const DEVICE_ID_KEY = "aimux.clientDeviceId.v1";
const APPROVAL_CODE_KEY = "aimux.clientApprovalCode.v1";
const APPROVAL_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type ClientDeviceKind = "web" | "ios" | "android" | "unknown";

export interface ClientDeviceInfo {
  deviceId: string;
  kind: ClientDeviceKind;
  name: string;
  platform: string;
  appVersion?: string;
  approvalCode?: string;
}

let cachedDeviceId: string | null = null;
let deviceIdPromise: Promise<string> | null = null;
let cachedApprovalCode: string | null = null;
let approvalCodePromise: Promise<string> | null = null;

export async function getClientDeviceInfo(): Promise<ClientDeviceInfo> {
  const deviceId = await getOrCreateDeviceId();
  const approvalCode = await getOrCreateApprovalCode();
  const kind = platformKind();
  return {
    deviceId,
    kind,
    name: defaultDeviceName(kind),
    platform: Platform.OS,
    appVersion: Constants.expoConfig?.version,
    approvalCode,
  };
}

async function getOrCreateDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      const existing = await readDeviceId();
      if (existing) {
        cachedDeviceId = existing;
        return existing;
      }
      const next = `client_${randomId()}`;
      await writeDeviceId(next);
      cachedDeviceId = next;
      return next;
    })().finally(() => {
      deviceIdPromise = null;
    });
  }
  return deviceIdPromise;
}

async function readDeviceId(): Promise<string | null> {
  try {
    if (Platform.OS === "web") return AsyncStorage.getItem(DEVICE_ID_KEY);
    return SecureStore.getItemAsync(DEVICE_ID_KEY);
  } catch {
    return null;
  }
}

async function writeDeviceId(value: string): Promise<void> {
  try {
    if (Platform.OS === "web") {
      await AsyncStorage.setItem(DEVICE_ID_KEY, value);
      return;
    }
    await SecureStore.setItemAsync(DEVICE_ID_KEY, value);
  } catch {
    // If persistence is unavailable, the generated id still works for this
    // process. The next launch will be treated as a new device.
  }
}

async function getOrCreateApprovalCode(): Promise<string> {
  if (cachedApprovalCode) return cachedApprovalCode;
  if (!approvalCodePromise) {
    approvalCodePromise = (async () => {
      const existing = await readStoredValue(APPROVAL_CODE_KEY);
      if (existing) {
        cachedApprovalCode = existing;
        return existing;
      }
      const next = await randomApprovalCode();
      await writeStoredValue(APPROVAL_CODE_KEY, next);
      cachedApprovalCode = next;
      return next;
    })().finally(() => {
      approvalCodePromise = null;
    });
  }
  return approvalCodePromise;
}

function platformKind(): ClientDeviceKind {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  if (Platform.OS === "web") return "web";
  return "unknown";
}

function defaultDeviceName(kind: ClientDeviceKind): string {
  if (kind === "ios") return "iOS app";
  if (kind === "android") return "Android app";
  if (kind === "web") return "Web browser";
  return "aimux client";
}

async function readStoredValue(key: string): Promise<string | null> {
  try {
    if (Platform.OS === "web") return AsyncStorage.getItem(key);
    return SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function writeStoredValue(key: string, value: string): Promise<void> {
  try {
    if (Platform.OS === "web") {
      await AsyncStorage.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  } catch {
    // Best effort. If persistence is unavailable, this process still has a
    // stable cached code and the next launch will get a new pairing code.
  }
}

async function randomApprovalCode(): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await Crypto.getRandomBytesAsync(6);
  } catch {
    bytes = new Uint8Array(6);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const compact = Array.from(
    bytes,
    (byte) => APPROVAL_CODE_ALPHABET[byte % APPROVAL_CODE_ALPHABET.length],
  ).join("");
  return `${compact.slice(0, 3)}-${compact.slice(3)}`;
}

function randomId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
