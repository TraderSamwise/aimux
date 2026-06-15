import { useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { isBrowserDocumentVisible, showBrowserNotification } from "@/lib/browser-notifications";
import {
  evaluateAgentNotification,
  evaluateNotificationRecordBatch,
  snapshotSessionForNotifications,
  type SessionNotificationSnapshot,
} from "@/lib/notification-policy";
import { desktopStateFamily } from "@/stores/desktopState";
import {
  markNotificationRecordsObservedAtom,
  notificationFeedFamily,
  notificationObservedIdsFamily,
} from "@/stores/notifications";
import { notificationSettingsAtom } from "@/stores/settings";
import { selectedProjectAtom, selectedProjectPathAtom } from "@/stores/projects";

const EMPTY_PROJECT_PATH = "__aimux_no_selected_project__";

export function NotificationProvider() {
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const projectScope = selectedProjectPath ?? EMPTY_PROJECT_PATH;
  const selectedProject = useAtomValue(selectedProjectAtom);
  const desktopState = useAtomValue(desktopStateFamily(projectScope));
  const notificationFeed = useAtomValue(notificationFeedFamily(projectScope));
  const observedNotificationIds = useAtomValue(notificationObservedIdsFamily(projectScope));
  const notificationSettings = useAtomValue(notificationSettingsAtom);
  const markNotificationRecordsObserved = useSetAtom(markNotificationRecordsObservedAtom);
  const snapshotsRef = useRef(new Map<string, SessionNotificationSnapshot>());
  const baselinedProjectsRef = useRef(new Set<string>());
  const seenNotificationIdsRef = useRef(new Map<string, Set<string>>());

  useEffect(() => {
    if (!notificationFeed) return;
    const currentIds = new Set(notificationFeed.notifications.map((record) => record.id));
    const seenIds = new Set([
      ...(seenNotificationIdsRef.current.get(projectScope) ?? new Set<string>()),
      ...observedNotificationIds,
    ]);

    if (!baselinedProjectsRef.current.has(projectScope)) {
      seenNotificationIdsRef.current.set(projectScope, currentIds);
      markNotificationRecordsObserved({ projectPath: projectScope, ids: currentIds });
      baselinedProjectsRef.current.add(projectScope);
      return;
    }

    const evaluation = evaluateNotificationRecordBatch(
      notificationFeed.notifications,
      notificationSettings,
      {
        projectName: selectedProject?.name,
        projectPath: selectedProjectPath ?? undefined,
      },
      seenIds,
      1,
    );
    for (const id of evaluation.observedIds) seenIds.add(id);
    if (evaluation.observedIds.length > 0) {
      markNotificationRecordsObserved({ projectPath: projectScope, ids: evaluation.observedIds });
    }

    if (notificationSettings.channels.browser && !isBrowserDocumentVisible()) {
      for (const event of evaluation.events) {
        showBrowserNotification(event);
      }
    }

    seenNotificationIdsRef.current.set(projectScope, seenIds);
  }, [
    markNotificationRecordsObserved,
    notificationFeed,
    notificationSettings,
    observedNotificationIds,
    projectScope,
    selectedProject?.name,
    selectedProjectPath,
  ]);

  useEffect(() => {
    if (notificationFeed) return;
    const nextSnapshots = new Map<string, SessionNotificationSnapshot>();
    const previousSnapshots = snapshotsRef.current;

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
    projectScope,
    selectedProject?.name,
    selectedProjectPath,
  ]);

  return null;
}
