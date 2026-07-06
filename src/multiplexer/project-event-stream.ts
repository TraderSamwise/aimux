import { TextDecoder } from "node:util";

import { debug } from "../debug.js";
import {
  PROJECT_API_EVENT_NAMES,
  PROJECT_API_ROUTES,
  PROJECT_API_VIEWS,
  type ProjectApiView,
  type ProjectUpdateEvent,
} from "../project-api-contract.js";
import type { AlertEvent } from "../project-events.js";
import { refreshGraveyardEntriesFromService } from "./archives.js";
import {
  invalidateDashboardProjectServiceEndpointHealth,
  resolveCurrentProjectServiceEndpointForDashboard,
} from "./dashboard-control.js";
import {
  captureDashboardLifecycle,
  isDashboardLifecycleCurrent,
  type DashboardLifecycleToken,
} from "./dashboard-lifecycle.js";
import { refreshDashboardModelThroughApi, type DashboardModelRefreshOutcome } from "./dashboard-api-client.js";
import { refreshLibrary } from "./library.js";
import { refreshProjectObservability } from "./project.js";
import { refreshTopology } from "./topology.js";

type ProjectEventStreamHost = any;

export const PROJECT_EVENT_STREAM_CONNECT_TIMEOUT_MS = 5_000;
export const PROJECT_EVENT_STREAM_IDLE_TIMEOUT_MS = 35_000;
export const PROJECT_EVENT_STREAM_RETRY_BASE_MS = 1_000;
export const PROJECT_EVENT_STREAM_RETRY_MAX_MS = 15_000;

class DashboardProjectEventAdapter {
  private controller: AbortController | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingViews: Set<ProjectApiView> | null = null;
  private refreshInFlightGeneration: number | null = null;
  private generation = 0;
  private disposed = false;

  constructor(private readonly host: ProjectEventStreamHost) {}

  start(): void {
    this.stop();
    this.disposed = false;
    this.generation += 1;
    const controller = new AbortController();
    this.controller = controller;
    void this.runLoop(controller.signal).catch((error) => {
      if (!controller.signal.aborted) {
        debug(
          `dashboard project event stream stopped: ${error instanceof Error ? error.message : String(error)}`,
          "dashboard",
        );
      }
    });
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.generation += 1;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.pendingViews = null;
    this.refreshInFlightGeneration = null;
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  handleEvent(name: string, payload: unknown): void {
    if (this.disposed) return;
    if (!payload || typeof payload !== "object") return;
    if (name === PROJECT_API_EVENT_NAMES.ready) {
      this.scheduleViewRefresh(PROJECT_API_VIEWS);
      return;
    }
    if (name === PROJECT_API_EVENT_NAMES.projectUpdate) {
      const event = payload as ProjectUpdateEvent;
      if (Array.isArray(event.views)) {
        this.scheduleViewRefresh(event.views);
      }
      return;
    }
    if (name === PROJECT_API_EVENT_NAMES.alert) {
      applyDashboardAlert(this.host, payload as AlertEvent);
    }
  }

  scheduleViewRefresh(views: readonly ProjectApiView[]): void {
    if (this.disposed) return;
    const pending = this.pendingViews ?? new Set<ProjectApiView>();
    for (const view of views) pending.add(view);
    this.pendingViews = pending;
    if (this.refreshTimer || this.refreshInFlightGeneration !== null) return;
    this.armRefreshTimer();
  }

  private armRefreshTimer(): void {
    const generation = this.generation;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (generation !== this.generation) return;
      if (this.host.mode !== "dashboard") {
        this.pendingViews = null;
        return;
      }
      const current = this.pendingViews;
      this.pendingViews = null;
      if (current) void this.runRefresh(current, generation);
    }, 25);
  }

  private async runRefresh(views: Set<ProjectApiView>, generation: number): Promise<void> {
    if (generation !== this.generation || this.refreshInFlightGeneration !== null) return;
    this.refreshInFlightGeneration = generation;
    try {
      await this.refreshViews(views, generation);
    } catch (error) {
      debug(
        `dashboard project event refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        "dashboard",
      );
    } finally {
      if (this.refreshInFlightGeneration === generation) this.refreshInFlightGeneration = null;
      if (
        generation === this.generation &&
        !this.disposed &&
        this.host.mode === "dashboard" &&
        this.pendingViews &&
        !this.refreshTimer
      ) {
        this.armRefreshTimer();
      }
    }
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let retryAttempt = 0;
    while (!signal.aborted && this.host.mode === "dashboard") {
      let endpoint: Awaited<ReturnType<typeof resolveCurrentProjectServiceEndpointForDashboard>>;
      try {
        endpoint = await resolveCurrentProjectServiceEndpointForDashboard(this.host, 1000);
      } catch (error) {
        if (signal.aborted || this.host.mode !== "dashboard") return;
        debug(
          `dashboard project event endpoint resolution failed: ${error instanceof Error ? error.message : String(error)}`,
          "dashboard",
        );
        await sleep(projectEventStreamRetryMs(retryAttempt++), signal);
        continue;
      }
      if (signal.aborted || this.host.mode !== "dashboard") return;
      if (!endpoint) {
        await sleep(projectEventStreamRetryMs(retryAttempt++), signal);
        continue;
      }
      const url = `http://${endpoint.host}:${endpoint.port}${PROJECT_API_ROUTES.events}`;
      const attemptController = new AbortController();
      const abortAttempt = () => attemptController.abort(signal.reason);
      const connectTimer = setTimeout(() => {
        attemptController.abort(
          new Error(`event stream connect timed out after ${PROJECT_EVENT_STREAM_CONNECT_TIMEOUT_MS}ms`),
        );
      }, PROJECT_EVENT_STREAM_CONNECT_TIMEOUT_MS);
      signal.addEventListener("abort", abortAttempt, { once: true });
      try {
        const response = await fetch(url, {
          headers: { accept: "text/event-stream" },
          signal: attemptController.signal,
        });
        clearTimeout(connectTimer);
        if (!response.ok || !response.body) {
          throw new Error(`event stream request failed: ${response.status}`);
        }
        retryAttempt = 0;
        const generation = this.generation;
        await readEventStream(response.body, attemptController.signal, (name, payload) => {
          if (generation === this.generation) this.handleEvent(name, payload);
        });
        if (!signal.aborted && this.host.mode === "dashboard") {
          debug("dashboard project event stream closed; reconnecting", "dashboard");
          await sleep(projectEventStreamRetryMs(retryAttempt++), signal);
        }
      } catch (error) {
        if (signal.aborted || this.host.mode !== "dashboard") return;
        debug(
          `dashboard project event stream reconnecting: ${error instanceof Error ? error.message : String(error)}`,
          "dashboard",
        );
        invalidateDashboardProjectServiceEndpointHealth(this.host);
        await this.recover(signal);
        await sleep(projectEventStreamRetryMs(retryAttempt++), signal);
      } finally {
        clearTimeout(connectTimer);
        signal.removeEventListener("abort", abortAttempt);
        attemptController.abort();
      }
    }
  }

  private async recover(signal: AbortSignal): Promise<void> {
    try {
      if (!signal.aborted && this.host.mode === "dashboard") this.scheduleViewRefresh(PROJECT_API_VIEWS);
    } catch (error) {
      debug(
        `dashboard project event recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        "dashboard",
      );
    }
  }

  private async refreshViews(views: Set<ProjectApiView>, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const dashboardLifecycle = captureDashboardLifecycle(this.host);
    if (!isDashboardLifecycleCurrent(this.host, dashboardLifecycle)) return;
    const work: Array<Promise<unknown>> = [];
    const renderLifecycles: DashboardLifecycleToken[] = [];
    if (
      touches(views, [
        "desktop-state",
        "agents",
        "services",
        "worktrees",
        "coordination-worklist",
        "notifications",
        "tasks",
        "threads",
      ])
    ) {
      renderLifecycles.push(dashboardLifecycle);
      work.push(refreshDashboardModelThroughApi(this.host, { force: true, lifecycle: dashboardLifecycle }));
    }
    if (
      this.host.isDashboardScreen?.("coordination") &&
      touches(views, ["coordination-worklist", "notifications", "tasks", "threads"])
    ) {
      const coordinationLifecycle = screenLifecycle("coordination");
      renderLifecycles.push(coordinationLifecycle);
      work.push(this.host.refreshCoordinationFromService?.({ force: true, lifecycle: coordinationLifecycle }));
    }
    if (
      this.host.isDashboardScreen?.("project") &&
      touches(views, ["project-observability", "tasks", "notifications", "worktrees", "agents", "services"])
    ) {
      const projectLifecycle = screenLifecycle("project");
      renderLifecycles.push(projectLifecycle);
      work.push(refreshProjectObservability(this.host, { force: true, lifecycle: projectLifecycle }));
    }
    if (this.host.isDashboardScreen?.("topology") && touches(views, ["topology", "agents", "services", "worktrees"])) {
      const topologyLifecycle = screenLifecycle("topology");
      renderLifecycles.push(topologyLifecycle);
      work.push(refreshTopology(this.host, { force: true, lifecycle: topologyLifecycle }));
    }
    if (this.host.isDashboardScreen?.("library") && touches(views, ["library"])) {
      const libraryLifecycle = screenLifecycle("library");
      renderLifecycles.push(libraryLifecycle);
      work.push(refreshLibrary(this.host, { force: true, lifecycle: libraryLifecycle }));
    }
    if (this.host.isDashboardScreen?.("graveyard") && touches(views, ["graveyard", "agents", "worktrees"])) {
      const graveyardLifecycle = screenLifecycle("graveyard");
      renderLifecycles.push(graveyardLifecycle);
      work.push(refreshGraveyardEntriesFromService(this.host, { force: true, lifecycle: graveyardLifecycle }));
    }
    const tasks = work.filter((task): task is Promise<unknown> => Boolean(task));
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") {
        debug(
          `dashboard project event view refresh failed: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
          "dashboard",
        );
      }
    }
    const appliedRefresh = results.some(
      (result) => result.status === "fulfilled" && didProjectEventRefreshApply(result.value),
    );
    if (tasks.length > 0 && !appliedRefresh) return;
    if (generation !== this.generation) return;
    if (!renderLifecycles.some((token) => isDashboardLifecycleCurrent(this.host, token))) return;
    this.host.renderCurrentDashboardView?.();
  }
}

function getOrCreateDashboardProjectEventAdapter(host: ProjectEventStreamHost): DashboardProjectEventAdapter {
  if (host.tuiProjectEventAdapter instanceof DashboardProjectEventAdapter) return host.tuiProjectEventAdapter;
  host.tuiProjectEventAdapter = new DashboardProjectEventAdapter(host);
  return host.tuiProjectEventAdapter;
}

export function startDashboardProjectEventStream(host: ProjectEventStreamHost): void {
  getOrCreateDashboardProjectEventAdapter(host).start();
}

export function stopDashboardProjectEventStream(host: ProjectEventStreamHost): void {
  const adapter = host.tuiProjectEventAdapter;
  adapter?.dispose?.();
  host.tuiProjectEventAdapter = null;
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
      const { done, value } = await readEventStreamChunk(reader, signal);
      if (done) return;
      if (signal.aborted) return;
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

async function readEventStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return { done: true, value: undefined };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => settle(() => resolve({ done: true, value: undefined }));
    timer = setTimeout(() => {
      const error = new Error(`event stream idle timed out after ${PROJECT_EVENT_STREAM_IDLE_TIMEOUT_MS}ms`);
      void reader.cancel(error).catch(() => undefined);
      settle(() => reject(error));
    }, PROJECT_EVENT_STREAM_IDLE_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => settle(() => resolve(result)),
      (error) => settle(() => reject(error)),
    );
  });
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
        debug(
          `ignored malformed dashboard SSE payload: ${error instanceof Error ? error.message : String(error)}`,
          "dashboard",
        );
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
  getOrCreateDashboardProjectEventAdapter(host).handleEvent(name, payload);
}

export function scheduleProjectViewRefresh(host: ProjectEventStreamHost, views: readonly ProjectApiView[]): void {
  getOrCreateDashboardProjectEventAdapter(host).scheduleViewRefresh(views);
}

function screenLifecycle(screen: string): DashboardLifecycleToken {
  return { mode: "dashboard", screen };
}

function touches(views: Set<ProjectApiView>, candidates: ProjectApiView[]): boolean {
  return candidates.some((view) => views.has(view));
}

function isDashboardModelRefreshOutcome(value: unknown): value is DashboardModelRefreshOutcome {
  return value !== null && typeof value === "object" && "status" in value && "ok" in value;
}

function didProjectEventRefreshApply(value: unknown): boolean {
  if (isDashboardModelRefreshOutcome(value)) return value.ok;
  return value !== false;
}

function projectEventStreamRetryMs(attempt: number): number {
  return Math.min(PROJECT_EVENT_STREAM_RETRY_BASE_MS * 2 ** attempt, PROJECT_EVENT_STREAM_RETRY_MAX_MS);
}

export function applyDashboardAlert(host: ProjectEventStreamHost, event: AlertEvent): void {
  if (host.mode !== "dashboard") return;
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
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
