import { useEffect } from "react";
import { Platform } from "react-native";
import { useRouter } from "expo-router";
import { useSetAtom } from "jotai";
import * as Notifications from "expo-notifications";
import { buildViewHref } from "@/lib/view-location";
import { selectedProjectPathAtom, selectedSessionIdAtom } from "@/stores/projects";

if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

function stringField(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Routes a tapped push into the matching session chat (or the project inbox)
 * and handles cold-start taps via getLastNotificationResponseAsync. Renders
 * nothing and is inert on web, where push tokens are never registered.
 */
export function NativeNotificationRouter() {
  const router = useRouter();
  const selectProject = useSetAtom(selectedProjectPathAtom);
  const selectSession = useSetAtom(selectedSessionIdAtom);

  useEffect(() => {
    if (Platform.OS === "web") return;

    const route = (response: Notifications.NotificationResponse | null) => {
      const data = response?.notification.request.content.data;
      const projectRoot = stringField(data, "projectRoot");
      const sessionId = stringField(data, "sessionId");
      if (!projectRoot && !sessionId) return;
      if (projectRoot) selectProject(projectRoot);
      if (sessionId) {
        selectSession(sessionId);
        router.navigate(
          buildViewHref(`/notifications/agent/${encodeURIComponent(sessionId)}/chat`, {
            project: projectRoot,
          }),
        );
        return;
      }
      router.navigate(buildViewHref("/notifications", { project: projectRoot }));
    };

    let active = true;
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (active) route(response);
    });
    const subscription = Notifications.addNotificationResponseReceivedListener(route);
    return () => {
      active = false;
      subscription.remove();
    };
  }, [router, selectProject, selectSession]);

  return null;
}
