import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import * as Notifications from "expo-notifications";
import { markNotificationsRead } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { markProgrammaticComposerBlur } from "@/lib/chat-keyboard-intent";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import { ensureSecurityNotificationChannel } from "@/lib/push-registration";
import { observeNotificationStartup } from "@/lib/notification-startup";
import { buildViewHref } from "@/lib/view-location";
import { markNotificationRecordsReadLocalAtom } from "@/stores/notifications";
import {
  clearNotificationStartupIssueAtom,
  reportNotificationStartupIssueAtom,
} from "@/stores/notificationStartup";
import { findProjectForRef, projectRefFromPayload, projectStateKey } from "@/lib/project-key";
import { projectsAtom, selectProjectAtom, selectedSessionIdAtom } from "@/stores/projects";

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
  const selectProject = useSetAtom(selectProjectAtom);
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const markNotificationsReadLocal = useSetAtom(markNotificationRecordsReadLocalAtom);
  const reportNotificationStartupIssue = useSetAtom(reportNotificationStartupIssueAtom);
  const clearNotificationStartupIssue = useSetAtom(clearNotificationStartupIssueAtom);
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
    void observeNotificationStartup({
      source: "security_channel",
      operation: ensureSecurityNotificationChannel,
      onIssue: reportNotificationStartupIssue,
      onClear: clearNotificationStartupIssue,
    });

    const route = (response: Notifications.NotificationResponse | null) => {
      const data = response?.notification.request.content.data;
      const projectRoot = stringField(data, "projectRoot");
      // Stamped by the relay from the sending daemon's own socket. A payload
      // from before that existed names no machine, and still resolves when one
      // machine has the path.
      const payloadMachineId = stringField(data, "machineId");
      const sessionId = stringField(data, "sessionId");
      const notificationId = stringField(data, "notificationId");
      if (!projectRoot && !sessionId) return;
      const tappedRef = projectRefFromPayload(projectsRef.current, projectRoot, payloadMachineId);
      // Only marked where it can be found again. An unresolved ref -- a
      // payload naming no machine while two hosts hold the path -- used to
      // file the mark under the "no project" key, so the real project never
      // saw it and the notification stayed unread for good. Leaving it unread
      // is the right answer: the row in the app knows which machine, so the
      // tap is still there to be made.
      if (tappedRef) {
        markNotificationsReadLocal({
          projectStateKey: projectStateKey(tappedRef),
          ids: [notificationId],
        });
      }
      void (async () => {
        if (!projectRoot || !notificationId) return;
        const project = findProjectForRef(projectsRef.current, tappedRef);
        const endpoint = project ? getProjectServiceEndpoint(project) : null;
        if (!endpoint) return;
        try {
          const token = await getTokenRef.current();
          await markNotificationsRead(endpoint, { id: notificationId }, { token });
        } catch {
          // The device-local mark above usually carries this, but not always:
          // it is held until the stored marks have been read, and a tap during
          // that window is dropped rather than persisted over them. So a tap
          // whose server mark ALSO fails can show up unread again.
        }
      })();
      // With no machine named and two machines holding the path, the tap
      // selects nothing rather than opening the wrong host.
      if (tappedRef) selectProject(tappedRef);
      if (sessionId) {
        selectSession(sessionId);
        // Marked, not dismissed: the navigation does the blurring, and a tap
        // on the chat already open re-runs no focus effect -- so dismissing
        // here would lose a keyboard with nothing left to restore it.
        markProgrammaticComposerBlur();
        router.navigate({
          pathname: "/agent/[sessionId]/chat",
          params: {
            focusToken: Date.now().toString(36),
            notificationId,
            project: projectRoot,
            // Absent when two machines hold this path; the chat then opens on
            // whatever the selection already resolved to rather than guessing.
            ...(tappedRef?.machineId ? { machine: tappedRef.machineId } : {}),
            sessionId,
          },
        });
        return;
      }
      router.navigate(
        buildViewHref("/notifications", {
          project: projectRoot,
          machine: tappedRef?.machineId,
        }),
      );
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
  }, [
    clearNotificationStartupIssue,
    markNotificationsReadLocal,
    reportNotificationStartupIssue,
    router,
    selectProject,
    selectSession,
  ]);

  return null;
}
