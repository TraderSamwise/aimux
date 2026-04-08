import { clearNotifications, listNotifications, markNotificationsRead } from "../notifications.js";
import { parseKeys } from "../key-parser.js";

type NotificationHost = any;

export function showNotificationPanel(host: NotificationHost): void {
  const entries = listNotifications({ includeCleared: false }).slice(0, 40);
  host.notificationPanelState = {
    entries,
    index: entries.length > 0 ? 0 : -1,
  };
  host.syncTuiNotificationContext(true);
  host.renderDashboard();
}

export function closeNotificationPanel(host: NotificationHost): void {
  host.notificationPanelState = null;
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
