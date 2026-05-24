import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { isBrowserDocumentVisible, showBrowserNotification } from "@/lib/browser-notifications";
import {
  evaluateAgentNotification,
  evaluateNotificationRecord,
  snapshotSessionForNotifications,
  type SessionNotificationSnapshot,
} from "@/lib/notification-policy";
import { desktopStateFamily } from "@/stores/desktopState";
import { notificationFeedFamily } from "@/stores/notifications";
import { notificationSettingsAtom } from "@/stores/settings";
import { selectedProjectAtom, selectedProjectPathAtom } from "@/stores/projects";

const EMPTY_PROJECT_PATH = "__aimux_no_selected_project__";

export function NotificationProvider() {
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const selectedProject = useAtomValue(selectedProjectAtom);
  const desktopState = useAtomValue(desktopStateFamily(selectedProjectPath ?? EMPTY_PROJECT_PATH));
  const notificationFeed = useAtomValue(
    notificationFeedFamily(selectedProjectPath ?? EMPTY_PROJECT_PATH),
  );
  const notificationSettings = useAtomValue(notificationSettingsAtom);
  const snapshotsRef = useRef(new Map<string, SessionNotificationSnapshot>());
  const baselinedProjectsRef = useRef(new Set<string>());
  const seenNotificationIdsRef = useRef(new Map<string, Set<string>>());

  useEffect(() => {
    if (!notificationFeed) return;
    const projectScope = selectedProjectPath ?? EMPTY_PROJECT_PATH;
    const currentIds = new Set(notificationFeed.notifications.map((record) => record.id));
    const seenIds = seenNotificationIdsRef.current.get(projectScope) ?? new Set<string>();

    if (!baselinedProjectsRef.current.has(projectScope)) {
      seenNotificationIdsRef.current.set(projectScope, currentIds);
      baselinedProjectsRef.current.add(projectScope);
      return;
    }

    for (const record of notificationFeed.notifications) {
      if (seenIds.has(record.id)) continue;
      seenIds.add(record.id);

      const event = evaluateNotificationRecord(record, notificationSettings, {
        projectName: selectedProject?.name,
        projectPath: selectedProjectPath ?? undefined,
      });

      if (!event) continue;
      if (notificationSettings.channels.browser && !isBrowserDocumentVisible()) {
        showBrowserNotification(event);
      }
    }

    seenNotificationIdsRef.current.set(projectScope, seenIds);
  }, [notificationFeed, notificationSettings, selectedProject?.name, selectedProjectPath]);

  useEffect(() => {
    if (notificationFeed) return;
    const nextSnapshots = new Map<string, SessionNotificationSnapshot>();
    const previousSnapshots = snapshotsRef.current;
    const projectScope = selectedProjectPath ?? EMPTY_PROJECT_PATH;

    for (const session of desktopState?.sessions ?? []) {
      const current = snapshotSessionForNotifications(session);
      const sessionKey = `${projectScope}:${session.id}`;
      nextSnapshots.set(sessionKey, current);

      const event = evaluateAgentNotification(
        session,
        previousSnapshots.get(sessionKey),
        notificationSettings,
        {
          projectName: selectedProject?.name,
          projectPath: selectedProjectPath ?? undefined,
        },
      );

      if (!event) continue;
      if (notificationSettings.channels.browser && !isBrowserDocumentVisible()) {
        showBrowserNotification(event);
      }
    }

    snapshotsRef.current = nextSnapshots;
  }, [
    desktopState,
    notificationFeed,
    notificationSettings,
    selectedProject?.name,
    selectedProjectPath,
  ]);

  return null;
}
