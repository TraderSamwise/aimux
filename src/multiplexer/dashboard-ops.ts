import { basename } from "node:path";

import { truncateAnsi, truncatePlain, wrapKeyValue, wrapText } from "../tui/render/text.js";
import {
  graveyardSessionWithFeedback as runGraveyardSessionWithFeedback,
  resumeOfflineSessionWithFeedback as runResumeOfflineSessionWithFeedback,
  stopSessionToOfflineWithFeedback as runStopSessionToOfflineWithFeedback,
  waitForSessionExit,
  waitForSessionStart,
} from "../dashboard/session-actions.js";
import type { DashboardService, DashboardSession } from "../dashboard/index.js";
import type { PendingServiceActionKind, PendingSessionActionKind } from "../pending-actions.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import { hasRuntimeEvidence, isAttachableDashboardSessionEntry } from "../dashboard/runtime-evidence.js";
import { isDashboardWindowName } from "../tmux/runtime-manager.js";
import type { LaunchOverride } from "../shell-args.js";
import { generateServiceId, serviceLabelForCommand } from "./services.js";
import {
  captureDashboardLifecycle,
  isDashboardLifecycleCurrent,
  renderDashboardIfCurrent,
  type DashboardLifecycleToken,
} from "./dashboard-lifecycle.js";
import { mutateDashboardApi, refreshDashboardModelThroughApi } from "./dashboard-api-client.js";
import { userFacingErrorLines } from "../error-display.js";
import { isHttpTimeoutError } from "../http-client.js";

type DashboardOpsHost = any;
type PendingSessionCreateAction = Extract<PendingSessionActionKind, "creating" | "forking">;
type DashboardSessionMutationPendingAction = Exclude<PendingSessionActionKind, "renaming">;
export type DashboardMutationResult = "settled" | "pending" | "failed";

const dashboardAgentRestoreQueues = new WeakMap<object, Promise<void>>();
const dashboardQueuedAgentRestores = new WeakMap<object, Set<string>>();
const DASHBOARD_MUTATION_SETTLE_INTERVAL_MS = 100;

function queuedAgentRestoresFor(host: object): Set<string> {
  let queued = dashboardQueuedAgentRestores.get(host);
  if (!queued) {
    queued = new Set();
    dashboardQueuedAgentRestores.set(host, queued);
  }
  return queued;
}

async function enqueueDashboardAgentRestore<T>(
  host: object,
  sessionId: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const queued = queuedAgentRestoresFor(host);
  if (queued.has(sessionId)) return undefined;
  queued.add(sessionId);
  const previous = dashboardAgentRestoreQueues.get(host) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  const tracked = current
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      queued.delete(sessionId);
      if (dashboardAgentRestoreQueues.get(host) === tracked) {
        dashboardAgentRestoreQueues.delete(host);
      }
    });
  dashboardAgentRestoreQueues.set(host, tracked);
  return current;
}

function buildPendingSessionSeed(input: {
  sessionId: string;
  tool: string;
  worktreePath?: string;
  pendingAction: PendingSessionCreateAction;
}): DashboardSession {
  return {
    index: -1,
    id: input.sessionId,
    command: input.tool,
    label: input.tool,
    createdAt: new Date().toISOString(),
    status: "waiting",
    active: false,
    worktreePath: input.worktreePath,
    pendingAction: input.pendingAction,
    optimistic: true,
  };
}

interface DashboardSessionMutationOptions {
  sessionId: string;
  pendingAction: DashboardSessionMutationPendingAction;
  sessionSeed?: DashboardSession;
  request: () => Promise<void>;
  settle: (modelLifecycle: DashboardLifecycleToken, renderLifecycle: DashboardLifecycleToken) => Promise<boolean>;
  lifecycle?: DashboardLifecycleToken;
  onBeforeRequest?: () => void;
  onAfterRequest?: () => void;
  onAfterSettle?: () => void;
  onError?: (lifecycle: DashboardLifecycleToken) => Promise<void> | void;
  successFlash?: { message: string; ticks?: number };
  reconcileOnRequestTimeout?: boolean;
  errorTitle: string;
}

interface DashboardServiceMutationOptions {
  serviceId: string;
  pendingAction: PendingServiceActionKind;
  serviceSeed?: any;
  request: () => Promise<void>;
  settle: (modelLifecycle: DashboardLifecycleToken, renderLifecycle: DashboardLifecycleToken) => Promise<boolean>;
  onBeforeRequest?: () => void;
  onAfterRequest?: () => void;
  onAfterSettle?: () => void;
  onError?: (lifecycle: DashboardLifecycleToken) => Promise<void> | void;
  successFlash?: { message: string; ticks?: number };
  reconcileOnRequestTimeout?: boolean;
  errorTitle: string;
}

interface DashboardMutationReconcileOptions {
  targetKind: "session" | "service";
  targetId: string;
  pendingAction: PendingSessionActionKind | PendingServiceActionKind;
  settle: (modelLifecycle: DashboardLifecycleToken, renderLifecycle: DashboardLifecycleToken) => Promise<boolean>;
  modelLifecycle: DashboardLifecycleToken;
  renderLifecycle: DashboardLifecycleToken;
  clearPending: () => void;
  onAfterSettle?: () => void;
  onError?: (lifecycle: DashboardLifecycleToken) => Promise<void> | void;
  successFlash?: { message: string; ticks?: number };
  errorTitle: string;
}

interface DashboardMutationRequestOptions extends DashboardMutationReconcileOptions {
  request: () => Promise<void>;
  onAfterRequest?: () => void;
}

function restoreWarningLines(result: any): string[] {
  const warning = typeof result?.warning === "string" ? result.warning.trim() : "";
  const failures = Array.isArray(result?.teammateFailures)
    ? result.teammateFailures
        .map((failure: any) => {
          const sessionId = typeof failure?.sessionId === "string" ? failure.sessionId : "";
          const message =
            typeof failure?.error === "string"
              ? failure.error.trim()
              : typeof failure?.message === "string"
                ? failure.message.trim()
                : "";
          if (!sessionId || !message) return "";
          return message.includes(sessionId) ? message : `${sessionId}: ${message}`;
        })
        .filter((line: string) => line.trim().length > 0)
    : [];

  if (failures.length > 0) return Array.from(new Set(failures));
  if (!warning) return [];
  return Array.from(new Set([warning, "Stale teammates remain offline; create a new team to replace them."]));
}

async function refreshDashboardModelAfterMutationError(
  host: DashboardOpsHost,
  lifecycle?: DashboardLifecycleToken,
): Promise<void> {
  await refreshDashboardModelThroughApi(host, { force: true, lifecycle });
}

async function refreshDashboardModelForSettlement(
  host: DashboardOpsHost,
  lifecycle?: DashboardLifecycleToken,
): Promise<boolean> {
  return (await refreshDashboardModelThroughApi(host, { force: true, lifecycle })).ok;
}

function hasDashboardModelServiceRefreshError(host: DashboardOpsHost): boolean {
  return Boolean(host.dashboardModelServiceRefreshError);
}

function hasPendingDashboardSessionAction(
  host: DashboardOpsHost,
  sessionId: string,
  kind: PendingSessionActionKind,
): boolean {
  return host.dashboardPendingActions?.getSessionAction?.(sessionId) === kind;
}

function hasPendingDashboardServiceAction(
  host: DashboardOpsHost,
  serviceId: string,
  kind: PendingServiceActionKind,
): boolean {
  return host.dashboardPendingActions?.getServiceAction?.(serviceId) === kind;
}

function hasPendingDashboardMutationAction(host: DashboardOpsHost, opts: DashboardMutationReconcileOptions): boolean {
  return opts.targetKind === "session"
    ? hasPendingDashboardSessionAction(host, opts.targetId, opts.pendingAction as PendingSessionActionKind)
    : hasPendingDashboardServiceAction(host, opts.targetId, opts.pendingAction as PendingServiceActionKind);
}

function applyDashboardMutationSuccess(host: DashboardOpsHost, opts: DashboardMutationReconcileOptions): void {
  opts.clearPending();
  if (!isDashboardLifecycleCurrent(host, opts.renderLifecycle)) return;
  opts.onAfterSettle?.();
  if (opts.successFlash) {
    host.footerFlash = opts.successFlash.message;
    host.footerFlashTicks = opts.successFlash.ticks ?? 3;
  }
  renderDashboardMutationFrame(host, opts.renderLifecycle);
}

function scheduleDashboardMutationReconcile(host: DashboardOpsHost, opts: DashboardMutationReconcileOptions): void {
  const startedAt = Date.now();
  const maxReconcileMs = 60_000;
  if (isDashboardLifecycleCurrent(host, opts.renderLifecycle)) {
    host.footerFlash = `${opts.pendingAction} is still settling`;
    host.footerFlashTicks = 4;
    renderDashboardMutationFrame(host, opts.renderLifecycle);
  }
  void (async () => {
    while (Date.now() - startedAt < maxReconcileMs && hasPendingDashboardMutationAction(host, opts)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!(await opts.settle(opts.modelLifecycle, opts.renderLifecycle))) continue;
      applyDashboardMutationSuccess(host, opts);
      return;
    }
    if (!hasPendingDashboardMutationAction(host, opts)) return;
    opts.clearPending();
    await opts.onError?.(opts.modelLifecycle);
    if (!isDashboardLifecycleCurrent(host, opts.renderLifecycle)) return;
    host.showDashboardError(opts.errorTitle, [
      `${opts.pendingAction} is still not reflected by the project service after extended reconciliation`,
      "Run aimux restart if it does not recover automatically.",
    ]);
  })().catch((error: unknown) => {
    opts.clearPending();
    if (!isDashboardLifecycleCurrent(host, opts.renderLifecycle)) return;
    host.showDashboardError(opts.errorTitle, userFacingErrorLines(error));
  });
}

async function runDashboardMutationRequestUntilSettled(
  host: DashboardOpsHost,
  opts: DashboardMutationRequestOptions,
): Promise<"request" | "settled" | "inactive"> {
  let requestDone = false;
  let requestError: unknown;
  const requestDonePromise = Promise.resolve()
    .then(opts.request)
    .then(
      () => {
        requestDone = true;
        if (isDashboardLifecycleCurrent(host, opts.renderLifecycle) && !hasPendingDashboardMutationAction(host, opts)) {
          opts.onAfterRequest?.();
        }
      },
      (error: unknown) => {
        requestDone = true;
        requestError = error;
      },
    );

  while (!requestDone) {
    await Promise.race([
      requestDonePromise,
      new Promise((resolve) => setTimeout(resolve, DASHBOARD_MUTATION_SETTLE_INTERVAL_MS)),
    ]);
    if (requestDone) break;
    if (!isDashboardLifecycleCurrent(host, opts.renderLifecycle)) {
      opts.clearPending();
      return "inactive";
    }
    if (!(await opts.settle(opts.modelLifecycle, opts.renderLifecycle))) continue;
    applyDashboardMutationSuccess(host, opts);
    return "settled";
  }

  if (requestError) throw requestError;
  return "request";
}

async function waitForStableDashboardSessionAbsence(
  host: DashboardOpsHost,
  sessionId: string,
  timeoutMs = 10_000,
  stableMs = 350,
  modelLifecycle?: DashboardLifecycleToken,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let missingSince: number | null = null;
  while (Date.now() < deadline) {
    const refreshed = await refreshDashboardModelForSettlement(host, modelLifecycle);
    if (!refreshed && hasDashboardModelServiceRefreshError(host)) return false;
    const session = getRawDashboardSessionEntry(host, sessionId);
    if (session) {
      missingSince = null;
    } else if (refreshed || missingSince !== null) {
      missingSince ??= Date.now();
      if (Date.now() - missingSince >= stableMs) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function getDashboardSessionEntry(host: DashboardOpsHost, sessionId: string): any | undefined {
  return host.getDashboardSessions?.().find((candidate: any) => candidate.id === sessionId);
}

function getRawDashboardSessionEntry(host: DashboardOpsHost, sessionId: string): any | undefined {
  const sessions = Array.isArray(host.dashboardRawSessionsCache)
    ? host.dashboardRawSessionsCache
    : host.getDashboardSessions?.();
  return sessions?.find((candidate: any) => candidate.id === sessionId);
}

function getDashboardSessionSettlementEntry(
  host: DashboardOpsHost,
  sessionId: string,
): { known: boolean; session?: any } {
  const sessions = Array.isArray(host.dashboardRawSessionsCache) ? host.dashboardRawSessionsCache : undefined;
  if (sessions) return { known: true, session: sessions.find((entry: any) => entry.id === sessionId) };
  const session = getDashboardSessionEntry(host, sessionId);
  if (session?.optimistic || session?.pendingAction) return { known: false };
  return { known: true, session };
}

function isLiveDashboardSessionEntry(entry: any | undefined): boolean {
  return Boolean(
    entry &&
    entry.status !== "offline" &&
    entry.status !== "exited" &&
    (entry.status === "running" || isAttachableDashboardSessionEntry(entry) || hasRuntimeEvidence(entry)),
  );
}

function renderDashboardDuringSettlement(host: DashboardOpsHost, lifecycle: DashboardLifecycleToken | undefined): void {
  if (typeof host.renderDashboard !== "function") return;
  renderDashboardMutationFrame(host, lifecycle);
}

function renderDashboardMutationFrame(host: DashboardOpsHost, lifecycle?: DashboardLifecycleToken): void {
  const renderDashboard = host.renderDashboard;
  if (typeof renderDashboard !== "function") return;
  const render = () => {
    host.reconcileDashboardRenderState?.();
    renderDashboard.call(host);
  };
  if (lifecycle) {
    renderDashboardIfCurrent(host, lifecycle, render);
    return;
  }
  render();
}

function hasLiveManagedAgentWindow(host: DashboardOpsHost, sessionId: string): boolean {
  try {
    if (!host.tmuxRuntimeManager?.listProjectManagedWindows) return false;
    const configuredProjectRoot = typeof host.projectRoot === "string" ? host.projectRoot.trim() : "";
    const projectRoot = configuredProjectRoot || process.cwd();
    return host.tmuxRuntimeManager.listProjectManagedWindows(projectRoot).some(({ target, metadata }: any) => {
      if (isDashboardWindowName(target.windowName)) return false;
      if (metadata.kind !== "agent" || metadata.sessionId !== sessionId) return false;
      if (host.tmuxRuntimeManager.isWindowAlive && !host.tmuxRuntimeManager.isWindowAlive(target)) return false;
      return true;
    });
  } catch {
    return false;
  }
}

function isDashboardSessionResumeSettled(host: DashboardOpsHost, sessionId: string): boolean {
  const settlement = getDashboardSessionSettlementEntry(host, sessionId);
  const hasRawSnapshot = Array.isArray(host.dashboardRawSessionsCache);
  if (hasRawSnapshot) return settlement.known && isLiveDashboardSessionEntry(settlement.session);
  return (
    (settlement.known && isLiveDashboardSessionEntry(settlement.session)) || hasLiveManagedAgentWindow(host, sessionId)
  );
}

function isDashboardSessionStopSettled(host: DashboardOpsHost, sessionId: string): boolean {
  const hasLiveWindow = hasLiveManagedAgentWindow(host, sessionId);
  const { known, session: entry } = getDashboardSessionSettlementEntry(host, sessionId);
  if (!known) return false;
  if (!entry) return !hasLiveWindow;
  return !hasLiveWindow && entry.status !== "running";
}

async function waitForDashboardSessionResumeSettle(
  host: DashboardOpsHost,
  sessionId: string,
  timeoutMs = 10_000,
  modelLifecycle?: DashboardLifecycleToken,
  renderLifecycle?: DashboardLifecycleToken,
  opts?: { allowInactiveSettle?: () => boolean },
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let hasFreshSnapshot = false;
  let inactiveSince: number | null = null;
  while (Date.now() < deadline) {
    const refreshed = await refreshDashboardModelForSettlement(host, modelLifecycle);
    hasFreshSnapshot ||= refreshed;
    const renderedEntry = getDashboardSessionEntry(host, sessionId);
    const settlement = getDashboardSessionSettlementEntry(host, sessionId);
    const hasRawSnapshot = Array.isArray(host.dashboardRawSessionsCache);
    if ((hasFreshSnapshot || !hasRawSnapshot) && settlement.known && isLiveDashboardSessionEntry(settlement.session)) {
      renderDashboardDuringSettlement(host, renderLifecycle);
      return true;
    }
    if (isAttachableDashboardSessionEntry(renderedEntry) || hasLiveManagedAgentWindow(host, sessionId)) {
      renderDashboardDuringSettlement(host, renderLifecycle);
    }
    if (
      opts?.allowInactiveSettle?.() &&
      (hasFreshSnapshot || !hasRawSnapshot) &&
      isDashboardSessionRestoreInactive(host, sessionId)
    ) {
      inactiveSince ??= Date.now();
      if (Date.now() - inactiveSince >= 350) return true;
    } else {
      inactiveSince = null;
    }
    if (
      typeof host.waitForSessionStart === "function" &&
      (await host.waitForSessionStart(sessionId, Math.min(100, Math.max(0, deadline - Date.now()))))
    ) {
      await refreshDashboardModelForSettlement(host, modelLifecycle);
      renderDashboardDuringSettlement(host, renderLifecycle);
      if (isDashboardSessionResumeSettled(host, sessionId)) return true;
    }
    if (hasDashboardModelServiceRefreshError(host) && !hasPendingDashboardSessionAction(host, sessionId, "starting")) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return (
    isDashboardSessionResumeSettled(host, sessionId) ||
    Boolean(opts?.allowInactiveSettle?.() && isDashboardSessionRestoreInactive(host, sessionId))
  );
}

function isDashboardSessionRestoreInactive(host: DashboardOpsHost, sessionId: string): boolean {
  if (hasLiveManagedAgentWindow(host, sessionId)) return false;
  const { known, session } = getDashboardSessionSettlementEntry(host, sessionId);
  if (!known) return false;
  if (!session) return true;
  if (session.pendingAction || session.optimistic) return false;
  return !isLiveDashboardSessionEntry(session);
}

function isDashboardSessionRestored(host: DashboardOpsHost, sessionId: string): boolean {
  return isDashboardSessionResumeSettled(host, sessionId);
}

async function waitForDashboardSessionStopSettle(
  host: DashboardOpsHost,
  sessionId: string,
  timeoutMs = 10_000,
  modelLifecycle?: DashboardLifecycleToken,
  renderLifecycle?: DashboardLifecycleToken,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await refreshDashboardModelForSettlement(host, modelLifecycle);
    const entry = getDashboardSessionEntry(host, sessionId);
    if (isDashboardSessionStopSettled(host, sessionId)) return true;
    if (entry?.pendingAction === "stopping") {
      renderDashboardDuringSettlement(host, renderLifecycle);
    }
    if (hasDashboardModelServiceRefreshError(host) && !hasPendingDashboardSessionAction(host, sessionId, "stopping")) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return isDashboardSessionStopSettled(host, sessionId);
}

function isLiveDashboardServiceEntry(entry: any | undefined): boolean {
  return Boolean(entry && entry.status === "running");
}

function getDashboardServiceEntry(host: DashboardOpsHost, serviceId: string): any | undefined {
  return host.getDashboardServices?.().find((entry: any) => entry.id === serviceId);
}

function getRawDashboardServiceEntry(host: DashboardOpsHost, serviceId: string): any | undefined {
  const services = Array.isArray(host.dashboardRawServicesCache)
    ? host.dashboardRawServicesCache
    : host.getDashboardServices?.();
  return services?.find((entry: any) => entry.id === serviceId);
}

function getDashboardServiceSettlementEntry(
  host: DashboardOpsHost,
  serviceId: string,
): { known: boolean; service?: any } {
  const services = Array.isArray(host.dashboardRawServicesCache) ? host.dashboardRawServicesCache : undefined;
  if (services) return { known: true, service: services.find((entry: any) => entry.id === serviceId) };
  const service = getDashboardServiceEntry(host, serviceId);
  if (service?.optimistic || service?.pendingAction) return { known: false };
  return { known: true, service };
}

async function waitForRenderedDashboardServiceState(
  host: DashboardOpsHost,
  serviceId: string,
  predicate: (service: any | undefined) => boolean,
  timeoutMs = 10_000,
  modelLifecycle?: DashboardLifecycleToken,
  renderLifecycle?: DashboardLifecycleToken,
  pendingAction?: PendingServiceActionKind,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let hasFreshSnapshot = false;
  while (Date.now() < deadline) {
    const refreshed = await refreshDashboardModelForSettlement(host, modelLifecycle);
    hasFreshSnapshot ||= refreshed;
    const renderedService = getDashboardServiceEntry(host, serviceId);
    const settlement = getDashboardServiceSettlementEntry(host, serviceId);
    if (hasFreshSnapshot && settlement.known && predicate(settlement.service)) {
      if (
        isLiveDashboardServiceEntry(settlement.service) &&
        (renderedService?.status !== "running" || renderedService?.pendingAction === "starting")
      ) {
        renderDashboardDuringSettlement(host, renderLifecycle);
      }
      return true;
    }
    if (
      hasDashboardModelServiceRefreshError(host) &&
      (!pendingAction || !hasPendingDashboardServiceAction(host, serviceId, pendingAction))
    ) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const settlement = getDashboardServiceSettlementEntry(host, serviceId);
  return hasFreshSnapshot && settlement.known && predicate(settlement.service);
}

async function waitForDashboardServiceStopSettle(
  host: DashboardOpsHost,
  serviceId: string,
  timeoutMs = 10_000,
  modelLifecycle?: DashboardLifecycleToken,
): Promise<boolean> {
  return waitForRenderedDashboardServiceState(
    host,
    serviceId,
    (entry) => !entry || entry.status !== "running",
    timeoutMs,
    modelLifecycle,
    undefined,
    "stopping",
  );
}

async function waitForStableDashboardServiceAbsence(
  host: DashboardOpsHost,
  serviceId: string,
  timeoutMs = 10_000,
  stableMs = 350,
  modelLifecycle?: DashboardLifecycleToken,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let missingSince: number | null = null;
  while (Date.now() < deadline) {
    const refreshed = await refreshDashboardModelForSettlement(host, modelLifecycle);
    if (
      !refreshed &&
      hasDashboardModelServiceRefreshError(host) &&
      !hasPendingDashboardServiceAction(host, serviceId, "removing")
    ) {
      return false;
    }
    const service = getRawDashboardServiceEntry(host, serviceId);
    if (service) {
      missingSince = null;
    } else if (refreshed || missingSince !== null) {
      missingSince ??= Date.now();
      if (Date.now() - missingSince >= stableMs) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function runDashboardSessionMutation(
  host: DashboardOpsHost,
  opts: DashboardSessionMutationOptions,
): Promise<DashboardMutationResult> {
  const lifecycle = opts.lifecycle ?? captureDashboardLifecycle(host);
  const modelLifecycle = captureDashboardLifecycle(host);
  if (isDashboardLifecycleCurrent(host, lifecycle)) opts.onBeforeRequest?.();
  const token = host.setPendingDashboardSessionAction(opts.sessionId, opts.pendingAction, {
    sessionSeed: opts.sessionSeed,
  });
  renderDashboardMutationFrame(host, lifecycle);
  const clearPending = () => {
    if (typeof token === "number") {
      if (host.dashboardPendingActions?.clearSessionActionIfToken?.(opts.sessionId, token)) {
        host.reapplyDashboardPendingActions?.();
      }
    } else {
      host.setPendingDashboardSessionAction(opts.sessionId, null);
    }
  };
  const reconcileOptions = {
    targetKind: "session" as const,
    targetId: opts.sessionId,
    pendingAction: opts.pendingAction,
    request: opts.request,
    settle: opts.settle,
    modelLifecycle,
    renderLifecycle: lifecycle,
    clearPending,
    onAfterRequest: opts.onAfterRequest,
    onAfterSettle: opts.onAfterSettle,
    onError: opts.onError,
    successFlash: opts.successFlash,
    errorTitle: opts.errorTitle,
  };
  try {
    const requestState = await runDashboardMutationRequestUntilSettled(host, reconcileOptions);
    if (requestState === "settled") return "settled";
    if (requestState === "inactive" || !isDashboardLifecycleCurrent(host, lifecycle)) {
      clearPending();
      return "failed";
    }
    if (await opts.settle(modelLifecycle, lifecycle)) {
      applyDashboardMutationSuccess(host, reconcileOptions);
      return "settled";
    }
    scheduleDashboardMutationReconcile(host, reconcileOptions);
    return "pending";
  } catch (error) {
    if (opts.reconcileOnRequestTimeout && isHttpTimeoutError(error)) {
      scheduleDashboardMutationReconcile(host, reconcileOptions);
      return "pending";
    }
    clearPending();
    await opts.onError?.(modelLifecycle);
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return "failed";
    host.showDashboardError(opts.errorTitle, userFacingErrorLines(error));
    return "failed";
  }
}

async function runDashboardServiceMutation(
  host: DashboardOpsHost,
  opts: DashboardServiceMutationOptions,
): Promise<DashboardMutationResult> {
  const lifecycle = captureDashboardLifecycle(host);
  const modelLifecycle = captureDashboardLifecycle(host);
  if (isDashboardLifecycleCurrent(host, lifecycle)) opts.onBeforeRequest?.();
  const token = host.setPendingDashboardServiceAction(opts.serviceId, opts.pendingAction, {
    serviceSeed: opts.serviceSeed,
  });
  renderDashboardMutationFrame(host, lifecycle);
  const clearPending = () => {
    if (typeof token === "number") {
      if (host.dashboardPendingActions?.clearServiceActionIfToken?.(opts.serviceId, token)) {
        host.reapplyDashboardPendingActions?.();
      }
    } else {
      host.setPendingDashboardServiceAction(opts.serviceId, null);
    }
  };
  const reconcileOptions = {
    targetKind: "service" as const,
    targetId: opts.serviceId,
    pendingAction: opts.pendingAction,
    request: opts.request,
    settle: opts.settle,
    modelLifecycle,
    renderLifecycle: lifecycle,
    clearPending,
    onAfterRequest: opts.onAfterRequest,
    onAfterSettle: opts.onAfterSettle,
    onError: opts.onError,
    successFlash: opts.successFlash,
    errorTitle: opts.errorTitle,
  };
  try {
    const requestState = await runDashboardMutationRequestUntilSettled(host, reconcileOptions);
    if (requestState === "settled") return "settled";
    if (requestState === "inactive" || !isDashboardLifecycleCurrent(host, lifecycle)) {
      clearPending();
      return "failed";
    }
    if (await opts.settle(modelLifecycle, lifecycle)) {
      applyDashboardMutationSuccess(host, reconcileOptions);
      return "settled";
    }
    scheduleDashboardMutationReconcile(host, reconcileOptions);
    return "pending";
  } catch (error) {
    if (opts.reconcileOnRequestTimeout && isHttpTimeoutError(error)) {
      scheduleDashboardMutationReconcile(host, reconcileOptions);
      return "pending";
    }
    clearPending();
    await opts.onError?.(modelLifecycle);
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return "failed";
    host.showDashboardError(opts.errorTitle, userFacingErrorLines(error));
    return "failed";
  }
}

export async function runDashboardOperation<T>(
  host: DashboardOpsHost,
  title: string,
  lines: string[],
  work: () => Promise<T> | T,
  errorTitle = title,
): Promise<T | undefined> {
  return host.dashboardFeedback.runOperation(title, lines, work, errorTitle);
}

export async function spawnDashboardAgentWithFeedback(
  host: DashboardOpsHost,
  input: {
    sessionId: string;
    tool: string;
    worktreePath?: string;
    launchOverride?: LaunchOverride;
    overseer?: boolean;
  },
): Promise<void> {
  const sessionSeed = buildPendingSessionSeed({
    sessionId: input.sessionId,
    tool: input.tool,
    worktreePath: input.worktreePath,
    pendingAction: "creating",
  });
  await runDashboardSessionMutation(host, {
    sessionId: input.sessionId,
    pendingAction: "creating",
    sessionSeed,
    onBeforeRequest: () => {
      host.preferDashboardEntrySelection("session", input.sessionId, input.worktreePath);
    },
    request: async () => {
      await mutateDashboardApi(
        host,
        PROJECT_API_ROUTES.agents.spawn,
        {
          tool: input.tool,
          sessionId: input.sessionId,
          worktreePath: input.worktreePath,
          launchOverride: input.launchOverride,
          overseer: input.overseer,
          open: false,
        },
        { timeoutMs: 10_000 },
      );
    },
    settle: (modelLifecycle, renderLifecycle) =>
      waitForDashboardSessionResumeSettle(host, input.sessionId, 10_000, modelLifecycle, renderLifecycle),
    reconcileOnRequestTimeout: true,
    onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
    errorTitle: `Failed to create ${input.tool} agent`,
  });
}

export async function forkDashboardAgentWithFeedback(
  host: DashboardOpsHost,
  input: {
    sourceSessionId: string;
    targetSessionId: string;
    tool: string;
    instruction?: string;
    worktreePath?: string;
    launchOverride?: LaunchOverride;
  },
): Promise<void> {
  const sessionSeed = buildPendingSessionSeed({
    sessionId: input.targetSessionId,
    tool: input.tool,
    worktreePath: input.worktreePath,
    pendingAction: "forking",
  });
  await runDashboardSessionMutation(host, {
    sessionId: input.targetSessionId,
    pendingAction: "forking",
    sessionSeed,
    onBeforeRequest: () => {
      host.preferDashboardEntrySelection("session", input.targetSessionId, input.worktreePath);
    },
    request: async () => {
      await mutateDashboardApi(
        host,
        PROJECT_API_ROUTES.agents.fork,
        {
          sourceSessionId: input.sourceSessionId,
          targetSessionId: input.targetSessionId,
          tool: input.tool,
          instruction: input.instruction,
          worktreePath: input.worktreePath,
          launchOverride: input.launchOverride,
          open: false,
        },
        { timeoutMs: 10_000 },
      );
    },
    settle: (modelLifecycle, renderLifecycle) =>
      waitForDashboardSessionResumeSettle(host, input.targetSessionId, 10_000, modelLifecycle, renderLifecycle),
    reconcileOnRequestTimeout: true,
    onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
    errorTitle: "Cannot fork session",
  });
}

export function setPendingDashboardSessionAction(
  host: DashboardOpsHost,
  sessionId: string,
  kind: PendingSessionActionKind | null,
  opts?: { sessionSeed?: DashboardSession },
): number | undefined {
  let token: number | undefined;
  if (kind) {
    token = host.dashboardPendingActions.setSessionAction(sessionId, kind, opts);
  } else {
    host.dashboardPendingActions.clearSessionAction(sessionId);
  }
  if (typeof host.reapplyDashboardPendingActions === "function") {
    host.reapplyDashboardPendingActions();
  }
  return token;
}

export function setPendingDashboardServiceAction(
  host: DashboardOpsHost,
  serviceId: string,
  kind: PendingServiceActionKind | null,
  opts?: { serviceSeed?: DashboardService },
): number | undefined {
  let token: number | undefined;
  if (kind) {
    token = host.dashboardPendingActions.setServiceAction(serviceId, kind, opts);
  } else {
    host.dashboardPendingActions.clearServiceAction(serviceId);
  }
  if (typeof host.reapplyDashboardPendingActions === "function") {
    host.reapplyDashboardPendingActions();
  }
  return token;
}

export async function stopSessionToOfflineWithFeedback(host: DashboardOpsHost, session: any): Promise<void> {
  if (host.mode === "dashboard") {
    const label = host.getSessionLabel(session.id) ?? session.label ?? session.command;
    const sessionSeed =
      host.getDashboardSessions?.().find((entry: any) => entry.id === session.id) ??
      ({
        index: -1,
        id: session.id,
        command: session.command,
        label,
        status: "running",
        active: false,
        worktreePath: session.worktreePath,
      } satisfies DashboardSession);
    await runDashboardSessionMutation(host, {
      sessionId: session.id,
      pendingAction: "stopping",
      sessionSeed,
      onBeforeRequest: () => {
        host.footerFlash = `Stopping ${label}`;
        host.footerFlashTicks = 3;
      },
      request: async () => {
        await mutateDashboardApi(
          host,
          PROJECT_API_ROUTES.agents.stop,
          { sessionId: session.id },
          { timeoutMs: 10_000 },
        );
      },
      settle: (modelLifecycle, renderLifecycle) =>
        waitForDashboardSessionStopSettle(host, session.id, 10_000, modelLifecycle, renderLifecycle),
      successFlash: { message: `Stopped ${label}` },
      reconcileOnRequestTimeout: true,
      onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
      errorTitle: `Failed to stop "${label}"`,
    });
    return;
  }
  await runStopSessionToOfflineWithFeedback(dashboardSessionActionDeps(host), session);
}

export function clearDashboardSubscreens(host: DashboardOpsHost): void {
  host.dashboardState.resetSubscreen();
}

export function renderSessionDetails(host: DashboardOpsHost, session: any, width: number, height: number): string[] {
  if (!session) return new Array(height).fill("");
  const lines: string[] = [];
  lines.push("\x1b[1mDetails\x1b[0m");
  lines.push(...wrapKeyValue("Agent", `${session.label ?? session.command} (${session.id})`, width));
  lines.push(...wrapKeyValue("Tool", session.command, width));
  if (session.worktreeName || session.worktreeBranch) {
    lines.push(
      ...wrapKeyValue(
        "Worktree",
        `${session.worktreeName ?? "main"}${session.worktreeBranch ? ` · ${session.worktreeBranch}` : ""}`,
        width,
      ),
    );
  }
  if (session.cwd) {
    lines.push(...wrapKeyValue("CWD", session.cwd, width));
  }
  if (session.prNumber || session.prTitle || session.prUrl) {
    const prHeader = [`PR${session.prNumber ? ` #${session.prNumber}` : ""}`];
    if (session.prTitle) prHeader.push(session.prTitle);
    lines.push(...wrapKeyValue("PR", prHeader.join(": "), width));
    if (session.prUrl) lines.push(...wrapKeyValue("URL", session.prUrl, width));
  }
  if (session.repoOwner || session.repoName) {
    lines.push(...wrapKeyValue("Repo", `${session.repoOwner ?? "?"}/${session.repoName ?? "?"}`, width));
  }
  if (session.repoRemote) {
    lines.push(...wrapKeyValue("Remote", session.repoRemote, width));
  }
  if (session.semantic) {
    lines.push(...wrapKeyValue("State", session.semantic.presentation.statusLabel, width));
    if (session.semantic.user.attention !== "none") {
      lines.push(...wrapKeyValue("Attention", session.semantic.user.attention, width));
    }
    if (session.semantic.notifications.unreadCount > 0) {
      lines.push(...wrapKeyValue("Unread", String(session.semantic.notifications.unreadCount), width));
    }
    if (session.semantic.notifications.latestText) {
      lines.push(...wrapKeyValue("Latest", session.semantic.notifications.latestText, width));
    }
    if (session.semantic.activityNewCount > 0) {
      lines.push(...wrapKeyValue("New activity", String(session.semantic.activityNewCount), width));
    }
  }
  if (session.lastEvent?.message) {
    lines.push(...wrapKeyValue("Last", session.lastEvent.message, width));
  }
  if (session.threadName || session.threadId) {
    lines.push(...wrapKeyValue("Thread", session.threadName ?? session.threadId ?? "", width));
  }
  if (
    (session.threadUnreadCount ?? 0) > 0 ||
    (session.threadWaitingOnMeCount ?? 0) > 0 ||
    (session.threadWaitingOnThemCount ?? 0) > 0 ||
    (session.threadPendingCount ?? 0) > 0
  ) {
    lines.push(
      ...wrapKeyValue(
        "Threads",
        `${session.threadUnreadCount ?? 0} unread · ${session.threadWaitingOnMeCount ?? 0} on me · ${session.threadWaitingOnThemCount ?? 0} on them · ${session.threadPendingCount ?? 0} pending`,
        width,
      ),
    );
  }
  if ((session.services?.length ?? 0) > 0) {
    lines.push(...wrapKeyValue("Services", session.services.map((s: any) => s.url ?? `:${s.port}`).join(", "), width));
  }
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}

export function wrapKeyValueForHost(key: string, value: string, width: number): string[] {
  return wrapKeyValue(key, value, width);
}

export function wrapTextForHost(text: string, width: number): string[] {
  return wrapText(text, width);
}

export function truncatePlainForHost(text: string, max: number): string {
  return truncatePlain(text, max);
}

export function truncateAnsiForHost(text: string, max: number): string {
  return truncateAnsi(text, max);
}

export function basenameForHost(value: string): string {
  return basename(value);
}

export async function graveyardSessionWithFeedback(
  host: DashboardOpsHost,
  sessionId: string,
  hasWorktrees: boolean,
): Promise<void> {
  const dashboardEntry = host.getDashboardSessions?.().find((entry: any) => entry.id === sessionId);
  const session =
    host.offlineSessions.find((s: any) => s.id === sessionId) ??
    host.sessions.find((s: any) => s.id === sessionId) ??
    dashboardEntry;
  if (host.mode === "dashboard") {
    if (!session) return;
    const label = host.getSessionLabel(sessionId) ?? session.label ?? session.command;
    const sessionSeed = dashboardEntry ?? session;
    await runDashboardSessionMutation(host, {
      sessionId,
      pendingAction: "graveyarding",
      sessionSeed,
      request: async () => {
        await mutateDashboardApi(host, PROJECT_API_ROUTES.agents.kill, { sessionId }, { timeoutMs: 10_000 });
      },
      settle: (modelLifecycle) => waitForStableDashboardSessionAbsence(host, sessionId, 10_000, 350, modelLifecycle),
      onAfterSettle: () => host.adjustAfterRemove(hasWorktrees),
      successFlash: { message: `Sent ${label} to graveyard` },
      reconcileOnRequestTimeout: true,
      onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
      errorTitle: `Failed to graveyard "${label}"`,
    });
    return;
  }
  await runGraveyardSessionWithFeedback(dashboardSessionActionDeps(host), session, sessionId, hasWorktrees);
}

export async function resumeOfflineSessionWithFeedback(
  host: DashboardOpsHost,
  session: any,
): Promise<DashboardMutationResult> {
  if (host.mode === "dashboard") {
    const label = session.label ?? session.command;
    const lifecycle = captureDashboardLifecycle(host);
    if (
      host.dashboardPendingActions.getSessionAction(session.id) === "starting" ||
      queuedAgentRestoresFor(host).has(session.id)
    ) {
      return "pending";
    }
    const sessionSeed =
      host.getDashboardSessions?.().find((entry: any) => entry.id === session.id) ??
      ({
        index: -1,
        id: session.id,
        command: session.command,
        label,
        status: "offline",
        active: false,
        worktreePath: session.worktreePath,
        team: session.team,
      } satisfies DashboardSession);
    let resumeResult: any;
    host.footerFlash = `Queued restore ${label}`;
    host.footerFlashTicks = 3;
    host.setPendingDashboardSessionAction(session.id, "starting", { sessionSeed });
    host.renderDashboard();
    let restoreWarningsShown = false;
    const showRestoreWarnings = () => {
      if (restoreWarningsShown) return;
      const warningLines = restoreWarningLines(resumeResult);
      if (warningLines.length === 0) return;
      restoreWarningsShown = true;
      host.showDashboardError(`Restored "${label}" with teammate issues`, warningLines);
    };
    let resumeRequestSettled = false;
    const resumeStartedAt = Date.now();
    const applyRestoreSettlementFlash = () => {
      showRestoreWarnings();
      host.footerFlash = isDashboardSessionRestored(host, session.id) ? `Restored ${label}` : `${label} stayed offline`;
      host.footerFlashTicks = 3;
    };
    const mutationResult =
      (await enqueueDashboardAgentRestore(host, session.id, async () =>
        runDashboardSessionMutation(host, {
          sessionId: session.id,
          pendingAction: "starting",
          sessionSeed,
          lifecycle,
          onBeforeRequest: () => {
            host.footerFlash = `Restoring ${label}`;
            host.footerFlashTicks = 3;
          },
          request: async () => {
            try {
              resumeResult = await mutateDashboardApi(
                host,
                PROJECT_API_ROUTES.agents.resume,
                { sessionId: session.id },
                { timeoutMs: 60_000 },
              );
            } finally {
              resumeRequestSettled = true;
            }
          },
          settle: (modelLifecycle, renderLifecycle) =>
            waitForDashboardSessionResumeSettle(host, session.id, 10_000, modelLifecycle, renderLifecycle, {
              allowInactiveSettle: () => resumeRequestSettled || Date.now() - resumeStartedAt >= 5_000,
            }),
          onAfterRequest: showRestoreWarnings,
          onAfterSettle: applyRestoreSettlementFlash,
          reconcileOnRequestTimeout: true,
          onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
          errorTitle: `Failed to restore "${label}"`,
        }),
      )) ?? "pending";
    return mutationResult;
  }
  return runResumeOfflineSessionWithFeedback(dashboardSessionActionDeps(host), session);
}

export async function resumeOfflineServiceWithFeedback(
  host: DashboardOpsHost,
  service: { id: string; label?: string },
): Promise<DashboardMutationResult> {
  if (host.dashboardPendingActions.getServiceAction(service.id) === "starting") {
    return "pending";
  }
  if (host.mode === "dashboard") {
    const serviceSeed = host.getDashboardServices?.().find((entry: any) => entry.id === service.id) ?? {
      id: service.id,
      command: service.label ?? "service",
      args: [],
      status: "offline",
      active: false,
      label: service.label,
    };
    return runDashboardServiceMutation(host, {
      serviceId: service.id,
      pendingAction: "starting",
      serviceSeed,
      onBeforeRequest: () => {
        host.footerFlash = `Restoring ${service.label ?? service.id}`;
        host.footerFlashTicks = 3;
      },
      request: async () => {
        await mutateDashboardApi(
          host,
          PROJECT_API_ROUTES.services.resume,
          { serviceId: service.id },
          { timeoutMs: 10_000 },
        );
      },
      settle: (modelLifecycle, renderLifecycle) =>
        waitForRenderedDashboardServiceState(
          host,
          service.id,
          (entry) => isLiveDashboardServiceEntry(entry),
          10_000,
          modelLifecycle,
          renderLifecycle,
          "starting",
        ),
      successFlash: { message: `◆ Started service ${service.label ?? service.id}` },
      reconcileOnRequestTimeout: true,
      onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
      errorTitle: "Failed to start service",
    });
  }
  host.setPendingDashboardServiceAction(service.id, "starting");
  host.footerFlash = `Restoring ${service.label ?? service.id}`;
  host.footerFlashTicks = 3;
  host.renderDashboard();
  try {
    host.resumeOfflineServiceById(service.id);
    host.setPendingDashboardServiceAction(service.id, null);
    host.footerFlash = `◆ Started service ${service.label ?? service.id}`;
    host.footerFlashTicks = 3;
    host.renderDashboard();
    return "settled";
  } catch (error) {
    host.setPendingDashboardServiceAction(service.id, null);
    host.refreshLocalDashboardModel();
    host.showDashboardError("Failed to start service", [error instanceof Error ? error.message : String(error)]);
    return "failed";
  }
}

export async function createDashboardServiceWithFeedback(
  host: DashboardOpsHost,
  commandLine: string,
  worktreePath?: string,
): Promise<void> {
  const serviceId = generateServiceId();
  const trimmed = commandLine.trim();
  const label = serviceLabelForCommand(trimmed);
  const serviceSeed = {
    id: serviceId,
    command: trimmed ? process.env.SHELL || "shell" : "shell",
    args: trimmed ? ["-lc", trimmed] : ["-l"],
    createdAt: new Date().toISOString(),
    worktreePath,
    status: "running",
    active: false,
    label,
    optimistic: true,
  };
  await runDashboardServiceMutation(host, {
    serviceId,
    pendingAction: "creating",
    serviceSeed,
    onBeforeRequest: () => {
      host.preferDashboardEntrySelection?.("service", serviceId, worktreePath);
      host.footerFlash = `Creating service ${label}`;
      host.footerFlashTicks = 3;
    },
    request: async () => {
      await mutateDashboardApi(
        host,
        PROJECT_API_ROUTES.services.create,
        { serviceId, command: commandLine, worktreePath },
        { timeoutMs: 10_000 },
      );
    },
    settle: (modelLifecycle, renderLifecycle) =>
      waitForRenderedDashboardServiceState(
        host,
        serviceId,
        (entry) => isLiveDashboardServiceEntry(entry),
        10_000,
        modelLifecycle,
        renderLifecycle,
        "creating",
      ),
    successFlash: { message: `◆ Created service ${label}` },
    reconcileOnRequestTimeout: true,
    onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
    errorTitle: "Failed to create service",
  });
}

export async function stopDashboardServiceWithFeedback(
  host: DashboardOpsHost,
  service: { id: string; label?: string },
): Promise<void> {
  const serviceSeed = host.getDashboardServices?.().find((entry: any) => entry.id === service.id) ?? {
    id: service.id,
    command: service.label ?? "service",
    args: [],
    status: "running",
    active: false,
    label: service.label,
  };
  await runDashboardServiceMutation(host, {
    serviceId: service.id,
    pendingAction: "stopping",
    serviceSeed,
    onBeforeRequest: () => {
      host.footerFlash = `Stopping ${service.label ?? service.id}`;
      host.footerFlashTicks = 3;
    },
    request: async () => {
      await mutateDashboardApi(
        host,
        PROJECT_API_ROUTES.services.stop,
        { serviceId: service.id },
        { timeoutMs: 10_000 },
      );
    },
    settle: (modelLifecycle) => waitForDashboardServiceStopSettle(host, service.id, 10_000, modelLifecycle),
    successFlash: { message: `◆ Stopped service ${service.label ?? service.id}` },
    reconcileOnRequestTimeout: true,
    onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
    errorTitle: "Failed to stop service",
  });
}

export async function removeDashboardServiceWithFeedback(
  host: DashboardOpsHost,
  service: { id: string; label?: string },
): Promise<void> {
  await runDashboardServiceMutation(host, {
    serviceId: service.id,
    pendingAction: "removing",
    request: async () => {
      await mutateDashboardApi(
        host,
        PROJECT_API_ROUTES.services.remove,
        { serviceId: service.id },
        { timeoutMs: 10_000 },
      );
    },
    settle: (modelLifecycle) => waitForStableDashboardServiceAbsence(host, service.id, 10_000, 350, modelLifecycle),
    successFlash: { message: `◆ Deleted service ${service.label ?? service.id}` },
    reconcileOnRequestTimeout: true,
    onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
    errorTitle: "Failed to delete service",
  });
}

export async function waitForSessionStartForHost(
  host: DashboardOpsHost,
  sessionId: string,
  timeoutMs = 8000,
): Promise<boolean> {
  return waitForSessionStart(sessionId, dashboardSessionActionDeps(host), timeoutMs);
}

export function dashboardSessionActionDeps(host: DashboardOpsHost) {
  return {
    getSessionLabel: (sessionId: string) => host.getSessionLabel(sessionId),
    getPendingAction: (sessionId: string) => host.dashboardPendingActions.getSessionAction(sessionId),
    setPendingAction: (sessionId: string, kind: PendingSessionActionKind | null) =>
      setPendingDashboardSessionAction(host, sessionId, kind),
    stopSessionToOffline: (session: any) => host.stopAgent(session.id),
    isGraveyardAfterStop: (sessionId: string) => host.graveyardAfterStopSessionIds.has(sessionId),
    sendAgentToGraveyard: (sessionId: string) => host.sendAgentToGraveyard(sessionId).then(() => undefined),
    resumeOfflineSession: async (session: any) => {
      if (host.mode !== "dashboard") {
        host.resumeOfflineSession(session);
        return;
      }
      const result = await mutateDashboardApi(
        host,
        PROJECT_API_ROUTES.agents.resume,
        { sessionId: session.id },
        { timeoutMs: 10_000 },
      );
      const warningLines = restoreWarningLines(result);
      if (warningLines.length > 0) {
        throw new Error(warningLines.join("\n"));
      }
    },
    refreshLocalDashboardModel: () => host.refreshLocalDashboardModel(),
    adjustAfterRemove: (hasWorktrees: boolean) => host.adjustAfterRemove(hasWorktrees),
    renderDashboard: () => host.renderCurrentDashboardView(),
    showDashboardError: (title: string, lines: string[]) => host.showDashboardError(title, lines),
    setFooterFlash: (message: string, ticks: number) => {
      host.footerFlash = message;
      host.footerFlashTicks = ticks;
    },
    getRuntimeById: (sessionId: string) => host.sessions.find((session: any) => session.id === sessionId),
    isSessionRuntimeLive: (session: any) => host.isSessionRuntimeLive(session),
  };
}

export async function migrateSessionWithFeedback(
  host: DashboardOpsHost,
  session: any,
  targetPath: string,
  targetName: string,
): Promise<void> {
  const label = host.getSessionLabel(session.id) ?? session.command;
  if (host.mode !== "dashboard") {
    host.setPendingDashboardSessionAction(session.id, "migrating");
    try {
      await host.migrateAgent(session.id, targetPath);
      await waitForSessionExit(session);
      host.setPendingDashboardSessionAction(session.id, null);
      host.refreshLocalDashboardModel();
      host.footerFlash = `Migrated ${label} to ${targetName}`;
      host.footerFlashTicks = 3;
      host.renderDashboard();
    } catch (error) {
      host.setPendingDashboardSessionAction(session.id, null);
      host.showDashboardError(`Failed to migrate "${label}"`, [error instanceof Error ? error.message : String(error)]);
    }
    return;
  }
  const sessionSeed =
    host.getDashboardSessions?.().find((entry: any) => entry.id === session.id) ??
    ({
      index: -1,
      id: session.id,
      command: session.command,
      label,
      status: "running",
      active: false,
      worktreePath: session.worktreePath,
    } satisfies DashboardSession);
  await runDashboardSessionMutation(host, {
    sessionId: session.id,
    pendingAction: "migrating",
    sessionSeed,
    request: async () => {
      await mutateDashboardApi(
        host,
        PROJECT_API_ROUTES.agents.migrate,
        { sessionId: session.id, worktreePath: targetPath },
        { timeoutMs: 10_000 },
      );
    },
    settle: (modelLifecycle, renderLifecycle) =>
      waitForDashboardSessionResumeSettle(host, session.id, 10_000, modelLifecycle, renderLifecycle),
    successFlash: { message: `Migrated ${label} to ${targetName}` },
    reconcileOnRequestTimeout: true,
    onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
    errorTitle: `Failed to migrate "${label}"`,
  });
}
