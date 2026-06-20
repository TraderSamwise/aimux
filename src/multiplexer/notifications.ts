import { listNotifications, type NotificationRecord } from "../notifications.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import {
  buildCoordinationView,
  type CoordinationModel,
  type CoordinationReachability,
  type CoordinationWorklist,
  type WorklistItem,
} from "../coordination-model.js";
import { buildCoordinationThreadEntries, type WorkflowEntry } from "../workflow.js";
import { parseKeys } from "../key-parser.js";

type NotificationHost = any;

/** Per-row reconciliation flags, index-aligned with host.notificationEntries. */
export interface NotificationRowMeta {
  reachability: CoordinationReachability;
  stale: boolean;
  actionable: boolean;
}

export function showNotificationPanel(host: NotificationHost): void {
  const entries = host.notificationPanelState?.entries ?? [];
  host.notificationPanelState = {
    entries,
    index: entries.length > 0 ? 0 : -1,
  };
  host.openDashboardOverlay("notification-panel");
  host.syncTuiNotificationContext(true);
  host.renderDashboard();
  void refreshNotificationPanelFromService(host).then(() => host.renderDashboard()).catch(() => {
    host.footerFlash = "Notification refresh failed";
    host.footerFlashTicks = 3;
    host.renderDashboard();
  });
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
    void mutateNotificationsViaService(host, PROJECT_API_ROUTES.notifications.read, { id: selected.id });
    return;
  }
  if (key === "c") {
    const selected = panel.entries[panel.index];
    if (!selected) return;
    void mutateNotificationsViaService(host, PROJECT_API_ROUTES.notifications.clear, { id: selected.id });
    return;
  }
  if (key === "C") {
    void mutateNotificationsViaService(host, PROJECT_API_ROUTES.notifications.clear, {}, { resetIndex: true });
  }
}

// Route a notification panel mutation through the service (sole writer), then reload the panel
// from the service. Failures flash rather than mutating local notification state directly.
async function mutateNotificationsViaService(
  host: NotificationHost,
  path: typeof PROJECT_API_ROUTES.notifications.read | typeof PROJECT_API_ROUTES.notifications.clear,
  selector: { id?: string; sessionId?: string },
  opts: { resetIndex?: boolean } = {},
): Promise<void> {
  try {
    await host.postToProjectService(path, selector);
    const panel = host.notificationPanelState;
    if (!panel) return;
    await refreshNotificationPanelFromService(host);
    if (opts.resetIndex) panel.index = panel.entries.length > 0 ? 0 : -1;
  } catch {
    host.footerFlash = "Notification update failed";
    host.footerFlashTicks = 3;
    host.renderDashboard();
    return;
  }
  host.renderDashboard();
}

export async function refreshNotificationPanelFromService(host: NotificationHost): Promise<boolean> {
  const panel = host.notificationPanelState;
  if (!panel) return false;
  const res = await host.getFromProjectService(PROJECT_API_ROUTES.notifications.list);
  if (!res?.ok || !Array.isArray(res.notifications)) {
    throw new Error("invalid notifications payload");
  }
  panel.entries = (res.notifications as NotificationRecord[]).slice(0, 40);
  if (panel.index >= panel.entries.length) panel.index = panel.entries.length - 1;
  if (panel.index < 0 && panel.entries.length > 0) panel.index = 0;
  if (panel.entries.length === 0) panel.index = -1;
  return true;
}

/** Reconciled coordination payload. */
interface CoordinationPayload {
  model: CoordinationModel;
  worklist: CoordinationWorklist;
  threads: WorkflowEntry[];
}

// Apply a reconciled coordination payload to the host: legacy notificationEntries/meta (open path
// + reply overlay), the full unfiltered worklist, then the filtered view. Shared by the local
// build and the service refresh so both produce identical host state.
export function applyCoordinationModel(host: NotificationHost, payload: CoordinationPayload): void {
  host.threadEntries = payload.threads;
  host.coordinationModel = payload.model;
  host.notificationEntries = payload.model.items.flatMap((item) => item.notifications);
  host.notificationRowMeta = payload.model.items.flatMap((item) =>
    item.notifications.map(
      (): NotificationRowMeta => ({
        reachability: item.reachability,
        stale: item.stale,
        actionable: item.actionable,
      }),
    ),
  );
  host.coordinationWorklistAll = payload.worklist.items;
  host.coordinationLoaded = true;
  applyCoordinationFilter(host);
}

// Derive the filtered worklist from the full set and clamp the selection indices. Cheap and
// synchronous so the Tab filter toggle re-applies without a rebuild or a service round-trip.
export function applyCoordinationFilter(host: NotificationHost): void {
  const all: WorklistItem[] = host.coordinationWorklistAll ?? [];
  host.coordinationWorklist =
    host.coordinationFilter === "threads" ? all.filter((item) => item.kind === "thread") : all;
  const length = host.coordinationWorklist.length;
  if (host.coordinationIndex == null || host.coordinationIndex >= length) {
    host.coordinationIndex = length > 0 ? Math.max(0, length - 1) : -1;
  }
  const notificationCount = Array.isArray(host.notificationEntries) ? host.notificationEntries.length : 0;
  if (host.notificationIndex >= notificationCount) {
    host.notificationIndex = Math.max(0, notificationCount - 1);
  }
}

export function refreshNotificationEntries(host: NotificationHost): void {
  // Local build used by non-dashboard internals and tests; the dashboard reads this via the
  // project-service coordination endpoint.
  const threads = buildCoordinationThreadEntries("user");
  const { model, worklist } = buildCoordinationView({
    sessions: host.getDashboardSessions?.() ?? [],
    teammates: host.dashboardTeammatesCache ?? [],
    services: host.getDashboardServices?.() ?? [],
    notifications: listNotifications(),
    threads,
  });
  applyCoordinationModel(host, { model, worklist, threads });
}

// Prefer the service's reconciled worklist (the single authority, shared with the app). On
// failure preserve the last service payload so version skew cannot silently fork the view.
export async function refreshCoordinationFromService(host: NotificationHost): Promise<boolean> {
  try {
    const res = await host.getFromProjectService(PROJECT_API_ROUTES.coordinationWorklist);
    // Validate before mutating so version-skewed payloads cannot half-apply.
    if (!res?.ok || !Array.isArray(res.model?.items) || !Array.isArray(res.worklist?.items)) {
      throw new Error("invalid coordination payload");
    }
    applyCoordinationModel(host, { model: res.model, worklist: res.worklist, threads: res.threads ?? [] });
    return true;
  } catch {
    return false;
  }
}

export function hydrateDashboardNotificationScreenState(host: NotificationHost): void {
  if (!host.isDashboardScreen?.("coordination")) return;
  void host.refreshCoordinationFromService?.().then(() => host.renderCurrentDashboardView?.()).catch(() => {});
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
  if (!Array.isArray(host.coordinationWorklistAll)) {
    host.coordinationWorklistAll = [];
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

// Mark an agent's whole notification rollup read (by sessionId), or each sessionless record —
// routed through the service so it stays the sole writer of the notifications store.
export async function markCoordinationItemRead(host: NotificationHost, item: WorklistItem): Promise<void> {
  const note = item.notification;
  if (!note) return;
  if (item.sessionId) {
    await host.postToProjectService(PROJECT_API_ROUTES.notifications.read, { sessionId: item.sessionId });
  } else {
    for (const record of note.notifications) {
      await host.postToProjectService(PROJECT_API_ROUTES.notifications.read, { id: record.id });
    }
  }
}

export async function openCoordinationNotification(host: NotificationHost, item: WorklistItem): Promise<void> {
  const note = item.notification;
  if (!note) return;
  const unread = note.unreadCount > 0;
  const settle = async () => {
    if (unread) {
      await markCoordinationItemRead(host, item);
      await host.refreshCoordinationFromService?.();
    }
  };
  if (!item.sessionId) {
    await settle();
    host.renderCoordination();
    return;
  }
  const targetState = notificationTargetState(host, item.sessionId);
  if (targetState === "missing") {
    host.footerFlash = "Notification target is no longer available";
    host.footerFlashTicks = 3;
    host.renderCoordination();
    return;
  }
  // Waking an offline target resumes its tmux session, which renders the dashboard as it
  // restores; we switch to the dashboard screen first (just before activation) so that render —
  // and any failure feedback — lands on the screen we actually end up on, not coordination.
  const offline = targetState === "offline";
  const failOpen = (): void => {
    host.footerFlash = "Failed to open notification target";
    host.footerFlashTicks = 3;
    if (offline) host.renderDashboard();
    else host.renderCoordination();
  };
  const session = findNotificationSessionTarget(host, item.sessionId);
  if (session) {
    if (offline) host.setDashboardScreen("dashboard");
    try {
      await host.activateDashboardEntry(session, { preserveDashboardSelection: Boolean(session.team) });
    } catch {
      failOpen();
      return;
    }
    await settle();
    return;
  }
  const service = findNotificationServiceTarget(host, item.sessionId);
  if (!service) {
    host.footerFlash = "Notification target is no longer available";
    host.footerFlashTicks = 3;
    host.renderCoordination();
    return;
  }
  if (offline) host.setDashboardScreen("dashboard");
  try {
    await host.activateDashboardService(service);
  } catch {
    failOpen();
    return;
  }
  await settle();
}
