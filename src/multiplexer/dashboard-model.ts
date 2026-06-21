import type { DashboardService, DashboardSession, WorktreeGroup } from "../dashboard/index.js";
import { buildDashboardSessions } from "../dashboard/session-registry.js";
import { loadLastUsedState } from "../last-used.js";
import {
  loadMetadataEndpoint,
  loadMetadataState,
  removeMetadataEndpoint,
  resolveProjectServiceEndpoint,
} from "../metadata-store.js";
import { MetadataServer } from "../metadata-server.js";
import { PluginRuntime } from "../plugin-runtime.js";
import { LoopWatcher } from "../loop-watcher.js";
import { TranscriptReconciler } from "./transcript-reconciler.js";
import { loadConfig } from "../config.js";
import { findMainRepo } from "../worktree.js";
import { listThreadSummaries, readMessages } from "../threads.js";
import { deriveSessionSemantics } from "../session-semantics.js";
import { NOTIFICATION_TAG, summarizeUnreadNotificationsBySession } from "../notifications.js";
import { isNotificationStale } from "../coordination-model.js";
import { requestJson } from "../http-client.js";
import type { SessionTeamMetadata } from "../team.js";
import { isTeammateSession, isOverseerSession, selectDirectTeammates } from "../team.js";
import { buildWorkflowEntries, describeWorkflowNextAction } from "../workflow.js";
import { ensureDaemonRunning, ensureProjectService } from "../daemon.js";
import { isDashboardWindowName } from "../tmux/runtime-manager.js";
import { dashboardCreatedSortKey, sortDashboardEntriesByCreatedAt } from "../dashboard/sort.js";
import { listDashboardOperationFailures, type DashboardOperationFailure } from "../dashboard/operation-failures.js";
import type {
  PendingServiceActionKind,
  PendingSessionActionKind,
  PendingWorktreeActionKind,
} from "../pending-actions.js";
import { listWorktreeGraveyardPaths } from "./worktree-graveyard.js";
import { setPendingDashboardServiceAction, setPendingDashboardSessionAction } from "./dashboard-ops.js";
import { listTopologySessionStates } from "../runtime-core/topology-sessions.js";
import { reconcileBackendSessionIdForSession } from "../runtime-core/backend-id-reconcile.js";
import { assertSessionRestorable } from "../session-restorability.js";
import { log } from "../debug.js";

type DashboardModelHost = any;
type MetadataPendingSettle<T> = (result: T) => Promise<boolean> | boolean;
interface DashboardStateSnapshotOptions {
  includeRuntimeInfo?: boolean;
}

const METADATA_PENDING_SETTLE_TIMEOUT_MS = 10_000;
const METADATA_PENDING_SETTLE_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listOfflineSessionsForAction(host: DashboardModelHost): any[] {
  const sessionsById = new Map<string, any>();
  for (const session of host.offlineSessions ?? []) {
    if (session?.id) sessionsById.set(session.id, session);
  }
  for (const session of listTopologySessionStates({ statuses: ["offline"] })) {
    if (session?.id && !sessionsById.has(session.id)) sessionsById.set(session.id, session);
  }
  return [...sessionsById.values()];
}

function reconcileSessionsForLifecycleAction(host: DashboardModelHost): void {
  host.syncSessionsFromTopology?.();
  host.saveState?.();
}

function resolveOfflineSessionForAction(host: DashboardModelHost, sessionId: string): any | undefined {
  return listOfflineSessionsForAction(host).find((session: any) => session.id === sessionId);
}

function shouldRelaunchFreshSession(sessionId: string): boolean {
  const derived = loadMetadataState().sessions[sessionId]?.derived;
  return derived?.activity === "error" || derived?.attention === "error";
}

function findDashboardSessionSeed(
  host: DashboardModelHost,
  sessionId: string,
  fallback?: any,
): DashboardSession | undefined {
  const cached = host.dashboardSessionsCache?.find?.((entry: any) => entry.id === sessionId);
  if (cached) return cached;
  return toDashboardSessionSeed(
    host.sessions?.find?.((entry: any) => entry.id === sessionId) ??
      host.offlineSessions?.find?.((entry: any) => entry.id === sessionId) ??
      (fallback?.id ? fallback : undefined),
  );
}

function findDashboardServiceSeed(host: DashboardModelHost, serviceId: string): DashboardService | undefined {
  const cached = host.dashboardServicesCache?.find?.((entry: any) => entry.id === serviceId);
  if (cached) return cached;
  return toDashboardServiceSeed(
    host.services?.find?.((entry: any) => entry.id === serviceId) ??
      host.offlineServices?.find?.((entry: any) => entry.id === serviceId),
  );
}

function toDashboardSessionSeed(seed: any): DashboardSession | undefined {
  if (!seed?.id || !seed.command) return undefined;
  return {
    index: typeof seed.index === "number" ? seed.index : -1,
    id: seed.id,
    command: seed.command,
    toolConfigKey: seed.toolConfigKey,
    label: seed.label,
    status: seed.status ?? (seed.lifecycle === "offline" ? "offline" : "running"),
    active: Boolean(seed.active),
    worktreePath: seed.worktreePath,
    createdAt: seed.createdAt,
    backendSessionId: seed.backendSessionId,
    restoreState: seed.restoreState,
    restoreBlockedReason: seed.restoreBlockedReason,
    headline: seed.headline,
    team: seed.team,
  };
}

function toDashboardServiceSeed(seed: any): DashboardService | undefined {
  if (!seed?.id) return undefined;
  return {
    id: seed.id,
    command: seed.command ?? seed.launchCommandLine ?? seed.label ?? "service",
    args: Array.isArray(seed.args) ? seed.args : [],
    label: seed.label,
    status: seed.status ?? (seed.lifecycle === "offline" ? "offline" : "running"),
    active: Boolean(seed.active),
    worktreePath: seed.worktreePath,
    createdAt: seed.createdAt,
  };
}

function buildMetadataPendingSessionSeed(input: {
  sessionId: string;
  tool: string;
  worktreePath?: string;
  pendingAction: Extract<PendingSessionActionKind, "creating" | "forking">;
  team?: SessionTeamMetadata;
}): DashboardSession {
  return {
    index: -1,
    id: input.sessionId,
    command: input.tool,
    toolConfigKey: input.tool,
    label: input.tool,
    createdAt: new Date().toISOString(),
    status: "waiting",
    active: false,
    worktreePath: input.worktreePath,
    pendingAction: input.pendingAction,
    optimistic: true,
    team: input.team,
  };
}

async function waitForMetadataCondition(
  host: DashboardModelHost,
  predicate: () => boolean,
  timeoutMs = METADATA_PENDING_SETTLE_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      host.invalidateDesktopStateSnapshot?.();
      host.refreshLocalDashboardModel?.();
    } catch {}
    if (predicate()) return true;
    await sleep(METADATA_PENDING_SETTLE_INTERVAL_MS);
  }
  try {
    host.invalidateDesktopStateSnapshot?.();
    host.refreshLocalDashboardModel?.();
  } catch {}
  return predicate();
}

function hasLiveManagedAgentWindow(host: DashboardModelHost, sessionId: string): boolean {
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

function hasLiveManagedServiceWindow(host: DashboardModelHost, serviceId: string): boolean {
  try {
    if (!host.tmuxRuntimeManager?.listProjectManagedWindows) return false;
    return host.tmuxRuntimeManager.listProjectManagedWindows(process.cwd()).some(({ target, metadata }: any) => {
      if (isDashboardWindowName(target.windowName)) return false;
      if (metadata.kind !== "service" || metadata.sessionId !== serviceId) return false;
      if (host.tmuxRuntimeManager.isWindowAlive && !host.tmuxRuntimeManager.isWindowAlive(target)) return false;
      return true;
    });
  } catch {
    return false;
  }
}

function isMetadataSessionRunning(host: DashboardModelHost, sessionId: string): boolean {
  if (host.sessions?.some?.((session: any) => session.id === sessionId && !session.exited)) return true;
  if (host.sessionTmuxTargets?.has?.(sessionId)) return true;
  return hasLiveManagedAgentWindow(host, sessionId);
}

async function waitForMetadataSessionRunning(host: DashboardModelHost, sessionId: string): Promise<boolean> {
  if (typeof host.waitForSessionStart === "function") {
    try {
      if (await host.waitForSessionStart(sessionId, METADATA_PENDING_SETTLE_TIMEOUT_MS)) return true;
    } catch {}
  }
  return waitForMetadataCondition(host, () => isMetadataSessionRunning(host, sessionId));
}

function isMetadataServiceRunning(host: DashboardModelHost, serviceId: string): boolean {
  const offline = host.offlineServices?.some?.((service: any) => service.id === serviceId);
  if (offline) return false;
  if (host.services?.some?.((service: any) => service.id === serviceId && service.status !== "offline")) return true;
  return hasLiveManagedServiceWindow(host, serviceId);
}

function isMetadataServiceOffline(host: DashboardModelHost, serviceId: string): boolean {
  return Boolean(host.offlineServices?.some?.((service: any) => service.id === serviceId));
}

function isMetadataServiceRemoved(host: DashboardModelHost, serviceId: string): boolean {
  const offline = host.offlineServices?.some?.((service: any) => service.id === serviceId);
  if (offline) return false;
  return !hasLiveManagedServiceWindow(host, serviceId);
}

async function settleMetadataPending<T>(
  host: DashboardModelHost,
  description: string,
  settle: MetadataPendingSettle<T> | undefined,
  result: T,
): Promise<void> {
  if (!settle) return;
  try {
    const settled = await settle(result);
    if (!settled) {
      host.debug?.(`metadata pending action did not settle: ${description}`, "dashboard");
    }
  } catch (error) {
    host.debug?.(
      `metadata pending action settle failed: ${description}: ${error instanceof Error ? error.message : String(error)}`,
      "dashboard",
    );
  }
}

function clearMetadataSessionPendingAfterSettle<T>(
  host: DashboardModelHost,
  sessionId: string,
  kind: PendingSessionActionKind,
  token: number | undefined,
  settle: MetadataPendingSettle<T> | undefined,
  result: T,
): void {
  void (async () => {
    await settleMetadataPending(host, `session ${kind} ${sessionId}`, settle, result);
    if (typeof token === "number") {
      if (host.dashboardPendingActions?.clearSessionActionIfToken?.(sessionId, token)) {
        host.reapplyDashboardPendingActions?.();
      }
    } else if (host.dashboardPendingActions?.getSessionAction?.(sessionId) === kind) {
      setPendingDashboardSessionAction(host, sessionId, null);
    }
  })();
}

function clearMetadataServicePendingAfterSettle<T>(
  host: DashboardModelHost,
  serviceId: string,
  kind: PendingServiceActionKind,
  token: number | undefined,
  settle: MetadataPendingSettle<T> | undefined,
  result: T,
): void {
  void (async () => {
    await settleMetadataPending(host, `service ${kind} ${serviceId}`, settle, result);
    if (typeof token === "number") {
      if (host.dashboardPendingActions?.clearServiceActionIfToken?.(serviceId, token)) {
        host.reapplyDashboardPendingActions?.();
      }
    } else if (host.dashboardPendingActions?.getServiceAction?.(serviceId) === kind) {
      setPendingDashboardServiceAction(host, serviceId, null);
    }
  })();
}

export async function withMetadataSessionPending<T>(
  host: DashboardModelHost,
  sessionId: string | undefined,
  kind: PendingSessionActionKind,
  work: () => Promise<T> | T,
  sessionSeed?: DashboardSession,
  settle?: MetadataPendingSettle<T>,
): Promise<T> {
  let token: number | undefined;
  if (sessionId) {
    token = setPendingDashboardSessionAction(host, sessionId, kind, { sessionSeed });
  }
  try {
    const result = await work();
    if (sessionId) {
      clearMetadataSessionPendingAfterSettle(host, sessionId, kind, token, settle, result);
    }
    return result;
  } catch (error) {
    if (sessionId) {
      if (typeof token === "number") {
        if (host.dashboardPendingActions?.clearSessionActionIfToken?.(sessionId, token)) {
          host.reapplyDashboardPendingActions?.();
        }
      } else {
        setPendingDashboardSessionAction(host, sessionId, null);
      }
    }
    throw error;
  }
}

export async function withMetadataServicePending<T>(
  host: DashboardModelHost,
  serviceId: string,
  kind: PendingServiceActionKind,
  work: () => Promise<T> | T,
  settle?: MetadataPendingSettle<T>,
): Promise<T> {
  const token = setPendingDashboardServiceAction(host, serviceId, kind, {
    serviceSeed: findDashboardServiceSeed(host, serviceId),
  });
  try {
    const result = await work();
    clearMetadataServicePendingAfterSettle(host, serviceId, kind, token, settle, result);
    return result;
  } catch (error) {
    if (host.dashboardPendingActions?.clearServiceActionIfToken?.(serviceId, token)) {
      host.reapplyDashboardPendingActions?.();
    }
    throw error;
  }
}

function lifecycleFailureMessage(action: string, failures: Array<{ sessionId: string; error: unknown }>): string {
  const noun = failures.length === 1 ? "teammate" : "teammates";
  const details = failures
    .map(({ sessionId, error }) => `${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    .join("; ");
  return `Failed to ${action} ${failures.length} ${noun}: ${details}`;
}

async function resumeOfflineAgentWithPending(
  host: DashboardModelHost,
  sessionId: string,
): Promise<{ sessionId: string; status: "running" }> {
  return withMetadataSessionPending(
    host,
    sessionId,
    "starting",
    () => {
      reconcileSessionsForLifecycleAction(host);
      let offline = resolveOfflineSessionForAction(host, sessionId);
      if (!offline) {
        throw new Error(`Agent "${sessionId}" not found`);
      }
      if (!offline.backendSessionId) {
        let reconciledBackendSessionId: string | null = null;
        try {
          reconciledBackendSessionId = reconcileBackendSessionIdForSession(offline);
        } catch {
          reconciledBackendSessionId = null;
        }
        if (reconciledBackendSessionId) {
          reconcileSessionsForLifecycleAction(host);
          const reconciledOffline = resolveOfflineSessionForAction(host, sessionId);
          offline =
            reconciledOffline?.backendSessionId === reconciledBackendSessionId
              ? reconciledOffline
              : { ...offline, backendSessionId: reconciledBackendSessionId };
        }
      }
      if (!shouldRelaunchFreshSession(sessionId)) {
        assertSessionRestorable(offline, loadConfig().tools);
      }
      host.resumeOfflineSession(offline);
      return { sessionId, status: "running" as const };
    },
    findDashboardSessionSeed(host, sessionId),
    () => waitForMetadataSessionRunning(host, sessionId),
  );
}

async function resumeOfflineAgentWithPendingAndSettle(
  host: DashboardModelHost,
  sessionId: string,
): Promise<{ sessionId: string; status: "running" }> {
  const result = await resumeOfflineAgentWithPending(host, sessionId);
  await waitForMetadataSessionRunning(host, sessionId);
  return result;
}

async function resumeAgentAndDirectTeammates(
  host: DashboardModelHost,
  sessionId: string,
): Promise<{
  sessionId: string;
  status: "running";
  warning?: string;
  teammateFailures?: Array<{ sessionId: string; error: string }>;
}> {
  reconcileSessionsForLifecycleAction(host);
  const offline = resolveOfflineSessionForAction(host, sessionId);
  if (!offline) {
    throw new Error(`Agent "${sessionId}" not found`);
  }

  const teammates = isTeammateSession(offline)
    ? []
    : selectDirectTeammates(listOfflineSessionsForAction(host), sessionId);
  const result = await resumeOfflineAgentWithPendingAndSettle(host, sessionId);
  const teammateFailures: Array<{ sessionId: string; error: unknown }> = [];

  for (const teammate of teammates) {
    try {
      await resumeOfflineAgentWithPendingAndSettle(host, teammate.id);
    } catch (error) {
      teammateFailures.push({ sessionId: teammate.id, error });
    }
  }

  if (teammateFailures.length > 0) {
    return {
      ...result,
      warning: lifecycleFailureMessage("resume", teammateFailures),
      teammateFailures: teammateFailures.map(({ sessionId, error }) => ({
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })),
    };
  }
  return result;
}

function runProjectServiceUiRefresh(host: DashboardModelHost): void {
  host.writeStatuslineFile();
  if (host.mode === "dashboard") {
    host.renderCurrentDashboardView();
  }
}

const projectServiceAgentResumeQueues = new WeakMap<object, Promise<unknown>>();

async function enqueueProjectServiceAgentResume<T>(host: object, work: () => Promise<T>): Promise<T> {
  const previous = projectServiceAgentResumeQueues.get(host) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  const tracked = current
    .catch(() => undefined)
    .finally(() => {
      if (projectServiceAgentResumeQueues.get(host) === tracked) {
        projectServiceAgentResumeQueues.delete(host);
      }
    });
  projectServiceAgentResumeQueues.set(host, tracked);
  return current;
}

function scheduleProjectServiceUiRefresh(host: DashboardModelHost): void {
  if (host.projectServiceStartupMetadataSettling) {
    host.projectServiceUiRefreshPending = true;
    return;
  }
  if (host.projectServiceUiRefreshTimer) return;
  host.projectServiceUiRefreshTimer = setTimeout(() => {
    host.projectServiceUiRefreshTimer = null;
    runProjectServiceUiRefresh(host);
  }, 75);
  host.projectServiceUiRefreshTimer.unref?.();
}

export function buildDashboardWorktreeGroups(
  _host: DashboardModelHost,
  dashSessions: DashboardSession[],
  dashServices: DashboardService[],
  worktrees: Array<{
    name: string;
    path: string;
    branch: string;
    isBare: boolean;
    createdAt?: string;
    pending?: boolean;
    removing?: boolean;
    pendingAction?: Extract<PendingWorktreeActionKind, "creating" | "removing" | "graveyarding">;
    operationFailure?: DashboardOperationFailure;
  }>,
  mainRepoPath?: string,
): WorktreeGroup[] {
  // Overseer sessions render on their own line above the worktrees, never inside a group.
  const groupable = dashSessions.filter((s) => !isOverseerSession(s));
  const mainSessions = sortDashboardEntriesByCreatedAt(groupable.filter((s) => !s.worktreePath));
  const mainServices = sortDashboardEntriesByCreatedAt(dashServices.filter((s) => !s.worktreePath));
  const mainWorktree = mainRepoPath ? worktrees.find((wt) => !wt.isBare && wt.path === mainRepoPath) : undefined;

  const mainGroup: WorktreeGroup = {
    name: "Main Checkout",
    branch: mainWorktree?.branch ?? "",
    path: undefined,
    createdAt: mainWorktree?.createdAt,
    status: (mainSessions.length > 0 || mainServices.length > 0 ? "active" : "offline") as "active" | "offline",
    sessions: mainSessions,
    services: mainServices,
  };

  const secondaryGroups = sortWorktreeGroups(
    worktrees
      .filter((wt) => !wt.isBare && wt.path !== mainRepoPath)
      .map((wt) => {
        const wtSessions = sortDashboardEntriesByCreatedAt(groupable.filter((s) => s.worktreePath === wt.path));
        const wtServices = sortDashboardEntriesByCreatedAt(dashServices.filter((s) => s.worktreePath === wt.path));
        return {
          name: wt.name,
          branch: wt.branch,
          path: wt.path,
          createdAt: wt.createdAt,
          pending: wt.pending,
          removing: wt.removing,
          pendingAction: wt.pendingAction,
          operationFailure: wt.operationFailure,
          status: (wtSessions.length > 0 || wtServices.length > 0 ? "active" : "offline") as "active" | "offline",
          sessions: wtSessions,
          services: wtServices,
        };
      }),
  );

  return [mainGroup, ...secondaryGroups];
}

function sortWorktreeGroups(groups: WorktreeGroup[]): WorktreeGroup[] {
  return [...groups].sort((a, b) => dashboardCreatedSortKey(b) - dashboardCreatedSortKey(a));
}

export function composeDashboardWorktreeGroups(
  worktreeGroups: WorktreeGroup[],
  dashSessions: DashboardSession[],
  dashServices: DashboardService[],
): WorktreeGroup[] {
  return sortWorktreeGroups(
    worktreeGroups.map((group) => {
      const groupSessions = sortDashboardEntriesByCreatedAt(
        dashSessions.filter((session) => !isOverseerSession(session) && session.worktreePath === group.path),
      );
      const groupServices = sortDashboardEntriesByCreatedAt(
        dashServices.filter((service) => service.worktreePath === group.path),
      );
      return {
        ...group,
        status: (groupSessions.length > 0 || groupServices.length > 0 ? "active" : "offline") as "active" | "offline",
        sessions: groupSessions,
        services: groupServices,
      };
    }),
  );
}

export function applyDashboardModel(
  host: DashboardModelHost,
  dashSessions: DashboardSession[],
  dashTeammates: DashboardSession[],
  dashServices: DashboardService[],
  worktreeGroups: WorktreeGroup[],
  mainCheckoutInfo: { name: string; branch: string },
  operationFailures: DashboardOperationFailure[] = [],
): boolean {
  const snapshotKey = JSON.stringify({
    sessions: dashSessions,
    teammates: dashTeammates,
    services: dashServices,
    worktreeGroups,
    mainCheckoutInfo,
    operationFailures,
    pendingActionsVersion: host.dashboardPendingActions.getVersion?.() ?? 0,
  });
  if (snapshotKey === host.dashboardModelSnapshotKey) {
    host.dashboardModelRefreshedAt = Date.now();
    return false;
  }
  host.dashboardModelSnapshotKey = snapshotKey;
  host.dashboardRawWorktreeGroupsCache = worktreeGroups;
  host.dashboardSessionsCache = host.dashboardPendingActions.applyToSessions(dashSessions);
  host.dashboardTeammatesCache = host.dashboardPendingActions
    .applyToSessions(dashTeammates, { includeTeammates: true })
    .filter((session: DashboardSession) => isTeammateSession(session));
  host.dashboardServicesCache = host.dashboardPendingActions.applyToServices(dashServices);
  host.dashboardWorktreeGroupsCache = host.dashboardUiStateStore.orderWorktreeGroups(
    composeDashboardWorktreeGroups(
      host.dashboardPendingActions.applyToWorktrees(worktreeGroups),
      host.dashboardSessionsCache,
      host.dashboardServicesCache,
    ),
  );
  host.dashboardOperationFailuresCache = operationFailures;
  host.dashboardMainCheckoutInfoCache = mainCheckoutInfo;
  host.dashboardModelVersion = (host.dashboardModelVersion ?? 0) + 1;
  host.dashboardModelRefreshedAt = Date.now();
  host.dashboardUiStateStore.markSelectionDirty();
  return true;
}

export function invalidateDesktopStateSnapshot(host: DashboardModelHost): void {
  host.desktopStateSnapshot = null;
}

export function refreshDesktopStateSnapshot(
  host: DashboardModelHost,
  options: DashboardStateSnapshotOptions = {},
): void {
  host.desktopStateSnapshot = buildDesktopStateSnapshot(host, options);
}

export function computeDashboardSessions(
  host: DashboardModelHost,
  options: { includeTeammates?: boolean; includeRuntimeInfo?: boolean } = {},
): DashboardSession[] {
  const includeRuntimeInfo = options.includeRuntimeInfo !== false;
  const lastUsedState = loadLastUsedState(process.cwd());
  const metadata = loadMetadataState().sessions;
  // Notification records are exchange threads tagged `notification`; they are surfaced by the
  // per-session unread-notification count, so excluding them here keeps the dashboard's
  // thread chips from double-counting the same needs-input record.
  const threadSummaries = listThreadSummaries().filter((summary) => !summary.thread.tags?.includes(NOTIFICATION_TAG));
  const threadStats = new Map<
    string,
    {
      unread: number;
      waiting: number;
      waitingOnMe: number;
      waitingOnThem: number;
      pending: number;
      latestId?: string;
      latestTitle?: string;
    }
  >();
  const workflowStats = new Map<
    string,
    {
      onMe: number;
      blocked: number;
      families: Set<string>;
      topUrgency: number;
      topLabel?: string;
      nextAction?: string;
    }
  >();
  for (const summary of threadSummaries) {
    const messages = readMessages(summary.thread.id);
    const pendingByParticipant = new Map<string, number>();
    for (const message of messages) {
      for (const recipient of message.to ?? []) {
        if (!(message.deliveredTo ?? []).includes(recipient)) {
          pendingByParticipant.set(recipient, (pendingByParticipant.get(recipient) ?? 0) + 1);
        }
      }
    }
    for (const participant of summary.thread.participants) {
      const current = threadStats.get(participant) ?? {
        unread: 0,
        waiting: 0,
        waitingOnMe: 0,
        waitingOnThem: 0,
        pending: 0,
      };
      if ((summary.thread.unreadBy ?? []).includes(participant)) current.unread += 1;
      const waitsOnParticipant = (summary.thread.waitingOn ?? []).includes(participant);
      const ownedByParticipant = summary.thread.owner === participant;
      if (waitsOnParticipant || ownedByParticipant) current.waiting += 1;
      if (waitsOnParticipant) current.waitingOnMe += 1;
      if (ownedByParticipant && (summary.thread.waitingOn?.length ?? 0) > 0) current.waitingOnThem += 1;
      current.pending += pendingByParticipant.get(participant) ?? 0;
      if (!current.latestId) {
        current.latestId = summary.thread.id;
        current.latestTitle = summary.thread.title;
      }
      threadStats.set(participant, current);
    }
  }
  const workflowEntries = buildWorkflowEntries("user");
  for (const entry of workflowEntries) {
    const familyKey = entry.familyRootTaskId ?? entry.thread.id;
    for (const participant of entry.thread.participants) {
      const current = workflowStats.get(participant) ?? {
        onMe: 0,
        blocked: 0,
        families: new Set<string>(),
        topUrgency: -1,
      };
      if ((entry.thread.waitingOn ?? []).includes(participant)) current.onMe += 1;
      if (entry.thread.status === "blocked" || entry.task?.status === "blocked") current.blocked += 1;
      if (entry.familyTaskIds.length > 1) current.families.add(familyKey);
      if (entry.urgency > current.topUrgency) {
        current.topUrgency = entry.urgency;
        current.topLabel = `${entry.displayTitle} (${entry.stateLabel})`;
        current.nextAction = describeWorkflowNextAction(entry, participant);
      }
      workflowStats.set(participant, current);
    }
  }
  let mainRepoPath: string | undefined;
  try {
    mainRepoPath = findMainRepo();
  } catch {}
  const sessions = buildDashboardSessions({
    sessions: host.sessions.map((session: any) => ({
      id: session.id,
      command: session.command,
      toolConfigKey: host.sessionToolKeys?.get?.(session.id),
      backendSessionId: session.backendSessionId,
      team: session.team,
      createdAt: session.startTime ? new Date(session.startTime).toISOString() : undefined,
      status: session.status,
      worktreePath: host.sessionWorktreePaths.get(session.id),
      tmuxWindowId: host.sessionTmuxTargets.get(session.id)?.windowId,
    })),
    activeIndex: host.activeIndex,
    offlineSessions: host.offlineSessions,
    hiddenWorktreePaths: listWorktreeGraveyardPaths(),
    mainRepoPath,
    includeTeammates: options.includeTeammates,
    getSessionLabel: (sessionId: string) => host.getSessionLabel(sessionId),
    getSessionHeadline: (sessionId: string) => host.deriveHeadline(sessionId),
    getSessionTaskDescription: () => undefined,
    getSessionRole: (sessionId: string) => host.sessionRoles.get(sessionId),
    getSessionContext: (sessionId: string) => metadata[sessionId]?.context,
    getSessionDerived: (sessionId: string) => metadata[sessionId]?.derived,
  });
  const metadataBySessionId = new Map<string, { createdAt?: string; target?: { windowIndex?: number } }>();
  const notificationsBySessionId = summarizeUnreadNotificationsBySession();
  for (const { target, metadata } of host.tmuxRuntimeManager.listProjectManagedWindows(process.cwd())) {
    if (metadata.kind !== "agent") continue;
    if (includeRuntimeInfo && host.tmuxRuntimeManager.isWindowAlive && !host.tmuxRuntimeManager.isWindowAlive(target)) {
      continue;
    }
    metadataBySessionId.set(metadata.sessionId, { createdAt: metadata.createdAt, target });
  }
  return sessions.map((session) => {
    const stats = threadStats.get(session.id);
    const workflow = workflowStats.get(session.id);
    const metadata = metadataBySessionId.get(session.id);
    const target = host.sessionTmuxTargets.get(session.id) ?? metadata?.target;
    const notifications = notificationsBySessionId.get(session.id);
    const runtimeInfo = includeRuntimeInfo && target ? readTmuxProcessInfo(host, target) : {};
    const semantic = deriveSessionSemantics({
      status: session.status,
      pendingAction: session.pendingAction,
      activity: session.activity,
      attention: session.attention,
      unseenCount: session.unseenCount,
      notificationUnreadCount: notifications?.unreadCount ?? 0,
      latestNotification: notifications?.latestUnread,
      threadUnreadCount: stats?.unread ?? 0,
      threadPendingCount: stats?.pending ?? 0,
      threadWaitingOnMeCount: stats?.waitingOnMe ?? 0,
      threadWaitingOnThemCount: stats?.waitingOnThem ?? 0,
      workflowOnMeCount: workflow?.onMe ?? 0,
      workflowBlockedCount: workflow?.blocked ?? 0,
      workflowFamilyCount: workflow?.families.size ?? 0,
      hasActiveTask: Boolean(session.taskDescription),
    });
    return {
      ...session,
      tmuxWindowIndex: target?.windowIndex,
      createdAt: session.createdAt ?? metadata?.createdAt,
      lastUsedAt: lastUsedState.items[session.id]?.lastUsedAt,
      foregroundCommand: runtimeInfo.command,
      pid: runtimeInfo.pid,
      previewLine: runtimeInfo.previewLine,
      threadUnreadCount: stats?.unread ?? 0,
      threadWaitingCount: stats?.waiting ?? 0,
      threadWaitingOnMeCount: stats?.waitingOnMe ?? 0,
      threadWaitingOnThemCount: stats?.waitingOnThem ?? 0,
      threadPendingCount: stats?.pending ?? 0,
      threadId: session.threadId ?? stats?.latestId,
      threadName: session.threadName ?? stats?.latestTitle,
      workflowOnMeCount: workflow?.onMe ?? 0,
      workflowBlockedCount: workflow?.blocked ?? 0,
      workflowFamilyCount: workflow?.families.size ?? 0,
      workflowTopLabel: workflow?.topLabel,
      workflowNextAction: workflow?.nextAction,
      notificationUnreadCount: notifications?.unreadCount ?? 0,
      notificationNeedsInputUnreadCount: notifications?.needsInputUnreadCount ?? 0,
      latestNotificationText: notifications?.latestUnread?.body || notifications?.latestUnread?.title,
      notificationStale:
        semantic.runtime.isAlive &&
        isNotificationStale(semantic.user.label, (notifications?.needsInputUnreadCount ?? 0) > 0),
      semantic,
    };
  });
}

export function computeDashboardServices(
  host: DashboardModelHost,
  worktrees = host.listDesktopWorktrees(),
  options: { includeRuntimeInfo?: boolean } = {},
): DashboardService[] {
  const includeRuntimeInfo = options.includeRuntimeInfo !== false;
  const hiddenWorktreePaths = listWorktreeGraveyardPaths();
  const lastUsedState = loadLastUsedState(process.cwd());
  const sessionMetadata = loadMetadataState().sessions;
  const offlineServiceIds = new Set(host.offlineServices.map((service: any) => service.id));
  const worktreeByPath = new Map<string, { name: string; path: string; branch: string; isBare: boolean }>(
    worktrees.map((wt: any) => [wt.path, wt] as const),
  );
  const liveServices = host.tmuxRuntimeManager
    .listProjectManagedWindows(process.cwd())
    .filter(({ target, metadata }: any) => !isDashboardWindowName(target.windowName) && metadata.kind === "service")
    .filter(({ metadata }: any) => !offlineServiceIds.has(metadata.sessionId))
    .filter(({ metadata }: any) => !(metadata.worktreePath && hiddenWorktreePaths.has(metadata.worktreePath)))
    .map(({ target, metadata }: any) => {
      const worktree = metadata.worktreePath ? worktreeByPath.get(metadata.worktreePath) : undefined;
      const alive = includeRuntimeInfo ? host.tmuxRuntimeManager.isWindowAlive(target) : target.paneDead !== true;
      const info = includeRuntimeInfo ? readTmuxProcessInfo(host, target) : {};
      const shellMetadata = sessionMetadata[metadata.sessionId]?.derived;
      return {
        id: metadata.sessionId,
        command: metadata.command,
        args: metadata.args ?? [],
        tmuxWindowId: target.windowId,
        tmuxWindowIndex: target.windowIndex,
        createdAt: metadata.createdAt,
        lastUsedAt: lastUsedState.items[metadata.sessionId]?.lastUsedAt,
        worktreePath: metadata.worktreePath,
        worktreeName: worktree?.name,
        worktreeBranch: worktree?.branch,
        status: alive ? ("running" as const) : ("exited" as const),
        active: false,
        label: metadata.label,
        cwd: includeRuntimeInfo
          ? (host.tmuxRuntimeManager.displayMessage("#{pane_current_path}", target.windowId) ?? metadata.worktreePath)
          : metadata.worktreePath,
        foregroundCommand: info.command,
        shellCommand: shellMetadata?.shellCommand,
        shellCommandState: shellMetadata?.shellCommandState,
        pid: info.pid,
        previewLine: info.previewLine,
      };
    });
  const liveIds = new Set(liveServices.map((service: any) => service.id));
  const offlineServices = host.offlineServices
    .filter((service: any) => !liveIds.has(service.id))
    .filter((service: any) => !(service.worktreePath && hiddenWorktreePaths.has(service.worktreePath)))
    .map((service: any) => {
      const worktree = service.worktreePath ? worktreeByPath.get(service.worktreePath) : undefined;
      const label = service.label ?? host.serviceLabelForCommand(service.launchCommandLine ?? "");
      const previewLine = service.launchCommandLine?.trim() || "Interactive shell";
      const shellMetadata = sessionMetadata[service.id]?.derived;
      return {
        id: service.id,
        command: service.launchCommandLine?.trim() ?? "",
        args: [],
        createdAt: service.createdAt,
        lastUsedAt: lastUsedState.items[service.id]?.lastUsedAt,
        worktreePath: service.worktreePath,
        worktreeName: worktree?.name,
        worktreeBranch: worktree?.branch,
        status: "offline" as const,
        active: false,
        label,
        cwd: service.cwd ?? service.worktreePath,
        foregroundCommand: label,
        shellCommand: shellMetadata?.shellCommand,
        shellCommandState: shellMetadata?.shellCommandState,
        previewLine,
      };
    });
  return [...liveServices, ...offlineServices];
}

export function readTmuxProcessInfo(
  host: DashboardModelHost,
  target: { windowId: string },
): { command?: string; pid?: number; previewLine?: string } {
  const raw = host.tmuxRuntimeManager.displayMessage("#{pane_current_command}\t#{pane_pid}", target.windowId) ?? "";
  const [command, pidRaw] = raw.split("\t");
  let previewLine: string | undefined;
  try {
    previewLine = host.tmuxRuntimeManager
      .captureTarget(target, { startLine: -8 })
      .split("\n")
      .map((line: string) => line.trim())
      .filter(Boolean)
      .at(-1);
  } catch {}
  return {
    command: command?.trim() || undefined,
    pid: pidRaw && /^\d+$/.test(pidRaw.trim()) ? Number(pidRaw.trim()) : undefined,
    previewLine,
  };
}

export function buildDesktopStateSnapshot(host: DashboardModelHost, options: DashboardStateSnapshotOptions = {}) {
  if (options.includeRuntimeInfo !== false) host.syncSessionsFromTopology();
  const worktrees = host.listDesktopWorktrees();
  const realizedWorktreePaths = new Set(
    worktrees.filter((worktree: any) => !worktree.operationFailure).map((worktree: any) => worktree.path),
  );
  const operationFailures = listDashboardOperationFailures().filter(
    (failure) =>
      !(
        failure.targetKind === "worktree" &&
        failure.operation === "create" &&
        Boolean(failure.worktreePath && realizedWorktreePaths.has(failure.worktreePath))
      ),
  );
  let mainCheckoutInfo = { name: "Main Checkout", branch: "" };
  let mainCheckoutPath: string | undefined;
  try {
    mainCheckoutPath = findMainRepo();
  } catch {}
  const mainWorktree =
    (mainCheckoutPath ? worktrees.find((wt: any) => wt.path === mainCheckoutPath) : worktrees[0]) ?? worktrees[0];
  if (mainWorktree) {
    mainCheckoutInfo = { name: "Main Checkout", branch: mainWorktree.branch };
  }
  const sessions = computeDashboardSessions(host, options);
  const teammates = computeDashboardSessions(host, { ...options, includeTeammates: true }).filter((session) =>
    isTeammateSession(session),
  );
  const services = computeDashboardServices(host, worktrees, options);
  const worktreeGroups = buildDashboardWorktreeGroups(host, sessions, services, worktrees, mainCheckoutPath);
  return {
    sessions,
    teammates,
    services,
    worktrees,
    worktreeGroups,
    operationFailures,
    mainCheckoutInfo,
    mainCheckoutPath,
  };
}

function isMainCheckoutInfo(value: any): value is { name: string; branch: string } {
  return Boolean(value) && typeof value.name === "string" && typeof value.branch === "string";
}

function isDashboardWorktreeGroup(value: any): value is WorktreeGroup {
  return (
    Boolean(value) &&
    typeof value.name === "string" &&
    typeof value.branch === "string" &&
    (value.path === undefined || typeof value.path === "string") &&
    (value.status === "active" || value.status === "offline") &&
    Array.isArray(value.sessions) &&
    Array.isArray(value.services)
  );
}

function isDesktopStateDashboardModel(value: any): value is {
  ok?: boolean;
  sessions: DashboardSession[];
  teammates: DashboardSession[];
  services: DashboardService[];
  worktreeGroups: WorktreeGroup[];
  operationFailures?: DashboardOperationFailure[];
  mainCheckoutInfo: { name: string; branch: string };
} {
  return (
    Boolean(value) &&
    value.ok === true &&
    Array.isArray(value.sessions) &&
    Array.isArray(value.teammates) &&
    Array.isArray(value.services) &&
    Array.isArray(value.worktreeGroups) &&
    value.worktreeGroups.every(isDashboardWorktreeGroup) &&
    (value.operationFailures === undefined || Array.isArray(value.operationFailures)) &&
    isMainCheckoutInfo(value.mainCheckoutInfo)
  );
}

export async function refreshDashboardModelFromService(host: DashboardModelHost, force = false): Promise<boolean> {
  if (host.mode !== "dashboard") return false;
  if (!force && host.dashboardModelRefreshedAt > 0 && Date.now() - host.dashboardModelRefreshedAt < 750) {
    return false;
  }
  if (host.dashboardServiceSnapshotRefreshing) return false;
  host.dashboardServiceSnapshotRefreshing = true;
  const deadline = force ? Date.now() + 8000 : Date.now();
  try {
    for (;;) {
      const endpoint = resolveProjectServiceEndpoint(process.cwd());
      if (endpoint) {
        try {
          const { status, json } = await requestJson(`http://${endpoint.host}:${endpoint.port}/desktop-state`, {
            timeoutMs: force ? 2000 : 750,
          });
          if (status >= 200 && status < 300) {
            if (!isDesktopStateDashboardModel(json)) return false;
            return applyDashboardModel(
              host,
              json.sessions,
              json.teammates,
              json.services,
              json.worktreeGroups,
              json.mainCheckoutInfo,
              json.operationFailures ?? [],
            );
          }
        } catch {
          await ensureDashboardControlPlane(host);
        }
      } else if (force) {
        await ensureDashboardControlPlane(host);
      }
      if (!force || Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } catch {
    return false;
  } finally {
    host.dashboardServiceSnapshotRefreshing = false;
  }
}

export function refreshLocalDashboardModel(host: DashboardModelHost): void {
  const snapshot = buildDesktopStateSnapshot(host);
  const worktreeGroups = buildDashboardWorktreeGroups(
    host,
    snapshot.sessions,
    snapshot.services,
    snapshot.worktrees,
    snapshot.mainCheckoutPath,
  );
  applyDashboardModel(
    host,
    snapshot.sessions,
    snapshot.teammates,
    snapshot.services,
    worktreeGroups,
    snapshot.mainCheckoutInfo,
    snapshot.operationFailures,
  );
}

export async function startProjectServices(host: DashboardModelHost): Promise<void> {
  if (host.metadataServer) return;
  host.projectServiceStartupMetadataSettling = true;
  host.projectServiceUiRefreshPending = false;
  host.metadataServer = new MetadataServer({
    events: { bus: host.eventBus },
    desktop: {
      getState: () => host.buildDesktopState({ includeStatusline: false, includeRuntimeInfo: false }),
      listWorktrees: () => host.listProjectedDesktopWorktrees(),
      getSessionDisplayContext: (sessionId: string) => {
        const session =
          host.dashboardSessionsCache.find((entry: any) => entry.id === sessionId) ??
          host.sessions.find((entry: any) => entry.id === sessionId);
        const service =
          host.dashboardServicesCache.find((entry: any) => entry.id === sessionId) ??
          host.services?.find?.((entry: any) => entry.id === sessionId) ??
          host.offlineServices?.find?.((entry: any) => entry.id === sessionId);
        const worktreePath = host.sessionWorktreePaths.get(sessionId) ?? session?.worktreePath ?? service?.worktreePath;
        const group = worktreePath
          ? host.dashboardWorktreeGroupsCache.find((entry: any) => entry.path === worktreePath)
          : host.dashboardWorktreeGroupsCache.find((entry: any) => !entry.path);
        return {
          label:
            host.getSessionLabel(sessionId) ??
            session?.label ??
            service?.label ??
            (service ? host.serviceLabelForCommand?.(service.launchCommandLine ?? service.command ?? "") : undefined) ??
            session?.command,
          command: session?.command ?? service?.command ?? service?.launchCommandLine,
          worktreePath,
          worktreeName: session?.worktreeName ?? service?.worktreeName ?? group?.name,
          branch: session?.worktreeBranch ?? service?.worktreeBranch ?? group?.branch,
        };
      },
      refreshStatusline: ({ sessionId, force }: any) => host.refreshProjectStatusline({ sessionId, force }),
      createWorktree: ({ name }: any) => host.createDesktopWorktree(name),
      removeWorktree: ({ path }: any) => host.removeDesktopWorktree(path),
      graveyardWorktree: ({ path }: any) => host.graveyardDesktopWorktree(path),
      listWorktreeGraveyard: () => host.listWorktreeGraveyardEntries(),
      resurrectGraveyardWorktree: ({ path }: any) => host.resurrectGraveyardWorktree(path),
      deleteGraveyardWorktree: ({ path }: any) => host.deleteGraveyardWorktree(path),
      createService: ({ command, worktreePath, serviceId }: any) =>
        host.createService(command ?? "", worktreePath, { serviceId }),
      stopService: ({ serviceId }: any) =>
        withMetadataServicePending(
          host,
          serviceId,
          "stopping",
          () => host.stopService(serviceId),
          () => waitForMetadataCondition(host, () => isMetadataServiceOffline(host, serviceId)),
        ),
      resumeService: ({ serviceId }: any) =>
        withMetadataServicePending(
          host,
          serviceId,
          "starting",
          () => host.resumeOfflineServiceById(serviceId),
          () => waitForMetadataCondition(host, () => isMetadataServiceRunning(host, serviceId)),
        ),
      removeService: ({ serviceId }: any) =>
        withMetadataServicePending(
          host,
          serviceId,
          "removing",
          () => host.removeOfflineService(serviceId),
          () => waitForMetadataCondition(host, () => isMetadataServiceRemoved(host, serviceId)),
        ),
      resumeAgent: ({ sessionId }: any) =>
        enqueueProjectServiceAgentResume(host, () => resumeAgentAndDirectTeammates(host, sessionId)),
      listGraveyard: () => host.listGraveyardEntries(),
      resurrectGraveyard: ({ sessionId }: any) => host.resurrectGraveyardSession(sessionId),
      cleanupGraveyard: (input: any) => host.cleanupGraveyard(input),
    },
    threads: {
      sendMessage: (input: any) => host.sendOrchestrationMessage(input),
    },
    actions: {
      sendHandoff: (input: any) => host.sendHandoffMessage(input),
    },
    lifecycle: {
      spawnAgent: (input: any) =>
        withMetadataSessionPending(
          host,
          input.sessionId,
          "creating",
          () =>
            host.spawnAgent({
              toolConfigKey: input.tool,
              targetSessionId: input.sessionId,
              targetWorktreePath: input.worktreePath,
              open: input.open ?? false,
              launchOverride: input.launchOverride,
              overseer: input.overseer ?? false,
            }),
          input.sessionId
            ? buildMetadataPendingSessionSeed({
                sessionId: input.sessionId,
                tool: input.tool,
                worktreePath: input.worktreePath,
                pendingAction: "creating",
              })
            : undefined,
          (result) => waitForMetadataSessionRunning(host, result.sessionId),
        ),
      createTeammateAgent: (input: any) =>
        withMetadataSessionPending(
          host,
          input.sessionId,
          "creating",
          () =>
            host.createTeammateAgent({
              parentSessionId: input.parentSessionId,
              role: input.role,
              label: input.label,
              toolConfigKey: input.tool,
              targetSessionId: input.sessionId,
              targetWorktreePath: input.worktreePath,
              open: input.open ?? false,
              extraArgs: input.extraArgs,
              order: input.order,
            }),
          input.sessionId
            ? buildMetadataPendingSessionSeed({
                sessionId: input.sessionId,
                tool: input.tool,
                worktreePath: input.worktreePath,
                pendingAction: "creating",
                team: {
                  teamId: `team-${input.parentSessionId}`,
                  parentSessionId: input.parentSessionId,
                  role: typeof input.role === "string" && input.role.trim() ? input.role.trim() : undefined,
                  label: typeof input.label === "string" && input.label.trim() ? input.label.trim() : undefined,
                  order: typeof input.order === "number" ? input.order : undefined,
                },
              })
            : undefined,
          (result) =>
            result?.reused && result.sessionId !== input.sessionId
              ? true
              : waitForMetadataSessionRunning(host, result.sessionId),
        ),
      forkAgent: (input: any) =>
        withMetadataSessionPending(
          host,
          input.targetSessionId,
          "forking",
          () =>
            host.forkAgent({
              sourceSessionId: input.sourceSessionId,
              targetToolConfigKey: input.tool,
              targetSessionId: input.targetSessionId,
              instruction: input.instruction,
              targetWorktreePath: input.worktreePath,
              open: input.open ?? false,
              launchOverride: input.launchOverride,
            }),
          input.targetSessionId
            ? buildMetadataPendingSessionSeed({
                sessionId: input.targetSessionId,
                tool: input.tool,
                worktreePath: input.worktreePath,
                pendingAction: "forking",
              })
            : undefined,
          (result) => waitForMetadataSessionRunning(host, result.sessionId),
        ),
      stopAgent: (input: any) =>
        withMetadataSessionPending(
          host,
          input.sessionId,
          "stopping",
          () => host.stopAgent(input.sessionId),
          findDashboardSessionSeed(host, input.sessionId),
        ),
      interruptAgent: (input: any) => host.interruptAgent(input.sessionId),
      resizeAgentPane: (input: any) => host.resizeAgentPane(input.sessionId, input.cols, input.rows),
      renameAgent: (input: any) => host.renameAgent(input.sessionId, input.label),
      migrateAgent: (input: any) =>
        withMetadataSessionPending(
          host,
          input.sessionId,
          "migrating",
          () => host.migrateAgent(input.sessionId, input.worktreePath),
          findDashboardSessionSeed(host, input.sessionId),
        ),
      killAgent: (input: any) =>
        withMetadataSessionPending(
          host,
          input.sessionId,
          "graveyarding",
          () => host.sendAgentToGraveyard(input.sessionId),
          findDashboardSessionSeed(host, input.sessionId),
        ),
      recordBackendSessionId: (input: any) =>
        host.recordSessionBackendSessionId(input.sessionId, input.backendSessionId),
      sendAgentInput: (input: any) => host.sendAgentInput(input.sessionId, input.text),
      readAgentOutput: (input: any) => host.readAgentOutput(input.sessionId, input.startLine),
    },
    onChange: () => {
      scheduleProjectServiceUiRefresh(host);
    },
  });
  await host.metadataServer.start();
  const endpoint = host.metadataServer.getAddress();
  if (endpoint) {
    host.pluginRuntime = new PluginRuntime(
      {
        host: endpoint.host,
        port: endpoint.port,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      },
      host.eventBus,
      () => {
        scheduleProjectServiceUiRefresh(host);
      },
    );
    try {
      await host.pluginRuntime.start();
    } catch (error) {
      log.warn("project service plugin runtime disabled after startup failure", "plugin", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      await Promise.resolve(host.pluginRuntime.stop?.()).catch(() => {});
      host.pluginRuntime = null;
    }
    try {
      host.loopWatcher = new LoopWatcher({
        config: loadConfig().loop,
        loadSessions: () => listTopologySessionStates({ statuses: ["running", "idle", "starting"] }),
        loadMetadata: () => loadMetadataState(),
        hasPendingInteraction: (sessionId: string) =>
          (host.metadataServer?.listPendingInteractions(sessionId)?.length ?? 0) > 0,
        sendAgentInput: (sessionId: string, text: string) => host.sendAgentInput(sessionId, text),
      });
      host.loopWatcher.start();
    } catch (error) {
      log.warn("project service loop watcher disabled after startup failure", "runtime", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      host.loopWatcher?.stop?.();
      host.loopWatcher = null;
    }
  }
  // The reconciler talks to host.metadataServer in-process, so it must start with
  // the project service regardless of whether the HTTP endpoint bound — it is not
  // gated on `endpoint` like the plugin runtime and loop watcher above.
  try {
    host.transcriptReconciler = new TranscriptReconciler({
      loadMetadata: () => loadMetadataState(),
      loadSessions: () => listTopologySessionStates({ statuses: ["running", "idle", "starting"] }),
      hasPendingInteraction: (sessionId: string) =>
        (host.metadataServer?.listPendingInteractions(sessionId)?.length ?? 0) > 0,
      settleActivity: (sessionId: string) => host.metadataServer?.reconcileSettleActivity(sessionId),
      clearStaleResponse: (sessionId: string) => host.metadataServer?.reconcileClearResponse(sessionId),
    });
    host.transcriptReconciler.start();
  } catch (error) {
    log.warn("project service transcript reconciler disabled after startup failure", "runtime", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    host.transcriptReconciler?.stop?.();
    host.transcriptReconciler = null;
  }
  host.projectServiceStartupMetadataSettling = false;
  if (host.projectServiceUiRefreshPending) {
    host.projectServiceUiRefreshPending = false;
    runProjectServiceUiRefresh(host);
  }
}

export async function stopProjectServices(host: DashboardModelHost): Promise<void> {
  if (host.projectServiceUiRefreshTimer) {
    clearTimeout(host.projectServiceUiRefreshTimer);
    host.projectServiceUiRefreshTimer = null;
  }
  host.projectServiceStartupMetadataSettling = false;
  host.projectServiceUiRefreshPending = false;
  const ownedMetadataServer = host.metadataServer;
  ownedMetadataServer?.stop();
  host.metadataServer = null;
  const endpoint = loadMetadataEndpoint();
  if (ownedMetadataServer && endpoint?.pid === process.pid) {
    removeMetadataEndpoint();
  }
  host.loopWatcher?.stop?.();
  host.loopWatcher = null;
  host.transcriptReconciler?.stop?.();
  host.transcriptReconciler = null;
  await host.pluginRuntime?.stop?.();
  host.pluginRuntime = null;
}

async function ensureDashboardControlPlane(host: DashboardModelHost): Promise<void> {
  if (host.dashboardServiceRecovery) {
    await host.dashboardServiceRecovery;
    return;
  }
  host.dashboardServiceRecovery = (async () => {
    await ensureDaemonRunning();
    await ensureProjectService(process.cwd());
  })();
  try {
    await host.dashboardServiceRecovery;
  } finally {
    host.dashboardServiceRecovery = null;
  }
}
