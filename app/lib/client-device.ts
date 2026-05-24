import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

const DEVICE_ID_KEY = "aimux.clientDeviceId.v1";

export type ClientDeviceKind = "web" | "ios" | "android" | "unknown";

export interface ClientDeviceInfo {
  deviceId: string;
  kind: ClientDeviceKind;
  name: string;
  platform: string;
  appVersion?: string;
}

export async function getClientDeviceInfo(): Promise<ClientDeviceInfo> {
  const deviceId = await getOrCreateDeviceId();
  const kind = platformKind();
  return {
    deviceId,
    kind,
    name: defaultDeviceName(kind),
    platform: Platform.OS,
    appVersion: Constants.expoConfig?.version,
  };
}

async function getOrCreateDeviceId(): Promise<string> {
  const existing = await readDeviceId();
  if (existing) return existing;
  const next = `client_${randomId()}`;
  await writeDeviceId(next);
  return next;
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

function randomId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
