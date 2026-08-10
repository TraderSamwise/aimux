import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { getClientDeviceInfo } from "@/lib/client-device";
import { buildSecurityPushRegistrationUrl } from "@/lib/push-registration-url";

export type PushRegistrationResult =
  | { status: "unsupported" }
  | { status: "permission_denied"; permissionStatus: Notifications.PermissionStatus }
  | { status: "missing_auth" }
  | { status: "registered"; deviceId: string; token: string };

export interface PushRegistrationOptions {
  ownerUserId?: string;
  shareId?: string;
  requestPermission?: boolean;
  agentAlerts?: boolean;
}

export async function registerSecurityPushToken(
  relayUrl: string,
  getToken: () => Promise<string | null>,
  options: PushRegistrationOptions = {},
): Promise<PushRegistrationResult> {
  if (Platform.OS === "web") return { status: "unsupported" };
  const permission = await Notifications.getPermissionsAsync();
  const finalPermission =
    permission.status === "granted" || !options.requestPermission
      ? permission
      : await Notifications.requestPermissionsAsync();
  if (finalPermission.status !== "granted") {
    return { status: "permission_denied", permissionStatus: finalPermission.status };
  }

  const projectId =
    Constants.easConfig?.projectId ??
    (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("security", {
      name: "Security alerts",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  const expoToken = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );
  const device = await getClientDeviceInfo();
  const token = await getToken();
  if (!token) return { status: "missing_auth" };

  const url = buildSecurityPushRegistrationUrl(relayUrl, options);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      deviceId: device.deviceId,
      token: expoToken.data,
      platform: device.kind,
      agentAlerts: options.agentAlerts ?? true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Push token registration failed (${res.status})`);
  }
  return { status: "registered", deviceId: device.deviceId, token: expoToken.data };
}
