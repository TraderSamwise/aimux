import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { isBrowserDocumentVisible, showBrowserNotification } from "@/lib/browser-notifications";
import {
  evaluateAgentNotification,
  snapshotSessionForNotifications,
  type SessionNotificationSnapshot,
} from "@/lib/notification-policy";
import { desktopStateFamily } from "@/stores/desktopState";
import { notificationSettingsAtom } from "@/stores/settings";
import { selectedProjectAtom, selectedProjectPathAtom } from "@/stores/projects";

const EMPTY_PROJECT_PATH = "__aimux_no_selected_project__";

export function NotificationProvider() {
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const selectedProject = useAtomValue(selectedProjectAtom);
  const desktopState = useAtomValue(desktopStateFamily(selectedProjectPath ?? EMPTY_PROJECT_PATH));
  const notificationSettings = useAtomValue(notificationSettingsAtom);
  const snapshotsRef = useRef(new Map<string, SessionNotificationSnapshot>());

  useEffect(() => {
    const nextSnapshots = new Map<string, SessionNotificationSnapshot>();
    const previousSnapshots = snapshotsRef.current;

    for (const session of desktopState?.sessions ?? []) {
      const current = snapshotSessionForNotifications(session);
      nextSnapshots.set(session.id, current);

      const event = evaluateAgentNotification(
        session,
        previousSnapshots.get(session.id),
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
  }, [desktopState, notificationSettings, selectedProject?.name, selectedProjectPath]);

  return null;
}
