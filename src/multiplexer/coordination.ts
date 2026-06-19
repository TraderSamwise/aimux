import { parseKeys } from "../key-parser.js";
import { clearNotifications, markNotificationsRead } from "../notifications.js";
import { markThreadSeen } from "../threads.js";
import { renderCoordinationScreen } from "../tui/screens/subscreen-renderers.js";
import type { WorklistItem } from "../coordination-model.js";
import {
  ensureNotificationState,
  findNotificationSessionTarget,
  markCoordinationItemRead,
  openCoordinationNotification,
  refreshNotificationEntries,
} from "./notifications.js";
import {
  renderThreadReply,
  runReviewLifecycleAction,
  runTaskLifecycleAction,
  runThreadHandoffAction,
  runThreadStatusAction,
} from "./subscreens.js";

type CoordinationHost = any;

function clampCoordinationIndex(host: CoordinationHost): void {
  const len = host.coordinationWorklist?.length ?? 0;
  if (typeof host.coordinationIndex !== "number" || Number.isNaN(host.coordinationIndex)) host.coordinationIndex = 0;
  host.coordinationIndex = len > 0 ? Math.min(Math.max(0, host.coordinationIndex), len - 1) : -1;
}

export function showCoordination(host: CoordinationHost): void {
  host.clearDashboardSubscreens();
  ensureNotificationState(host);
  refreshNotificationEntries(host);
  clampCoordinationIndex(host);
  host.setDashboardScreen("coordination");
  host.writeStatuslineFile();
  renderCoordination(host);
}

export function renderCoordination(host: CoordinationHost): void {
  ensureNotificationState(host);
  refreshNotificationEntries(host);
  clampCoordinationIndex(host);
  renderCoordinationScreen(host);
}

// Point the reply-overlay backing (host.threadEntries[threadIndex]) at a worklist thread item.
function syncThreadIndex(host: CoordinationHost, item: WorklistItem): void {
  const threadId = item.thread?.thread.id;
  if (!threadId) return;
  const idx = (host.threadEntries ?? []).findIndex((entry: any) => entry.thread.id === threadId);
  if (idx >= 0) host.threadIndex = idx;
}

function clearNotificationItem(item: WorklistItem): void {
  const note = item.notification;
  if (!note) return;
  if (item.sessionId) clearNotifications({ sessionId: item.sessionId });
  else for (const record of note.notifications) clearNotifications({ id: record.id });
}

function dispatchNotificationItem(host: CoordinationHost, key: string, item: WorklistItem): void {
  if (key === "r") {
    markCoordinationItemRead(item);
    refreshNotificationEntries(host);
    renderCoordination(host);
    return;
  }
  if (key === "c") {
    clearNotificationItem(item);
    refreshNotificationEntries(host);
    renderCoordination(host);
    return;
  }
  if (key === "enter" || key === "return") {
    void openCoordinationNotification(host, item);
  }
}

function dispatchThreadItem(host: CoordinationHost, key: string, item: WorklistItem): void {
  const entry = item.thread;
  if (!entry) return;
  if (key === "s") {
    syncThreadIndex(host, item);
    host.openDashboardOverlay("thread-reply");
    host.threadReplyBuffer = "";
    renderThreadReply(host);
    return;
  }
  if (key === "A") {
    if (entry.task) void runTaskLifecycleAction(host, "accept", entry.task.id);
    else if (entry.thread.kind === "handoff") void runThreadHandoffAction(host, "accept", entry.thread.id);
    return;
  }
  if (key === "c") {
    if (entry.task) void runTaskLifecycleAction(host, "complete", entry.task.id);
    else if (entry.thread.kind === "handoff") void runThreadHandoffAction(host, "complete", entry.thread.id);
    else void runThreadStatusAction(host, entry.thread.id, "done");
    return;
  }
  if (key === "b") {
    if (entry.task) void runTaskLifecycleAction(host, "block", entry.task.id);
    else void runThreadStatusAction(host, entry.thread.id, "blocked");
    return;
  }
  if (key === "o") {
    void runThreadStatusAction(host, entry.thread.id, "open");
    return;
  }
  if (key === "x") {
    void runThreadStatusAction(host, entry.thread.id, "done");
    return;
  }
  if (key === "P") {
    if (entry.task) void runReviewLifecycleAction(host, "approve", entry.task.id);
    return;
  }
  if (key === "J") {
    if (entry.task) void runReviewLifecycleAction(host, "request_changes", entry.task.id);
    return;
  }
  if (key === "E") {
    if (entry.task) void runTaskLifecycleAction(host, "reopen", entry.task.id);
    return;
  }
  if (key === "enter" || key === "return") {
    const targetSessionId = entry.thread.owner ?? entry.thread.waitingOn?.[0] ?? entry.thread.participants[0];
    if (!targetSessionId) return;
    markThreadSeen(entry.thread.id, targetSessionId);
    const dashEntry = findNotificationSessionTarget(host, targetSessionId);
    if (dashEntry) {
      void host.activateDashboardEntry(dashEntry, { preserveDashboardSelection: Boolean(dashEntry.team) });
    }
  }
}

export function handleCoordinationKey(host: CoordinationHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = event.name || event.char;
  const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");

  if (isTabToggle) {
    host.coordinationFilter = host.coordinationFilter === "threads" ? "all" : "threads";
    host.coordinationIndex = 0;
    renderCoordination(host);
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
  if (host.handleDashboardSubscreenNavigationKey(key, "coordination")) return;
  if (key === "?") {
    host.showHelp();
    return;
  }

  const items: WorklistItem[] = host.coordinationWorklist ?? [];
  if (key === "down" || key === "j") {
    if (items.length > 1) {
      host.coordinationIndex = (host.coordinationIndex + 1) % items.length;
      renderCoordination(host);
    }
    return;
  }
  if (key === "up" || key === "k") {
    if (items.length > 1) {
      host.coordinationIndex = (host.coordinationIndex - 1 + items.length) % items.length;
      renderCoordination(host);
    }
    return;
  }
  if (key >= "1" && key <= "9") {
    const idx = parseInt(key, 10) - 1;
    if (idx < items.length) {
      host.coordinationIndex = idx;
      renderCoordination(host);
    }
    return;
  }
  if (key === "R") {
    markNotificationsRead();
    refreshNotificationEntries(host);
    renderCoordination(host);
    return;
  }
  if (key === "C") {
    clearNotifications();
    refreshNotificationEntries(host);
    renderCoordination(host);
    return;
  }

  const item = items[host.coordinationIndex];
  if (!item) return;
  if (item.kind === "thread") dispatchThreadItem(host, key, item);
  else dispatchNotificationItem(host, key, item);
}
