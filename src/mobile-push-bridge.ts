import { requestDaemonJson } from "./daemon-supervisor.js";
import { externalNotificationsDisabled } from "./external-notifications.js";
import type { AlertEvent } from "./project-events.js";

/**
 * Forwards an alert that already passed desktop notification gating to the
 * daemon, which relays it to the owner's mobile devices. Fire-and-forget: the
 * daemon owns the single relay connection, so the project service hands off and
 * never blocks the alert path on push delivery.
 */
export function forwardAlertToMobilePush(event: AlertEvent): void {
  if (externalNotificationsDisabled()) return;

  void requestDaemonJson("/internal/push", {
    method: "POST",
    body: JSON.stringify({
      title: event.title || "aimux",
      body: event.message || event.sessionId || event.kind,
      kind: event.kind,
      sessionId: event.sessionId,
      projectId: event.projectId,
      notificationId: event.notificationId,
      projectName: event.projectName,
      worktreePath: event.worktreePath,
      worktreeName: event.worktreeName,
      branch: event.branch,
      categoryLabel: event.categoryLabel,
      reasonLabel: event.reasonLabel,
      projectRoot: event.projectRoot ?? process.cwd(),
      dedupeKey: event.dedupeKey,
    }),
    headers: { "content-type": "application/json" },
  }).catch(() => {});
}
