import { TextDecoder } from "node:util";

import { debug } from "../debug.js";
import { removeMetadataEndpoint, resolveProjectServiceEndpoint } from "../metadata-store.js";
import {
  PROJECT_API_EVENT_NAMES,
  PROJECT_API_ROUTES,
  PROJECT_API_VIEWS,
  type ProjectApiView,
  type ProjectUpdateEvent,
} from "../project-api-contract.js";
import type { AlertEvent } from "../project-events.js";
import { refreshGraveyardEntriesFromService } from "./archives.js";
import { refreshLibrary } from "./library.js";
import { refreshProjectObservability } from "./project.js";
import { refreshTopology } from "./topology.js";

type ProjectEventStreamHost = any;

const RETRY_MS = 1_000;

export function startDashboardProjectEventStream(host: ProjectEventStreamHost): void {
  stopDashboardProjectEventStream(host);
  const controller = new AbortController();
  host.dashboardProjectEventStreamAbort = controller;
  void runDashboardProjectEventLoop(host, controller.signal).catch((error) => {
    if (!controller.signal.aborted) {
      debug(`dashboard project event stream stopped: ${error instanceof Error ? error.message : String(error)}`, "dashboard");
    }
  });
}

export function stopDashboardProjectEventStream(host: ProjectEventStreamHost): void {
  host.dashboardProjectEventStreamAbort?.abort?.();
  host.dashboardProjectEventStreamAbort = null;
  if (host.dashboardProjectEventRefreshTimer) {
    clearTimeout(host.dashboardProjectEventRefreshTimer);
    host.dashboardProjectEventRefreshTimer = null;
  }
  host.dashboardProjectEventPendingViews = null;
}

async function runDashboardProjectEventLoop(host: ProjectEventStreamHost, signal: AbortSignal): Promise<void> {
  while (!signal.aborted && host.mode === "dashboard") {
    const endpoint = resolveProjectServiceEndpoint(process.cwd());
    if (!endpoint) {
      await host.ensureDashboardControlPlane?.().catch(() => undefined);
      await sleep(RETRY_MS, signal);
      continue;
    }
    const url = `http://${endpoint.host}:${endpoint.port}${PROJECT_API_ROUTES.events}`;
    try {
      const response = await fetch(url, {
        headers: { accept: "text/event-stream" },
        signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`event stream request failed: ${response.status}`);
      }
      await readEventStream(response.body, signal, (name, payload) => handleProjectEvent(host, name, payload));
    } catch (error) {
      if (signal.aborted || host.mode !== "dashboard") return;
      debug(`dashboard project event stream reconnecting: ${error instanceof Error ? error.message : String(error)}`, "dashboard");
      removeMetadataEndpoint(process.cwd());
      await sleep(RETRY_MS, signal);
    }
  }
}

async function readEventStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (name: string, payload: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let eventName = "message";
  let dataLines: string[] = [];
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const rawLine = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        ({ eventName, dataLines } = processEventStreamLine(rawLine, eventName, dataLines, onEvent));
        newline = pending.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function processEventStreamLine(
  rawLine: string,
  eventName: string,
  dataLines: string[],
  onEvent: (name: string, payload: unknown) => void,
): { eventName: string; dataLines: string[] } {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (!line) {
    if (dataLines.length > 0) {
      const data = dataLines.join("\n");
      try {
        onEvent(eventName, JSON.parse(data));
      } catch (error) {
        debug(`ignored malformed dashboard SSE payload: ${error instanceof Error ? error.message : String(error)}`, "dashboard");
      }
    }
    return { eventName: "message", dataLines: [] };
  }
  if (line.startsWith(":")) return { eventName, dataLines };
  const sep = line.indexOf(":");
  const field = sep >= 0 ? line.slice(0, sep) : line;
  const value = sep >= 0 ? line.slice(sep + 1).replace(/^ /, "") : "";
  if (field === "event") return { eventName: value || "message", dataLines };
  if (field === "data") return { eventName, dataLines: [...dataLines, value] };
  return { eventName, dataLines };
}

export function handleProjectEvent(host: ProjectEventStreamHost, name: string, payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  if (name === PROJECT_API_EVENT_NAMES.ready) {
    scheduleProjectViewRefresh(host, PROJECT_API_VIEWS);
    return;
  }
  if (name === PROJECT_API_EVENT_NAMES.projectUpdate) {
    const event = payload as ProjectUpdateEvent;
    if (Array.isArray(event.views)) {
      scheduleProjectViewRefresh(host, event.views);
    }
    return;
  }
  if (name === PROJECT_API_EVENT_NAMES.alert) {
    applyDashboardAlert(host, payload as AlertEvent);
  }
}

export function scheduleProjectViewRefresh(host: ProjectEventStreamHost, views: readonly ProjectApiView[]): void {
  const pending = (host.dashboardProjectEventPendingViews ?? new Set<ProjectApiView>()) as Set<ProjectApiView>;
  for (const view of views) pending.add(view);
  host.dashboardProjectEventPendingViews = pending;
  if (host.dashboardProjectEventRefreshTimer) return;
  host.dashboardProjectEventRefreshTimer = setTimeout(() => {
    host.dashboardProjectEventRefreshTimer = null;
    const current = host.dashboardProjectEventPendingViews as Set<ProjectApiView> | null;
    host.dashboardProjectEventPendingViews = null;
    if (current) void refreshDashboardApiViews(host, current).catch(() => undefined);
  }, 25);
}

async function refreshDashboardApiViews(host: ProjectEventStreamHost, views: Set<ProjectApiView>): Promise<void> {
  if (host.mode !== "dashboard") return;
  const work: Array<Promise<unknown>> = [];
  if (
    touches(views, [
      "desktop-state",
      "agents",
      "services",
      "worktrees",
      "coordination-worklist",
      "inbox",
      "notifications",
      "tasks",
      "threads",
      "workflow",
    ])
  ) {
    work.push(host.refreshDashboardModelFromService?.(true));
  }
  if (host.isDashboardScreen?.("coordination") && touches(views, ["coordination-worklist", "inbox", "notifications", "tasks", "threads", "workflow"])) {
    work.push(host.refreshCoordinationFromService?.());
  }
  if (host.isDashboardScreen?.("project") && touches(views, ["project-observability", "tasks", "notifications", "worktrees", "agents", "services"])) {
    work.push(refreshProjectObservability(host));
  }
  if (host.isDashboardScreen?.("topology") && touches(views, ["topology", "agents", "services", "worktrees"])) {
    work.push(refreshTopology(host));
  }
  if (host.isDashboardScreen?.("library") && touches(views, ["library", "plans"])) {
    work.push(refreshLibrary(host));
  }
  if (host.isDashboardScreen?.("graveyard") && touches(views, ["graveyard", "agents", "worktrees"])) {
    work.push(refreshGraveyardEntriesFromService(host));
  }
  if (host.notificationPanelState && touches(views, ["notifications", "inbox", "coordination-worklist"])) {
    work.push(host.refreshNotificationPanelFromService?.());
  }
  await Promise.all(work.filter(Boolean));
  host.renderCurrentDashboardView?.();
}

function touches(views: Set<ProjectApiView>, candidates: ProjectApiView[]): boolean {
  return candidates.some((view) => views.has(view));
}

export function applyDashboardAlert(host: ProjectEventStreamHost, event: AlertEvent): void {
  if (event.kind === "notification") host.footerFlash = `◌ ${event.title}`;
  else if (event.kind === "needs_input") host.footerFlash = `◉ ${event.sessionId ?? "agent"} needs input`;
  else if (event.kind === "next_step") host.footerFlash = `◉ ${event.sessionId ?? "agent"} ready for next step`;
  else if (event.kind === "message_waiting") host.footerFlash = `✉ Message waiting → ${event.sessionId ?? "agent"}`;
  else if (event.kind === "handoff_waiting") host.footerFlash = `⇢ Handoff waiting → ${event.sessionId ?? "agent"}`;
  else if (event.kind === "task_assigned") host.footerFlash = `⧫ Task assigned → ${event.sessionId ?? "agent"}`;
  else if (event.kind === "review_waiting") host.footerFlash = `◌ Review waiting → ${event.sessionId ?? "agent"}`;
  else if (event.kind === "blocked") host.footerFlash = `⧗ ${event.title}`;
  else if (event.kind === "task_done") host.footerFlash = `✓ ${event.title}`;
  else if (event.kind === "task_failed") host.footerFlash = `✗ ${event.title}`;
  else return;
  host.footerFlashTicks = 4;
  host.renderCurrentDashboardView?.();
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
