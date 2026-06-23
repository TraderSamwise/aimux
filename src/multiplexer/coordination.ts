import { commandKey, parseKeys } from "../key-parser.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import { renderCoordinationScreen } from "../tui/screens/subscreen-renderers.js";
import type { WorklistItem } from "../coordination-model.js";
import {
  applyCoordinationFilter,
  ensureNotificationState,
  findNotificationSessionTarget,
  markCoordinationItemRead,
  openCoordinationNotification,
} from "./notifications.js";
import {
  renderThreadReply,
  runReviewLifecycleAction,
  runTaskLifecycleAction,
  runThreadHandoffAction,
  runThreadStatusAction,
} from "./subscreens.js";
import { startDashboardLifecycleTask } from "./dashboard-lifecycle.js";

type CoordinationHost = any;

function clampCoordinationIndex(host: CoordinationHost): void {
  const len = host.coordinationWorklist?.length ?? 0;
  if (typeof host.coordinationIndex !== "number" || Number.isNaN(host.coordinationIndex)) host.coordinationIndex = 0;
  host.coordinationIndex = len > 0 ? Math.min(Math.max(0, host.coordinationIndex), len - 1) : -1;
}

export function showCoordination(host: CoordinationHost): void {
  host.clearDashboardSubscreens();
  ensureNotificationState(host);
  clampCoordinationIndex(host);
  host.setDashboardScreen("coordination");
  host.writeStatuslineFile();
  renderCoordination(host);
  startDashboardLifecycleTask(
    host,
    { screen: "coordination" },
    () => host.refreshCoordinationFromService?.() ?? Promise.resolve(false),
    {
      onSuccess: () => renderCoordination(host),
    },
  );
}

export function renderCoordination(host: CoordinationHost): void {
  ensureNotificationState(host);
  clampCoordinationIndex(host);
  renderCoordinationScreen(host);
}

// Reload the worklist after a mutation from the service, preserving last API state on failure.
function reloadCoordination(host: CoordinationHost): Promise<void> {
  if (typeof host.refreshCoordinationFromService === "function") {
    return host.refreshCoordinationFromService({ force: true }).then(() => undefined);
  }
  return Promise.resolve();
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
    await host.postToProjectService(PROJECT_API_ROUTES.notifications.clear, { sessionId: item.sessionId });
  } else {
    for (const record of note.notifications) {
      await host.postToProjectService(PROJECT_API_ROUTES.notifications.clear, { id: record.id });
    }
  }
}

// Run a notification mutation through the service, then refresh + re-render. Failures flash.
function applyNotificationMutation(host: CoordinationHost, mutate: Promise<unknown>): void {
  startDashboardLifecycleTask(
    host,
    { inputEpoch: true, screen: "coordination" },
    async () => {
      await mutate;
      await reloadCoordination(host);
    },
    {
      onSuccess: () => renderCoordination(host),
      onError: () => {
        host.footerFlash = "Notification update failed";
        host.footerFlashTicks = 3;
        startDashboardLifecycleTask(
          host,
          { inputEpoch: true, screen: "coordination" },
          () => reloadCoordination(host),
          {
            onSuccess: () => renderCoordination(host),
            onError: () => renderCoordination(host),
          },
        );
      },
    },
  );
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
  const lowerKey = key.length === 1 ? key.toLowerCase() : key;
  const entry = item.thread;
  if (!entry) return;
  if (lowerKey === "s") {
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
  if (lowerKey === "c") {
    if (entry.task) void runTaskLifecycleAction(host, "complete", entry.task.id);
    else if (entry.thread.kind === "handoff") void runThreadHandoffAction(host, "complete", entry.thread.id);
    else void runThreadStatusAction(host, entry.thread.id, "done");
    return;
  }
  if (lowerKey === "b") {
    if (entry.task) void runTaskLifecycleAction(host, "block", entry.task.id);
    else void runThreadStatusAction(host, entry.thread.id, "blocked");
    return;
  }
  if (lowerKey === "o") {
    void runThreadStatusAction(host, entry.thread.id, "open");
    return;
  }
  if (lowerKey === "x") {
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
    void host
      .postToProjectService(PROJECT_API_ROUTES.threads.markSeen, {
        threadId: entry.thread.id,
        sessionId: targetSessionId,
      })
      .catch(() => {});
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
  const rawKey = event.name || event.char;
  const key = commandKey(event);
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
  if (key === "down" || (key === "j" && rawKey !== "J")) {
    if (items.length > 1) {
      host.coordinationIndex = (host.coordinationIndex + 1) % items.length;
      renderCoordination(host);
    }
    return;
  }
  if (key === "up" || (key === "k" && rawKey !== "K")) {
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
  if (rawKey === "R") {
    applyNotificationMutation(host, host.postToProjectService(PROJECT_API_ROUTES.notifications.read, {}));
    return;
  }
  if (rawKey === "C") {
    applyNotificationMutation(host, host.postToProjectService(PROJECT_API_ROUTES.notifications.clear, {}));
    return;
  }

  const item = items[host.coordinationIndex];
  if (!item) return;
  if (item.kind === "thread") dispatchThreadItem(host, rawKey, item);
  else dispatchNotificationItem(host, key, item);
}
