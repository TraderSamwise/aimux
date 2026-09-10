import { atom } from "jotai";
import { getErrorMessage } from "@/lib/request-errors";

export type NotificationStartupIssueSource = "push_registration" | "security_channel";

export interface NotificationStartupIssue {
  source: NotificationStartupIssueSource;
  title: string;
  body: string;
  error: string;
  reportedAt: number;
}

export const notificationStartupIssueAtom = atom<NotificationStartupIssue | null>(null);

export function notificationStartupIssueForError(
  source: NotificationStartupIssueSource,
  error: unknown,
  reportedAt = Date.now(),
): NotificationStartupIssue {
  const message = getErrorMessage(error);
  const body =
    source === "security_channel"
      ? `Security notification channel setup failed: ${message}`
      : `Push registration failed: ${message}`;
  return {
    source,
    title: "Notifications degraded",
    body,
    error: message,
    reportedAt,
  };
}

export const reportNotificationStartupIssueAtom = atom(
  null,
  (_get, set, issue: NotificationStartupIssue) => {
    set(notificationStartupIssueAtom, issue);
  },
);

export const clearNotificationStartupIssueAtom = atom(
  null,
  (get, set, source: NotificationStartupIssueSource) => {
    const current = get(notificationStartupIssueAtom);
    if (current?.source === source) set(notificationStartupIssueAtom, null);
  },
);
