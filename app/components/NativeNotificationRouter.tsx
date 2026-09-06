import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import * as Notifications from "expo-notifications";
import { markNotificationsRead } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import { ensureSecurityNotificationChannel } from "@/lib/push-registration";
import { buildViewHref } from "@/lib/view-location";
import { markNotificationRecordsReadLocalAtom } from "@/stores/notifications";
import { projectsAtom, selectedProjectPathAtom, selectedSessionIdAtom } from "@/stores/projects";

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
  const markNotificationsReadLocal = useSetAtom(markNotificationRecordsReadLocalAtom);
  const projects = useAtomValue(projectsAtom);
  const { getToken } = useAuth();
  const projectsRef = useRef(projects);
  const getTokenRef = useRef(getToken);

  useEffect(() => {
    projectsRef.current = projects;
    getTokenRef.current = getToken;
  }, [getToken, projects]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    void ensureSecurityNotificationChannel().catch(() => undefined);

    const route = (response: Notifications.NotificationResponse | null) => {
      const data = response?.notification.request.content.data;
      const projectRoot = stringField(data, "projectRoot");
      const sessionId = stringField(data, "sessionId");
      const notificationId = stringField(data, "notificationId");
      if (!projectRoot && !sessionId) return;
      markNotificationsReadLocal({ projectPath: projectRoot, ids: [notificationId] });
      void (async () => {
        if (!projectRoot || !notificationId) return;
        const project = projectsRef.current.find((item) => item.path === projectRoot);
        const endpoint = project ? getProjectServiceEndpoint(project) : null;
        if (!endpoint) return;
        try {
          const token = await getTokenRef.current();
          await markNotificationsRead(endpoint, { id: notificationId }, { token });
        } catch {
          // Device-local read state is the source of truth for this tap.
        }
      })();
      if (projectRoot) selectProject(projectRoot);
      if (sessionId) {
        selectSession(sessionId);
        router.navigate({
          pathname: "/agent/[sessionId]/chat",
          params: {
            focusToken: Date.now().toString(36),
            project: projectRoot,
            sessionId,
          },
        });
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
  }, [markNotificationsReadLocal, router, selectProject, selectSession]);

  return null;
}
