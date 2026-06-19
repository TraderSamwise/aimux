import { parseKeys } from "../key-parser.js";
import { markThreadSeen } from "../threads.js";
import { renderCoordinationScreen } from "../tui/screens/subscreen-renderers.js";
import type { WorklistItem } from "../coordination-model.js";
import {
  applyCoordinationFilter,
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
  // Instant local paint, then refine from the service (the authority) and re-render.
  refreshNotificationEntries(host);
  clampCoordinationIndex(host);
  host.setDashboardScreen("coordination");
  host.writeStatuslineFile();
  renderCoordination(host);
  void host.refreshCoordinationFromService?.().then(() => renderCoordination(host));
}

export function renderCoordination(host: CoordinationHost): void {
  ensureNotificationState(host);
  // Render from cached coordination state; only build locally if nothing has loaded yet. Refreshes
  // (service or local) populate the cache on screen entry, heartbeat, and after mutations.
  if (!host.coordinationLoaded) refreshNotificationEntries(host);
  clampCoordinationIndex(host);
  renderCoordinationScreen(host);
}

// Reload the worklist after a mutation: prefer the service (sole authority); fall back to the
// local build when the host has no service binding (e.g. tests) or the service is unreachable.
function reloadCoordination(host: CoordinationHost): Promise<void> {
  if (typeof host.refreshCoordinationFromService === "function") {
    return host.refreshCoordinationFromService().then(() => undefined);
  }
  refreshNotificationEntries(host);
  return Promise.resolve();
}

// Push-driven liveness: a coordination-relevant project event (another agent needs you, a task
// completed, …) refreshes the worklist and re-renders immediately when the screen is showing,
// instead of waiting for the heartbeat poll. Coalesced so a burst of events does one refresh.
export function scheduleCoordinationPush(host: CoordinationHost): void {
  if (host.coordinationPushScheduled) return;
  if (!host.isDashboardScreen?.("coordination")) return;
  host.coordinationPushScheduled = true;
  void reloadCoordination(host)
    .then(() => renderCoordination(host))
    .catch(() => {})
    .finally(() => {
      host.coordinationPushScheduled = false;
    });
}

// Point the reply-overlay backing (host.threadEntries[threadIndex]) at a worklist thread item.
function syncThreadIndex(host: CoordinationHost, item: WorklistItem): void {
  const threadId = item.thread?.thread.id;
  if (!threadId) return;
  const idx = (host.threadEntries ?? []).findIndex((entry: any) => entry.thread.id === threadId);
  if (idx >= 0) host.threadIndex = idx;
}

// Clear an agent's whole rollup (by sessionId) or each sessionless record — via the service.
async function clearNotificationItem(host: CoordinationHost, item: WorklistItem): Promise<void> {
  const note = item.notification;
  if (!note) return;
  if (item.sessionId) {
    await host.postToProjectService("/notifications/clear", { sessionId: item.sessionId });
  } else {
    for (const record of note.notifications) {
      await host.postToProjectService("/notifications/clear", { id: record.id });
    }
  }
}

// Run a notification mutation through the service, then refresh + re-render. Failures flash.
function applyNotificationMutation(host: CoordinationHost, mutate: Promise<unknown>): void {
  void mutate
    .then(() => reloadCoordination(host))
    .then(() => renderCoordination(host))
    .catch(() => {
      host.footerFlash = "Notification update failed";
      host.footerFlashTicks = 3;
      renderCoordination(host);
    });
}

function dispatchNotificationItem(host: CoordinationHost, key: string, item: WorklistItem): void {
  if (key === "r") {
    applyNotificationMutation(host, markCoordinationItemRead(host, item));
    return;
  }
  if (key === "c") {
    applyNotificationMutation(host, clearNotificationItem(host, item));
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
    applyCoordinationFilter(host);
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
    applyNotificationMutation(host, host.postToProjectService("/notifications/read", {}));
    return;
  }
  if (key === "C") {
    applyNotificationMutation(host, host.postToProjectService("/notifications/clear", {}));
    return;
  }

  const item = items[host.coordinationIndex];
  if (!item) return;
  if (item.kind === "thread") dispatchThreadItem(host, key, item);
  else dispatchNotificationItem(host, key, item);
}
