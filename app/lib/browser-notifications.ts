import { Platform } from "react-native";
import type { ClientNotificationEvent } from "@/lib/notification-policy";

export type BrowserNotificationPermission = "default" | "denied" | "granted" | "unsupported";

interface BrowserNotificationOptions {
  body?: string;
}

type BrowserNotificationConstructor = {
  permission: Exclude<BrowserNotificationPermission, "unsupported">;
  requestPermission: () => Promise<Exclude<BrowserNotificationPermission, "unsupported">>;
  new (title: string, options?: BrowserNotificationOptions): unknown;
};

export type BrowserNotificationDeliveryResult =
  | { status: "delivered" }
  | { status: "unsupported" }
  | { status: "permission_denied"; permission: BrowserNotificationPermission }
  | { status: "failed"; error: string };

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

export function deliverBrowserNotification(
  event: ClientNotificationEvent,
): BrowserNotificationDeliveryResult {
  const result = showBrowserNotification(event);
  reportBrowserNotificationDeliveryFailure(event, result);
  return result;
}

function showBrowserNotification(
  event: ClientNotificationEvent,
): BrowserNotificationDeliveryResult {
  const api = browserNotificationApi();
  if (!api) return { status: "unsupported" };
  if (api.permission !== "granted") {
    return { status: "permission_denied", permission: api.permission };
  }
  try {
    new api(event.title, {
      body: event.body,
    });
    return { status: "delivered" };
  } catch (err) {
    return { status: "failed", error: errorMessage(err) };
  }
}

function reportBrowserNotificationDeliveryFailure(
  event: ClientNotificationEvent,
  result: BrowserNotificationDeliveryResult,
): void {
  if (result.status === "delivered" || result.status === "unsupported") return;
  const reason =
    result.status === "permission_denied"
      ? `permission ${result.permission}`
      : `constructor failed: ${result.error}`;
  console.warn("browser notification not delivered:", {
    reason,
    notificationId: event.id,
    category: event.category,
    kind: event.kind,
    title: event.title,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
