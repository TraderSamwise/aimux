import type { NotificationRecord } from "../notifications.js";
import { parseKeys } from "../key-parser.js";
import { renderNotificationsScreen } from "../tui/screens/subscreen-renderers.js";
import { createRuntimeExchangeStore } from "../runtime-core/exchange-store.js";
import { markThreadSeen } from "../threads.js";

type NotificationHost = any;

export function showNotificationPanel(host: NotificationHost): void {
  const entries = loadNotificationEntries(host).slice(0, 40);
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
    markRuntimeInboxEntriesDone({ id: selected.id });
    panel.entries = loadNotificationEntries(host).slice(0, 40);
    if (panel.index >= panel.entries.length) panel.index = panel.entries.length - 1;
    host.renderDashboard();
    return;
  }
  if (key === "c") {
    const selected = panel.entries[panel.index];
    if (!selected) return;
    markRuntimeInboxEntriesDone({ id: selected.id });
    panel.entries = loadNotificationEntries(host).slice(0, 40);
    if (panel.index >= panel.entries.length) panel.index = panel.entries.length - 1;
    host.renderDashboard();
    return;
  }
  if (key === "C") {
    markRuntimeInboxEntriesDone();
    panel.entries = [];
    panel.index = -1;
    host.renderDashboard();
  }
}

function hasNotificationTarget(host: NotificationHost, participantId: string): boolean {
  return Boolean(
    findNotificationSessionTarget(host, participantId) ?? findNotificationServiceTarget(host, participantId),
  );
}

function notificationTargetSessionId(host: NotificationHost, participantId: string): string | undefined {
  return hasNotificationTarget(host, participantId) ? participantId : undefined;
}

function loadNotificationEntries(host: NotificationHost): NotificationRecord[] {
  const exchange = createRuntimeExchangeStore().read();
  const threadById = new Map(exchange.threads.map((thread) => [thread.id, thread] as const));
  const taskById = new Map(exchange.tasks.map((task) => [task.id, task] as const));
  const latestMessageByThread = new Map<string, (typeof exchange.messages)[number]>();
  for (const message of exchange.messages) {
    const existing = latestMessageByThread.get(message.threadId);
    if (!existing || existing.ts < message.ts) latestMessageByThread.set(message.threadId, message);
  }
  return exchange.inbox
    .filter((entry) => entry.state !== "done")
    .map((entry): NotificationRecord | undefined => {
      if (entry.subjectKind === "thread" || entry.subjectKind === "handoff" || entry.subjectKind === "message") {
        const thread = threadById.get(entry.subjectId);
        if (!thread) return undefined;
        const message = latestMessageByThread.get(thread.id);
        return {
          id: entry.id,
          title: thread.title,
          subtitle: `${thread.kind} · ${thread.status}`,
          body: message?.body ?? thread.title,
          sessionId: notificationTargetSessionId(host, entry.participantId),
          targetKind: notificationTargetSessionId(host, entry.participantId)
            ? ("session" as const)
            : ("generic" as const),
          kind: entry.subjectKind,
          unread: true,
          cleared: false,
          createdAt: entry.updatedAt,
          updatedAt: entry.updatedAt,
        };
      }
      const task = taskById.get(entry.subjectId);
      if (!task) return undefined;
      return {
        id: entry.id,
        title: task.description,
        subtitle: `${task.type ?? "task"} · ${task.status}`,
        body: task.result ?? task.error ?? task.prompt,
        sessionId: notificationTargetSessionId(host, entry.participantId),
        targetKind: notificationTargetSessionId(host, entry.participantId)
          ? ("session" as const)
          : ("generic" as const),
        kind: entry.subjectKind,
        unread: true,
        cleared: false,
        createdAt: entry.updatedAt,
        updatedAt: entry.updatedAt,
      };
    })
    .filter((entry): entry is NotificationRecord => Boolean(entry))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200);
}

function markRuntimeInboxEntriesDone(input: { id?: string } = {}): void {
  const store = createRuntimeExchangeStore();
  const entries = store.read().inbox.filter((entry) => !input.id || entry.id === input.id);
  for (const entry of entries) {
    if (entry.subjectKind === "thread" || entry.subjectKind === "handoff" || entry.subjectKind === "message") {
      markThreadSeen(entry.subjectId, entry.participantId);
    }
  }
  store.update((exchange) => ({
    ...exchange,
    inbox: exchange.inbox.map((entry) => (!input.id || entry.id === input.id ? { ...entry, state: "done" } : entry)),
  }));
}

function refreshNotificationEntries(host: NotificationHost): void {
  host.notificationEntries = loadNotificationEntries(host);
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

function findNotificationSessionTarget(host: NotificationHost, sessionId: string): any | undefined {
  return (
    host.getDashboardSessions?.().find((entry: any) => entry.id === sessionId) ??
    (host.dashboardTeammatesCache ?? []).find((entry: any) => entry.id === sessionId)
  );
}

function findNotificationServiceTarget(host: NotificationHost, sessionId: string): any | undefined {
  return host.getDashboardServices?.().find((entry: any) => entry.id === sessionId);
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

async function openSelectedNotification(host: NotificationHost): Promise<void> {
  const entry = host.notificationEntries[host.notificationIndex];
  if (!entry) return;
  if (!entry.sessionId) {
    if (entry.unread) {
      markRuntimeInboxEntriesDone({ id: entry.id });
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
  const session = findNotificationSessionTarget(host, entry.sessionId);
  if (session) {
    try {
      await host.activateDashboardEntry(session, {
        preserveDashboardSelection: Boolean(session.team),
      });
    } catch {
      host.footerFlash = "Failed to open notification target";
      host.footerFlashTicks = 3;
      renderNotifications(host);
      return;
    }
    if (entry.unread) {
      markRuntimeInboxEntriesDone({ id: entry.id });
      refreshNotificationEntries(host);
    }
    return;
  }
  const service = findNotificationServiceTarget(host, entry.sessionId);
  if (!service) {
    host.footerFlash = "Notification target is no longer available";
    host.footerFlashTicks = 3;
    renderNotifications(host);
    return;
  }
  try {
    await host.activateDashboardService(service);
  } catch {
    host.footerFlash = "Failed to open notification target";
    host.footerFlashTicks = 3;
    renderNotifications(host);
    return;
  }
  if (entry.unread) {
    markRuntimeInboxEntriesDone({ id: entry.id });
    refreshNotificationEntries(host);
  }
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
    markRuntimeInboxEntriesDone({ id: entry.id });
    refreshNotificationEntries(host);
    renderNotifications(host);
    return;
  }
  if (key === "R") {
    markRuntimeInboxEntriesDone();
    refreshNotificationEntries(host);
    renderNotifications(host);
    return;
  }
  if (key === "c") {
    const entry = host.notificationEntries[host.notificationIndex];
    if (!entry) return;
    markRuntimeInboxEntriesDone({ id: entry.id });
    refreshNotificationEntries(host);
    renderNotifications(host);
    return;
  }
  if (key === "C") {
    markRuntimeInboxEntriesDone();
    refreshNotificationEntries(host);
    renderNotifications(host);
    return;
  }
  if (key === "enter" || key === "return") {
    void openSelectedNotification(host);
  }
}
