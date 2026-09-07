export interface AimuxNotificationDeepLinkTarget {
  projectRoot?: string;
  sessionId?: string;
  notificationId?: string;
}

export function buildAimuxNotificationDeepLink(target: AimuxNotificationDeepLinkTarget): string | null {
  const projectRoot = target.projectRoot?.trim();
  const sessionId = target.sessionId?.trim();
  const notificationId = target.notificationId?.trim();
  if (!projectRoot || !sessionId || !notificationId) return null;

  const params = new URLSearchParams({
    project: projectRoot,
    notificationId,
    focusToken: notificationId,
  });
  return `aimux:///agent/${encodeURIComponent(sessionId)}/chat?${params.toString()}`;
}
