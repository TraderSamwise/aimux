import { parseKeys } from "../key-parser.js";
import { clearNotifications, markNotificationsRead } from "../notifications.js";
import { markThreadSeen } from "../threads.js";
import { renderCoordinationScreen } from "../tui/screens/subscreen-renderers.js";
import { buildCoordinationThreadEntries } from "../workflow.js";
import { ensureNotificationState, openSelectedNotification, refreshNotificationEntries } from "./notifications.js";
import {
  renderThreadReply,
  runReviewLifecycleAction,
  runTaskLifecycleAction,
  runThreadHandoffAction,
  runThreadStatusAction,
} from "./subscreens.js";

type CoordinationHost = any;

function clampThreadIndex(host: CoordinationHost): void {
  if (typeof host.threadIndex !== "number" || Number.isNaN(host.threadIndex)) host.threadIndex = 0;
  if (host.threadIndex >= host.threadEntries.length) host.threadIndex = Math.max(0, host.threadEntries.length - 1);
}

export function showCoordination(host: CoordinationHost): void {
  host.clearDashboardSubscreens();
  ensureNotificationState(host);
  refreshNotificationEntries(host);
  host.notificationIndex = host.notificationEntries.length > 0 ? Math.max(0, host.notificationIndex ?? 0) : -1;
  host.threadEntries = buildCoordinationThreadEntries("user");
  clampThreadIndex(host);
  if (host.coordinationSection !== "threads") host.coordinationSection = "notifications";
  host.setDashboardScreen("coordination");
  host.writeStatuslineFile();
  renderCoordination(host);
}

export function renderCoordination(host: CoordinationHost): void {
  ensureNotificationState(host);
  refreshNotificationEntries(host);
  if (!Array.isArray(host.threadEntries)) host.threadEntries = buildCoordinationThreadEntries("user");
  clampThreadIndex(host);
  if (host.coordinationSection !== "threads") host.coordinationSection = "notifications";
  renderCoordinationScreen(host);
}

function handleNotificationsSectionKey(host: CoordinationHost, key: string): void {
  const entries = host.notificationEntries ?? [];
  if (key === "down" || key === "j") {
    if (entries.length > 1) {
      host.notificationIndex = (host.notificationIndex + 1) % entries.length;
      renderCoordination(host);
    }
    return;
  }
  if (key === "up" || key === "k") {
    if (entries.length > 1) {
      host.notificationIndex = (host.notificationIndex - 1 + entries.length) % entries.length;
      renderCoordination(host);
    }
    return;
  }
  if (key >= "1" && key <= "9") {
    const idx = parseInt(key, 10) - 1;
    if (idx < entries.length) {
      host.notificationIndex = idx;
      renderCoordination(host);
    }
    return;
  }
  if (key === "r") {
    const entry = entries[host.notificationIndex];
    if (!entry) return;
    markNotificationsRead({ id: entry.id });
    refreshNotificationEntries(host);
    renderCoordination(host);
    return;
  }
  if (key === "R") {
    markNotificationsRead();
    refreshNotificationEntries(host);
    renderCoordination(host);
    return;
  }
  if (key === "c") {
    const entry = entries[host.notificationIndex];
    if (!entry) return;
    clearNotifications({ id: entry.id });
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
  if (key === "enter" || key === "return") {
    void openSelectedNotification(host);
  }
}

function findCoordinationTarget(host: CoordinationHost, sessionId: string): any | undefined {
  return (
    host.getDashboardSessions?.().find((entry: any) => entry.id === sessionId) ??
    (host.dashboardTeammatesCache ?? []).find((entry: any) => entry.id === sessionId)
  );
}

function handleThreadsSectionKey(host: CoordinationHost, key: string): void {
  const entries = host.threadEntries ?? [];
  if (key === "down" || key === "j") {
    if (entries.length > 1) {
      host.threadIndex = (host.threadIndex + 1) % entries.length;
      renderCoordination(host);
    }
    return;
  }
  if (key === "up" || key === "k") {
    if (entries.length > 1) {
      host.threadIndex = (host.threadIndex - 1 + entries.length) % entries.length;
      renderCoordination(host);
    }
    return;
  }
  if (key >= "1" && key <= "9") {
    const idx = parseInt(key, 10) - 1;
    if (idx < entries.length) {
      host.threadIndex = idx;
      renderCoordination(host);
    }
    return;
  }
  if (key === "r") {
    host.threadEntries = buildCoordinationThreadEntries("user");
    clampThreadIndex(host);
    renderCoordination(host);
    return;
  }
  const entry = entries[host.threadIndex];
  if (!entry) return;
  if (key === "s") {
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
    const dashEntry = findCoordinationTarget(host, targetSessionId);
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
    host.coordinationSection = host.coordinationSection === "threads" ? "notifications" : "threads";
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
  if (host.coordinationSection === "threads") {
    handleThreadsSectionKey(host, key);
  } else {
    handleNotificationsSectionKey(host, key);
  }
}
