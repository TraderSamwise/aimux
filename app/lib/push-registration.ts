import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { getClientDeviceInfo } from "@/lib/client-device";

export async function registerSecurityPushToken(
  relayUrl: string,
  getToken: () => Promise<string | null>,
): Promise<void> {
  if (Platform.OS === "web") return;
  const permission = await Notifications.getPermissionsAsync();
  const finalPermission =
    permission.status === "granted" ? permission : await Notifications.requestPermissionsAsync();
  if (finalPermission.status !== "granted") return;

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
  if (!token) return;

  const res = await fetch(
    `${relayUrl.replace(/^ws/, "http").replace(/\/+$/, "")}/security/push-token`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        deviceId: device.deviceId,
        token: expoToken.data,
        platform: device.kind,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Push token registration failed (${res.status})`);
  }
}
