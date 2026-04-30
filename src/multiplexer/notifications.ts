import type { NotificationRecord } from "../notifications.js";
import { clearNotifications, listNotifications, markNotificationsRead } from "../notifications.js";
import { parseKeys } from "../key-parser.js";
import { renderNotificationsScreen } from "../tui/screens/subscreen-renderers.js";

type NotificationHost = any;

export function showNotificationPanel(host: NotificationHost): void {
  const entries = listNotifications({ includeCleared: false }).slice(0, 40);
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
    panel.entries = listNotifications({ includeCleared: false }).slice(0, 40);
    if (panel.index >= panel.entries.length) panel.index = panel.entries.length - 1;
    host.renderDashboard();
    return;
  }
  if (key === "c") {
    const selected = panel.entries[panel.index];
    if (!selected) return;
    clearNotifications({ id: selected.id });
    panel.entries = listNotifications({ includeCleared: false }).slice(0, 40);
    if (panel.index >= panel.entries.length) panel.index = panel.entries.length - 1;
    host.renderDashboard();
    return;
  }
  if (key === "C") {
    clearNotifications();
    panel.entries = [];
    panel.index = -1;
    host.renderDashboard();
  }
}

function loadNotificationEntries(): NotificationRecord[] {
  return listNotifications({ includeCleared: false }).slice(0, 200);
}

function refreshNotificationEntries(host: NotificationHost): void {
  host.notificationEntries = loadNotificationEntries();
  if (host.notificationIndex >= host.notificationEntries.length) {
    host.notificationIndex = Math.max(0, host.notificationEntries.length - 1);
  }
}

export function hydrateDashboardNotificationScreenState(host: NotificationHost): void {
  if (!host.isDashboardScreen?.("notifications")) return;
  refreshNotificationEntries(host);
  host.notificationIndex = host.notificationEntries.length > 0 ? Math.max(0, host.notificationIndex ?? 0) : -1;
}

function ensureNotificationState(host: NotificationHost): void {
  if (!Array.isArray(host.notificationEntries)) {
    host.notificationEntries = [];
  }
  if (typeof host.notificationIndex !== "number" || Number.isNaN(host.notificationIndex)) {
    host.notificationIndex = host.notificationEntries.length > 0 ? 0 : -1;
  }
}

export function showNotifications(host: NotificationHost): void {
  host.clearDashboardSubscreens();
  refreshNotificationEntries(host);
  host.notificationIndex = host.notificationEntries.length > 0 ? Math.max(0, host.notificationIndex ?? 0) : -1;
  host.setDashboardScreen("notifications");
  host.writeStatuslineFile();
  renderNotifications(host);
}

export function renderNotifications(host: NotificationHost): void {
  ensureNotificationState(host);
  refreshNotificationEntries(host);
  renderNotificationsScreen(host);
}

export function notificationTargetLabel(host: NotificationHost, sessionId?: string): string | null {
  if (!sessionId) return null;
  const session = host.getDashboardSessions().find((entry: any) => entry.id === sessionId);
  if (session) {
    return `${session.label ?? session.command}${session.worktreeName ? ` · ${session.worktreeName}` : ""}`;
  }
  const service = host.getDashboardServices().find((entry: any) => entry.id === sessionId);
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
  const session = host.getDashboardSessions().find((entry: any) => entry.id === sessionId);
  if (session) {
    return session.status === "offline" ? "offline" : "live";
  }
  const service = host.getDashboardServices().find((entry: any) => entry.id === sessionId);
  if (service) {
    return service.status === "running" ? "live" : "offline";
  }
  return "missing";
}

function openSelectedNotification(host: NotificationHost): void {
  const entry = host.notificationEntries[host.notificationIndex];
  if (!entry) return;
  if (!entry.sessionId) {
    if (entry.unread) {
      markNotificationsRead({ id: entry.id });
      refreshNotificationEntries(host);
    }
    renderNotifications(host);
    return;
  }
  const targetState = notificationTargetState(host, entry.sessionId);
  if (targetState === "missing") {
    host.footerFlash = "Notification target is no longer available";
    host.footerFlashTicks = 3;
    renderNotifications(host);
    return;
  }
  const session = host.getDashboardSessions().find((candidate: any) => candidate.id === entry.sessionId);
  if (session) {
    if (entry.unread) {
      markNotificationsRead({ id: entry.id });
      refreshNotificationEntries(host);
    }
    void host.activateDashboardEntry(session);
    return;
  }
  const service = host.getDashboardServices().find((candidate: any) => candidate.id === entry.sessionId);
  if (!service) {
    host.footerFlash = "Notification target is no longer available";
    host.footerFlashTicks = 3;
    renderNotifications(host);
    return;
  }
  if (entry.unread) {
    markNotificationsRead({ id: entry.id });
    refreshNotificationEntries(host);
  }
  void host.activateDashboardService(service);
}

export function handleNotificationsKey(host: NotificationHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = event.name || event.char;
  const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");

  if (isTabToggle) {
    host.dashboardState.toggleDetailsSidebar();
    renderNotifications(host);
    return;
  }
  if (key === "q") {
    host.exitDashboardClientOrProcess();
    return;
  }
  if (key === "escape" || key === "d") {
    host.setDashboardScreen("dashboard");
    host.renderDashboard();
    return;
  }
  if (host.handleDashboardSubscreenNavigationKey(key, "notifications")) return;
  if (key === "?") {
    host.showHelp();
    return;
  }
  if (key === "down" || key === "j") {
    if (host.notificationEntries.length > 1) {
      host.notificationIndex = (host.notificationIndex + 1) % host.notificationEntries.length;
      renderNotifications(host);
    }
    return;
  }
  if (key === "up" || key === "k") {
    if (host.notificationEntries.length > 1) {
      host.notificationIndex =
        (host.notificationIndex - 1 + host.notificationEntries.length) % host.notificationEntries.length;
      renderNotifications(host);
    }
    return;
  }
  if (key >= "1" && key <= "9") {
    const idx = parseInt(key, 10) - 1;
    if (idx < host.notificationEntries.length) {
      host.notificationIndex = idx;
      renderNotifications(host);
    }
    return;
  }
  if (key === "r") {
    const entry = host.notificationEntries[host.notificationIndex];
    if (!entry) return;
    markNotificationsRead({ id: entry.id });
    refreshNotificationEntries(host);
    renderNotifications(host);
    return;
  }
  if (key === "R") {
    markNotificationsRead();
    refreshNotificationEntries(host);
    renderNotifications(host);
    return;
  }
  if (key === "c") {
    const entry = host.notificationEntries[host.notificationIndex];
    if (!entry) return;
    clearNotifications({ id: entry.id });
    refreshNotificationEntries(host);
    renderNotifications(host);
    return;
  }
  if (key === "C") {
    clearNotifications();
    refreshNotificationEntries(host);
    renderNotifications(host);
    return;
  }
  if (key === "enter" || key === "return") {
    openSelectedNotification(host);
  }
}
