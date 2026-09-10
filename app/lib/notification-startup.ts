import {
  notificationStartupIssueForError,
  type NotificationStartupIssue,
  type NotificationStartupIssueSource,
} from "@/stores/notificationStartup";

export interface ObserveNotificationStartupInput<T> {
  source: NotificationStartupIssueSource;
  operation: () => Promise<T>;
  onIssue: (issue: NotificationStartupIssue) => void;
  onClear: (source: NotificationStartupIssueSource) => void;
  warn?: (
    message: string,
    details: { source: NotificationStartupIssueSource; error: string },
  ) => void;
}

export async function observeNotificationStartup<T>({
  source,
  operation,
  onIssue,
  onClear,
  warn = console.warn,
}: ObserveNotificationStartupInput<T>): Promise<T | null> {
  try {
    const result = await operation();
    onClear(source);
    return result;
  } catch (error) {
    const issue = notificationStartupIssueForError(source, error);
    warn("notification startup degraded:", { source, error: issue.error });
    onIssue(issue);
    return null;
  }
}
