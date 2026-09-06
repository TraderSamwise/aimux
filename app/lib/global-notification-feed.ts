import type { GlobalNotificationRow } from "@/stores/globalInbox";

export type GlobalNotificationScope = "all" | "project";

export interface GlobalNotificationSections {
  unread: GlobalNotificationRow[];
  read: GlobalNotificationRow[];
}

export function normalizeGlobalNotificationScope(
  value: string | null | undefined,
): GlobalNotificationScope {
  return value === "project" ? "project" : "all";
}

export function sortGlobalNotificationRows(
  a: GlobalNotificationRow,
  b: GlobalNotificationRow,
): number {
  if (a.notification.unread !== b.notification.unread) return a.notification.unread ? -1 : 1;
  const timeOrder = notificationCreatedAtMs(b) - notificationCreatedAtMs(a);
  if (timeOrder !== 0) return timeOrder;
  return (
    compareText(a.projectName, b.projectName) ||
    compareText(a.projectPath, b.projectPath) ||
    compareText(a.notification.title, b.notification.title) ||
    compareText(a.notification.body, b.notification.body) ||
    compareText(a.notification.id, b.notification.id)
  );
}

export function filterGlobalNotificationRows(
  rows: readonly GlobalNotificationRow[],
  scope: GlobalNotificationScope,
  projectPath: string | null | undefined,
): GlobalNotificationRow[] {
  if (scope !== "project" || !projectPath) {
    return [...rows].sort(sortGlobalNotificationRows);
  }
  return rows.filter((row) => row.projectPath === projectPath).sort(sortGlobalNotificationRows);
}

export function splitGlobalNotificationRows(
  rows: readonly GlobalNotificationRow[],
): GlobalNotificationSections {
  const sorted = [...rows].sort(sortGlobalNotificationRows);
  return {
    unread: sorted.filter((row) => row.notification.unread),
    read: sorted.filter((row) => !row.notification.unread),
  };
}

function notificationCreatedAtMs(row: GlobalNotificationRow): number {
  const ms = Date.parse(row.notification.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

function compareText(a: string | undefined, b: string | undefined): number {
  return (a ?? "").localeCompare(b ?? "");
}
