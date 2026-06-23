import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import {
  type CoordinationModel,
  type CoordinationReachability,
  type CoordinationWorklist,
  type WorklistItem,
} from "../coordination-model.js";
import { type WorkflowEntry } from "../workflow.js";
import {
  type DashboardLifecycleToken,
  isDashboardLifecycleCurrent,
  startDashboardLifecycleTask,
} from "./dashboard-lifecycle.js";
import { getOrCreateTuiApiRuntime } from "./tui-api-runtime.js";

type NotificationHost = any;
interface ApiViewRefreshOptions {
  force?: boolean;
  lifecycle?: DashboardLifecycleToken;
}
const COORDINATION_WORKLIST_RESOURCE = "coordination-worklist";

/** Per-row reconciliation flags, index-aligned with host.notificationEntries. */
export interface NotificationRowMeta {
  reachability: CoordinationReachability;
  stale: boolean;
  actionable: boolean;
}

/** Reconciled coordination payload. */
interface CoordinationPayload {
  model: CoordinationModel;
  worklist: CoordinationWorklist;
  threads: WorkflowEntry[];
}

function validateCoordinationPayload(value: unknown): CoordinationPayload {
  const res = value as any;
  if (
    !res?.ok ||
    !Array.isArray(res.model?.items) ||
    !Array.isArray(res.worklist?.items) ||
    (res.threads != null && !Array.isArray(res.threads))
  ) {
    throw new Error("invalid coordination payload");
  }
  return { model: res.model, worklist: res.worklist, threads: res.threads ?? [] };
}

// Apply a reconciled service payload to the host: legacy notificationEntries/meta (open path
// + reply overlay), the full unfiltered worklist, then the filtered view.
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

// Prefer the service's reconciled worklist (the single authority, shared with the app). On
// failure preserve the last service payload so version skew cannot silently fork the view.
export async function refreshCoordinationFromService(
  host: NotificationHost,
  options: ApiViewRefreshOptions = {},
): Promise<boolean> {
  if (typeof host.getFromProjectService !== "function") return false;
  try {
    const result = await getOrCreateTuiApiRuntime(host).refreshJson(
      COORDINATION_WORKLIST_RESOURCE,
      PROJECT_API_ROUTES.coordinationWorklist,
      validateCoordinationPayload,
      { supersede: options.force },
    );
    if (!result.ok || !result.value) return false;
    if (options.lifecycle && !isDashboardLifecycleCurrent(host, options.lifecycle)) return false;
    applyCoordinationModel(host, result.value);
    return true;
  } catch {
    return false;
  }
}

export function hydrateDashboardNotificationScreenState(host: NotificationHost): void {
  if (!host.isDashboardScreen?.("coordination")) return;
  startDashboardLifecycleTask(
    host,
    { screen: "coordination" },
    () => host.refreshCoordinationFromService?.() ?? Promise.resolve(false),
    {
      onSuccess: () => host.renderCurrentDashboardView?.(),
    },
  );
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

function activationSucceeded(result: unknown): boolean {
  return result === undefined || result === "opened";
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
    return session.status === "offline" || session.status === "exited" ? "offline" : "live";
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
    if (!unread) return;
    try {
      await markCoordinationItemRead(host, item);
      await host.refreshCoordinationFromService?.({ force: true });
    } catch {
      host.footerFlash = "Notification update failed";
      host.footerFlashTicks = 3;
      if (typeof host.refreshCoordinationFromService === "function") {
        await host.refreshCoordinationFromService({ force: true }).catch(() => {});
      }
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
      const result = await host.activateDashboardEntry(session, { preserveDashboardSelection: Boolean(session.team) });
      if (!activationSucceeded(result)) {
        failOpen();
        return;
      }
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
    const result = await host.activateDashboardService(service);
    if (!activationSucceeded(result)) {
      failOpen();
      return;
    }
  } catch {
    failOpen();
    return;
  }
  await settle();
}
