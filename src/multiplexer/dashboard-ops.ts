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
import {
  isAttachableDashboardSessionEntry,
  isLiveDashboardServiceRuntimeEntry,
} from "../dashboard/runtime-evidence.js";
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

type DashboardOpsHost = any;
type PendingSessionCreateAction = Extract<PendingSessionActionKind, "creating" | "forking">;
type DashboardSessionMutationPendingAction = Exclude<PendingSessionActionKind, "renaming">;

const dashboardAgentRestoreQueues = new WeakMap<object, Promise<void>>();
const dashboardQueuedAgentRestores = new WeakMap<object, Set<string>>();

function queuedAgentRestoresFor(host: object): Set<string> {
  let queued = dashboardQueuedAgentRestores.get(host);
  if (!queued) {
    queued = new Set();
    dashboardQueuedAgentRestores.set(host, queued);
  }
  return queued;
}

async function enqueueDashboardAgentRestore(host: object, sessionId: string, work: () => Promise<void>): Promise<void> {
  const queued = queuedAgentRestoresFor(host);
  if (queued.has(sessionId)) return;
  queued.add(sessionId);
  const previous = dashboardAgentRestoreQueues.get(host) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(work)
    .finally(() => {
      queued.delete(sessionId);
      if (dashboardAgentRestoreQueues.get(host) === current) {
        dashboardAgentRestoreQueues.delete(host);
      }
    });
  dashboardAgentRestoreQueues.set(host, current);
  await current;
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
  onAfterSettle?: () => void;
  onError?: (lifecycle: DashboardLifecycleToken) => Promise<void> | void;
  successFlash?: { message: string; ticks?: number };
  errorTitle: string;
}

interface DashboardServiceMutationOptions {
  serviceId: string;
  pendingAction: PendingServiceActionKind;
  serviceSeed?: any;
  request: () => Promise<void>;
  settle: (modelLifecycle: DashboardLifecycleToken, renderLifecycle: DashboardLifecycleToken) => Promise<boolean>;
  onBeforeRequest?: () => void;
  onAfterSettle?: () => void;
  onError?: (lifecycle: DashboardLifecycleToken) => Promise<void> | void;
  successFlash?: { message: string; ticks?: number };
  errorTitle: string;
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

function assertDashboardMutationSettled(settled: boolean, action: string): void {
  if (!settled) {
    throw new Error(`${action} did not settle before timing out`);
  }
}

async function refreshDashboardModelAfterAuthoritativeMutation(
  host: DashboardOpsHost,
  lifecycle?: DashboardLifecycleToken,
): Promise<boolean> {
  return refreshDashboardModelThroughApi(host, { force: true, lifecycle });
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
  return refreshDashboardModelThroughApi(host, { force: true, lifecycle });
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
    if (!(await refreshDashboardModelForSettlement(host, modelLifecycle))) return false;
    const session = host.getDashboardSessions().find((entry: any) => entry.id === sessionId);
    if (session) {
      missingSince = null;
    } else {
      missingSince ??= Date.now();
      if (Date.now() - missingSince >= stableMs) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function isLiveDashboardSessionEntry(entry: any | undefined): boolean {
  return isAttachableDashboardSessionEntry(entry);
}

function renderDashboardDuringSettlement(host: DashboardOpsHost, lifecycle: DashboardLifecycleToken | undefined): void {
  if (typeof host.renderDashboard !== "function") return;
  if (lifecycle) {
    renderDashboardIfCurrent(host, lifecycle, () => host.renderDashboard());
    return;
  }
  host.renderDashboard();
}

function hasLiveManagedAgentWindow(host: DashboardOpsHost, sessionId: string): boolean {
  try {
    if (!host.tmuxRuntimeManager?.listProjectManagedWindows) return false;
    return host.tmuxRuntimeManager.listProjectManagedWindows(process.cwd()).some(({ target, metadata }: any) => {
      if (isDashboardWindowName(target.windowName)) return false;
      if (metadata.kind !== "agent" || metadata.sessionId !== sessionId) return false;
      if (host.tmuxRuntimeManager.isWindowAlive && !host.tmuxRuntimeManager.isWindowAlive(target)) return false;
      return true;
    });
  } catch {
    return false;
  }
}

async function waitForDashboardSessionResumeSettle(
  host: DashboardOpsHost,
  sessionId: string,
  timeoutMs = 10_000,
  modelLifecycle?: DashboardLifecycleToken,
  renderLifecycle?: DashboardLifecycleToken,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await refreshDashboardModelForSettlement(host, modelLifecycle))) return false;
    const entry = host.getDashboardSessions().find((candidate: any) => candidate.id === sessionId);
    if (isLiveDashboardSessionEntry(entry)) {
      if (entry?.status === "offline" || entry?.pendingAction === "starting") {
        renderDashboardDuringSettlement(host, renderLifecycle);
      }
      return true;
    }
    if (
      typeof host.waitForSessionStart === "function" &&
      (await host.waitForSessionStart(sessionId, Math.min(100, Math.max(0, deadline - Date.now()))))
    ) {
      if (!(await refreshDashboardModelForSettlement(host, modelLifecycle))) return false;
      renderDashboardDuringSettlement(host, renderLifecycle);
      const refreshedEntry = host.getDashboardSessions().find((candidate: any) => candidate.id === sessionId);
      if (isLiveDashboardSessionEntry(refreshedEntry)) return true;
    }
    if (hasLiveManagedAgentWindow(host, sessionId)) {
      if (!(await refreshDashboardModelForSettlement(host, modelLifecycle))) return false;
      renderDashboardDuringSettlement(host, renderLifecycle);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function isLiveDashboardServiceEntry(entry: any | undefined): boolean {
  return isLiveDashboardServiceRuntimeEntry(entry);
}

async function waitForRenderedDashboardServiceState(
  host: DashboardOpsHost,
  serviceId: string,
  predicate: (service: any | undefined) => boolean,
  timeoutMs = 10_000,
  modelLifecycle?: DashboardLifecycleToken,
  renderLifecycle?: DashboardLifecycleToken,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await refreshDashboardModelForSettlement(host, modelLifecycle))) return false;
    const service = host.getDashboardServices().find((entry: any) => entry.id === serviceId);
    if (predicate(service)) {
      if (
        isLiveDashboardServiceEntry(service) &&
        (service?.status !== "running" || service?.pendingAction === "starting")
      ) {
        renderDashboardDuringSettlement(host, renderLifecycle);
      }
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
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
    if (!(await refreshDashboardModelForSettlement(host, modelLifecycle))) return false;
    const service = host.getDashboardServices().find((entry: any) => entry.id === serviceId);
    if (service) {
      missingSince = null;
    } else {
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
): Promise<void> {
  const lifecycle = opts.lifecycle ?? captureDashboardLifecycle(host, { inputEpoch: true });
  const modelLifecycle = captureDashboardLifecycle(host);
  const token = host.setPendingDashboardSessionAction(opts.sessionId, opts.pendingAction, {
    sessionSeed: opts.sessionSeed,
  });
  if (isDashboardLifecycleCurrent(host, lifecycle)) opts.onBeforeRequest?.();
  renderDashboardIfCurrent(host, lifecycle, () => host.renderDashboard());
  const clearPending = () => {
    if (typeof token === "number") {
      if (host.dashboardPendingActions?.clearSessionActionIfToken?.(opts.sessionId, token)) {
        host.reapplyDashboardPendingActions?.();
      }
    } else {
      host.setPendingDashboardSessionAction(opts.sessionId, null);
    }
  };
  try {
    await opts.request();
    assertDashboardMutationSettled(await opts.settle(modelLifecycle, lifecycle), opts.pendingAction);
    clearPending();
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
    opts.onAfterSettle?.();
    if (opts.successFlash) {
      host.footerFlash = opts.successFlash.message;
      host.footerFlashTicks = opts.successFlash.ticks ?? 3;
    }
    host.renderDashboard();
  } catch (error) {
    clearPending();
    await opts.onError?.(modelLifecycle);
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
    host.showDashboardError(opts.errorTitle, [error instanceof Error ? error.message : String(error)]);
  }
}

async function runDashboardServiceMutation(
  host: DashboardOpsHost,
  opts: DashboardServiceMutationOptions,
): Promise<void> {
  const lifecycle = captureDashboardLifecycle(host, { inputEpoch: true });
  const modelLifecycle = captureDashboardLifecycle(host);
  const token = host.setPendingDashboardServiceAction(opts.serviceId, opts.pendingAction, {
    serviceSeed: opts.serviceSeed,
  });
  if (isDashboardLifecycleCurrent(host, lifecycle)) opts.onBeforeRequest?.();
  renderDashboardIfCurrent(host, lifecycle, () => host.renderDashboard());
  const clearPending = () => {
    if (typeof token === "number") {
      if (host.dashboardPendingActions?.clearServiceActionIfToken?.(opts.serviceId, token)) {
        host.reapplyDashboardPendingActions?.();
      }
    } else {
      host.setPendingDashboardServiceAction(opts.serviceId, null);
    }
  };
  try {
    await opts.request();
    assertDashboardMutationSettled(await opts.settle(modelLifecycle, lifecycle), opts.pendingAction);
    clearPending();
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
    opts.onAfterSettle?.();
    if (opts.successFlash) {
      host.footerFlash = opts.successFlash.message;
      host.footerFlashTicks = opts.successFlash.ticks ?? 3;
    }
    host.renderDashboard();
  } catch (error) {
    clearPending();
    await opts.onError?.(modelLifecycle);
    if (!isDashboardLifecycleCurrent(host, lifecycle)) return;
    host.showDashboardError(opts.errorTitle, [error instanceof Error ? error.message : String(error)]);
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
      settle: (modelLifecycle) => refreshDashboardModelAfterAuthoritativeMutation(host, modelLifecycle),
      successFlash: { message: `Stopped ${label}` },
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
      onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
      errorTitle: `Failed to graveyard "${label}"`,
    });
    return;
  }
  await runGraveyardSessionWithFeedback(dashboardSessionActionDeps(host), session, sessionId, hasWorktrees);
}

export async function resumeOfflineSessionWithFeedback(host: DashboardOpsHost, session: any): Promise<void> {
  if (host.mode === "dashboard") {
    const label = session.label ?? session.command;
    const lifecycle = captureDashboardLifecycle(host, { inputEpoch: true });
    if (
      host.dashboardPendingActions.getSessionAction(session.id) === "starting" ||
      queuedAgentRestoresFor(host).has(session.id)
    ) {
      return;
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
    await enqueueDashboardAgentRestore(host, session.id, async () => {
      await runDashboardSessionMutation(host, {
        sessionId: session.id,
        pendingAction: "starting",
        sessionSeed,
        lifecycle,
        onBeforeRequest: () => {
          host.footerFlash = `Restoring ${label}`;
          host.footerFlashTicks = 3;
        },
        request: async () => {
          resumeResult = await mutateDashboardApi(
            host,
            PROJECT_API_ROUTES.agents.resume,
            { sessionId: session.id },
            { timeoutMs: 60_000 },
          );
        },
        settle: (modelLifecycle, renderLifecycle) =>
          waitForDashboardSessionResumeSettle(host, session.id, 10_000, modelLifecycle, renderLifecycle),
        successFlash: { message: `Restored ${label}` },
        onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
        errorTitle: `Failed to restore "${label}"`,
      });
    });
    const warningLines = restoreWarningLines(resumeResult);
    if (warningLines.length > 0 && isDashboardLifecycleCurrent(host, lifecycle)) {
      host.showDashboardError(`Restored "${label}" with teammate issues`, warningLines);
    }
    return;
  }
  await runResumeOfflineSessionWithFeedback(dashboardSessionActionDeps(host), session);
}

export async function resumeOfflineServiceWithFeedback(
  host: DashboardOpsHost,
  service: { id: string; label?: string },
): Promise<void> {
  if (host.dashboardPendingActions.getServiceAction(service.id) === "starting") {
    return;
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
    await runDashboardServiceMutation(host, {
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
        ),
      successFlash: { message: `◆ Started service ${service.label ?? service.id}` },
      onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
      errorTitle: "Failed to start service",
    });
    return;
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
  } catch (error) {
    host.setPendingDashboardServiceAction(service.id, null);
    host.refreshLocalDashboardModel();
    host.showDashboardError("Failed to start service", [error instanceof Error ? error.message : String(error)]);
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
      ),
    successFlash: { message: `◆ Created service ${label}` },
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
    settle: (modelLifecycle) => refreshDashboardModelAfterAuthoritativeMutation(host, modelLifecycle),
    successFlash: { message: `◆ Stopped service ${service.label ?? service.id}` },
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
    onError: (lifecycle) => refreshDashboardModelAfterMutationError(host, lifecycle),
    errorTitle: `Failed to migrate "${label}"`,
  });
}
