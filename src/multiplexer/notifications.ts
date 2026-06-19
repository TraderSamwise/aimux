import { clearNotifications, listNotifications, markNotificationsRead } from "../notifications.js";
import { buildCoordinationModel, buildCoordinationWorklist, type CoordinationReachability, type WorklistItem } from "../coordination-model.js";
import { buildCoordinationThreadEntries } from "../workflow.js";
import { parseKeys } from "../key-parser.js";

type NotificationHost = any;

/** Per-row reconciliation flags, index-aligned with host.notificationEntries. */
export interface NotificationRowMeta {
  reachability: CoordinationReachability;
  stale: boolean;
  actionable: boolean;
}

export function showNotificationPanel(host: NotificationHost): void {
  const entries = listNotifications().slice(0, 40);
  host.notificationPanelState = {
    entries,
    index: entries.length > 0 ? 0 : -1,
  };
  host.openDashboardOverlay("notification-panel");
  host.syncTuiNotificationContext(true);
  host.renderDashboard();
}

export function closeNotificationPanel(host: NotificationHost): void {
  host.notificationPanelState = null;
  host.clearDashboardOverlay();
  host.syncTuiNotificationContext(false);
  host.renderDashboard();
}

export function renderNotificationPanel(host: NotificationHost): void {
  host.renderNotificationPanel();
}

export function handleNotificationPanelKey(host: NotificationHost, data: Buffer): void {
  const panel = host.notificationPanelState;
  if (!panel) return;
  const events = parseKeys(data);
  if (events.length === 0) return;
  const key = events[0].name || events[0].char;

  if (key === "escape" || key === "enter" || key === "return") {
    closeNotificationPanel(host);
    return;
  }
  if (key === "down" || key === "j") {
    if (panel.entries.length > 1) {
      panel.index = (panel.index + 1) % panel.entries.length;
      host.renderDashboard();
    }
    return;
  }
  if (key === "up" || key === "k") {
    if (panel.entries.length > 1) {
      panel.index = (panel.index - 1 + panel.entries.length) % panel.entries.length;
      host.renderDashboard();
    }
    return;
  }
  if (key === "r") {
    const selected = panel.entries[panel.index];
    if (!selected) return;
    markNotificationsRead({ id: selected.id });
    panel.entries = listNotifications().slice(0, 40);
    if (panel.index >= panel.entries.length) panel.index = panel.entries.length - 1;
    host.renderDashboard();
    return;
  }
  if (key === "c") {
    const selected = panel.entries[panel.index];
    if (!selected) return;
    clearNotifications({ id: selected.id });
    panel.entries = listNotifications().slice(0, 40);
    if (panel.index >= panel.entries.length) panel.index = panel.entries.length - 1;
    host.renderDashboard();
    return;
  }
  if (key === "C") {
    clearNotifications();
    panel.entries = listNotifications().slice(0, 40);
    panel.index = panel.entries.length > 0 ? 0 : -1;
    host.renderDashboard();
  }
}

export function refreshNotificationEntries(host: NotificationHost): void {
  // Single coordination refresh: rebuild genuine threads, reconcile notifications against live
  // agent state, and merge both into the unified worklist that drives the screen. Called from
  // every notification/thread mutation site (actions, cleanup, hydrate) so the screen stays
  // coherent. The legacy notificationEntries/meta are kept for the open path + reply overlay.
  host.threadEntries = buildCoordinationThreadEntries("user");
  const modelInput = {
    sessions: host.getDashboardSessions?.() ?? [],
    teammates: host.dashboardTeammatesCache ?? [],
    services: host.getDashboardServices?.() ?? [],
    notifications: listNotifications(),
    threads: host.threadEntries,
  };
  const model = buildCoordinationModel(modelInput);
  host.coordinationModel = model;
  host.notificationEntries = model.items.flatMap((item) => item.notifications);
  host.notificationRowMeta = model.items.flatMap((item) =>
    item.notifications.map(
      (): NotificationRowMeta => ({
        reachability: item.reachability,
        stale: item.stale,
        actionable: item.actionable,
      }),
    ),
  );
  const worklist = buildCoordinationWorklist({ ...modelInput, model });
  host.coordinationWorklist =
    host.coordinationFilter === "threads" ? worklist.items.filter((item) => item.kind === "thread") : worklist.items;
  const length = host.coordinationWorklist.length;
  if (host.coordinationIndex == null || host.coordinationIndex >= length) {
    host.coordinationIndex = length > 0 ? Math.max(0, length - 1) : -1;
  }
  if (host.notificationIndex >= host.notificationEntries.length) {
    host.notificationIndex = Math.max(0, host.notificationEntries.length - 1);
  }
}

export function hydrateDashboardNotificationScreenState(host: NotificationHost): void {
  if (!host.isDashboardScreen?.("coordination")) return;
  refreshNotificationEntries(host);
  host.notificationIndex = host.notificationEntries.length > 0 ? Math.max(0, host.notificationIndex ?? 0) : -1;
}

export function ensureNotificationState(host: NotificationHost): void {
  if (!Array.isArray(host.notificationEntries)) {
    host.notificationEntries = [];
  }
  if (!Array.isArray(host.notificationRowMeta)) {
    host.notificationRowMeta = [];
  }
  if (!Array.isArray(host.coordinationWorklist)) {
    host.coordinationWorklist = [];
  }
  if (host.coordinationFilter !== "threads") {
    host.coordinationFilter = "all";
  }
  if (typeof host.coordinationIndex !== "number" || Number.isNaN(host.coordinationIndex)) {
    host.coordinationIndex = host.coordinationWorklist.length > 0 ? 0 : -1;
  }
  if (typeof host.notificationIndex !== "number" || Number.isNaN(host.notificationIndex)) {
    host.notificationIndex = host.notificationEntries.length > 0 ? 0 : -1;
  }
}

export function findNotificationSessionTarget(host: NotificationHost, sessionId: string): any | undefined {
  return (
    host.getDashboardSessions?.().find((entry: any) => entry.id === sessionId) ??
    (host.dashboardTeammatesCache ?? []).find((entry: any) => entry.id === sessionId)
  );
}

function findNotificationServiceTarget(host: NotificationHost, sessionId: string): any | undefined {
  return host.getDashboardServices?.().find((entry: any) => entry.id === sessionId);
}

export function notificationTargetLabel(host: NotificationHost, sessionId?: string): string | null {
  if (!sessionId) return null;
  const session = findNotificationSessionTarget(host, sessionId);
  if (session) {
    return `${session.label ?? session.command}${session.worktreeName ? ` · ${session.worktreeName}` : ""}`;
  }
  const service = findNotificationServiceTarget(host, sessionId);
  if (service) {
    return `${service.label ?? service.command} [service]${service.worktreeName ? ` · ${service.worktreeName}` : ""}`;
  }
  return null;
}

export function notificationTargetState(
  host: NotificationHost,
  sessionId?: string,
): "live" | "offline" | "missing" | "none" {
  if (!sessionId) return "none";
  const session = findNotificationSessionTarget(host, sessionId);
  if (session) {
    return session.status === "offline" ? "offline" : "live";
  }
  const service = findNotificationServiceTarget(host, sessionId);
  if (service) {
    return service.status === "running" ? "live" : "offline";
  }
  return "missing";
}

// Mark an agent's whole notification rollup read (by sessionId), or each sessionless record.
export function markCoordinationItemRead(item: WorklistItem): void {
  const note = item.notification;
  if (!note) return;
  if (item.sessionId) markNotificationsRead({ sessionId: item.sessionId });
  else for (const record of note.notifications) markNotificationsRead({ id: record.id });
}

export async function openCoordinationNotification(host: NotificationHost, item: WorklistItem): Promise<void> {
  const note = item.notification;
  if (!note) return;
  const unread = note.unreadCount > 0;
  const settle = () => {
    if (unread) {
      markCoordinationItemRead(item);
      refreshNotificationEntries(host);
    }
  };
  if (!item.sessionId) {
    settle();
    host.renderCoordination();
    return;
  }
  if (notificationTargetState(host, item.sessionId) === "missing") {
    host.footerFlash = "Notification target is no longer available";
    host.footerFlashTicks = 3;
    host.renderCoordination();
    return;
  }
  const session = findNotificationSessionTarget(host, item.sessionId);
  if (session) {
    try {
      await host.activateDashboardEntry(session, { preserveDashboardSelection: Boolean(session.team) });
    } catch {
      host.footerFlash = "Failed to open notification target";
      host.footerFlashTicks = 3;
      host.renderCoordination();
      return;
    }
    settle();
    return;
  }
  const service = findNotificationServiceTarget(host, item.sessionId);
  if (!service) {
    host.footerFlash = "Notification target is no longer available";
    host.footerFlashTicks = 3;
    host.renderCoordination();
    return;
  }
  try {
    await host.activateDashboardService(service);
  } catch {
    host.footerFlash = "Failed to open notification target";
    host.footerFlashTicks = 3;
    host.renderCoordination();
    return;
  }
  settle();
}
