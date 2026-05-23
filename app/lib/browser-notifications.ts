import { Platform } from "react-native";
import type { ClientNotificationEvent } from "@/lib/notification-policy";

export type BrowserNotificationPermission = "default" | "denied" | "granted" | "unsupported";

interface BrowserNotificationOptions {
  body?: string;
  tag?: string;
  renotify?: boolean;
}

type BrowserNotificationConstructor = {
  permission: Exclude<BrowserNotificationPermission, "unsupported">;
  requestPermission: () => Promise<Exclude<BrowserNotificationPermission, "unsupported">>;
  new (title: string, options?: BrowserNotificationOptions): unknown;
};

function browserNotificationApi(): BrowserNotificationConstructor | null {
  if (Platform.OS !== "web") return null;
  return (globalThis as { Notification?: BrowserNotificationConstructor }).Notification ?? null;
}

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  const api = browserNotificationApi();
  return api?.permission ?? "unsupported";
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  const api = browserNotificationApi();
  if (!api) return "unsupported";
  return api.requestPermission();
}

export function isBrowserDocumentVisible(): boolean {
  if (Platform.OS !== "web") return false;
  const documentLike = (globalThis as { document?: { visibilityState?: string } }).document;
  return documentLike?.visibilityState === "visible";
}

export function showBrowserNotification(event: ClientNotificationEvent): boolean {
  const api = browserNotificationApi();
  if (!api || api.permission !== "granted") return false;
  new api(event.title, {
    body: event.body,
    tag: event.dedupeKey,
    renotify: false,
  });
  return true;
}
