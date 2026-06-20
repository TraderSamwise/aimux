import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { loadConfig } from "../config.js";
import type { PendingWorktreeActionKind } from "../pending-actions.js";
import {
  addDashboardOperationFailure,
  clearDashboardOperationFailures,
  listDashboardOperationFailures,
  type DashboardOperationFailure,
} from "../dashboard/operation-failures.js";
import { composeDashboardWorktreeGroups } from "./dashboard-model.js";
import { type DashboardScreen } from "../dashboard/state.js";
import { loadDaemonInfo } from "../daemon.js";
import { type DashboardService, type DashboardSession, type WorktreeGroup } from "../dashboard/index.js";
import { getProjectStateDir, getStatePath } from "../paths.js";
import { writeJsonAtomic, writeTextAtomic } from "../atomic-write.js";
import { debug } from "../debug.js";
import {
  buildGraveyardCleanupPlan,
  deleteAgentAssets,
  deleteGraveyardAgent,
  runGraveyardCleanup,
  type GraveyardCleanupRunResult,
} from "../graveyard-cleanup.js";
import { buildInboxCleanupPlan, runInboxCleanup, type InboxCleanupRunResult } from "../inbox-cleanup.js";
import { buildCoordinationModel } from "../coordination-model.js";
import { listNotifications } from "../notifications.js";
import { loadMetadataState } from "../metadata-store.js";
import { createRuntimeExchangeStore } from "../runtime-core/exchange-store.js";
import { renderCurrentDashboardView as renderCurrentDashboardViewImpl } from "./runtime-state.js";
import {
  listWorktreeGraveyardEntries as listWorktreeGraveyardEntriesImpl,
  listWorktreeGraveyardPaths,
} from "./worktree-graveyard.js";
import { loadStatusline, renderTmuxStatuslineFromData } from "../tmux/statusline.js";
import { ensureTmuxStatuslineDir, invalidateTmuxStatuslineArtifacts } from "../tmux/statusline-cache.js";
import { markLastUsed } from "../last-used.js";
import { isTeammateSession } from "../team.js";
import {
  listTopologySessionStates,
  removeTopologySessionsForWorktree,
  resurrectTopologySession,
} from "../runtime-core/topology-sessions.js";
import { removeTopologyServicesForWorktree, upsertTopologyService } from "../runtime-core/topology-services.js";
import {
  deleteTopologyWorktreeGraveyardEntry,
  listTopologyWorktreeGraveyard,
  moveTopologyWorktreeToGraveyard,
  removeTopologyWorktree,
  resurrectTopologyWorktreeFromGraveyard,
  upsertTopologyWorktree,
} from "../runtime-core/topology-worktrees.js";
import {
  findMainRepo,
  getWorktreeBaseDir,
  getWorktreeAddArgs,
  getWorktreeCreatePath,
  isToolInternalWorktree,
  listWorktrees as listAllWorktrees,
} from "../worktree.js";

const DEFAULT_GRAVEYARD_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_GRAVEYARD_CLEANUP_INTERVAL_MS = 60_000;

function normalizeGraveyardCleanupIntervalMs(value: unknown): number {
  const intervalMs = Number(value);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return DEFAULT_GRAVEYARD_CLEANUP_INTERVAL_MS;
  return Math.max(MIN_GRAVEYARD_CLEANUP_INTERVAL_MS, intervalMs);
}

const DEFAULT_INBOX_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_INBOX_CLEANUP_INTERVAL_MS = 60_000;

function normalizeInboxCleanupIntervalMs(value: unknown): number {
  const intervalMs = Number(value);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return DEFAULT_INBOX_CLEANUP_INTERVAL_MS;
  return Math.max(MIN_INBOX_CLEANUP_INTERVAL_MS, intervalMs);
}

// Unread notifications for agents that still genuinely want attention; the cleanup must
// never archive these even when trimming to maxSize.
function actionableUnreadNotificationIds(host: any): Set<string> {
  const model = buildCoordinationModel({
    sessions: host.getDashboardSessions?.() ?? [],
    teammates: host.dashboardTeammatesCache ?? [],
    services: host.getDashboardServices?.() ?? [],
    notifications: listNotifications(),
    threads: host.threadEntries ?? [],
  });
  const ids = new Set<string>();
  for (const item of model.actionable) {
    for (const notification of item.notifications) {
      if (notification.unread) ids.add(notification.id);
    }
  }
  return ids;
}

function refreshAfterGraveyardCleanup(host: any): void {
  host.loadOfflineTopologySessions?.();
  host.invalidateDesktopStateSnapshot?.();
  host.refreshLocalDashboardModel?.();
  host.writeStatuslineFile?.({ force: true });
  host.metadataServer?.notifyChange?.();
  if (host.mode === "dashboard") {
    host.renderCurrentDashboardView?.();
  }
}

function recordDashboardFailure(
  host: any,
  input: {
    targetKind: "worktree" | "agent" | "service" | "dashboard";
    operation: string;
    title: string;
    message: string;
    targetId?: string;
    worktreePath?: string;
    worktreeName?: string;
  },
): DashboardOperationFailure {
  const failure = addDashboardOperationFailure(input);
  host.publishAlert?.({
    kind: "task_failed",
    title: input.title,
    message: input.message,
    worktreePath: input.worktreePath,
    dedupeKey: `dashboard-operation-failed:${input.targetKind}:${input.operation}:${input.targetId ?? input.worktreePath ?? input.title}:${input.message}`,
  });
  return failure;
}

function refreshDashboardWorktreeProjection(host: any): void {
  host.invalidateDesktopStateSnapshot();
  host.refreshLocalDashboardModel();
  host.metadataServer?.notifyChange?.();
  if (host.mode === "dashboard") {
    host.renderDashboard();
  }
}

function orderStatuslineItemsByWorktree<T extends { id: string; worktreePath?: string }>(
  items: T[],
  orderForWorktree: (items: T[], worktreePath: string | undefined) => T[],
): T[] {
  const grouped = new Map<string, { worktreePath: string | undefined; items: T[] }>();
  for (const item of items) {
    const key = item.worktreePath ?? "__main__";
    const group = grouped.get(key) ?? { worktreePath: item.worktreePath, items: [] };
    group.items.push(item);
    grouped.set(key, group);
  }
  return [...grouped.values()].flatMap((group) => orderForWorktree(group.items, group.worktreePath));
}

function exchangeTaskCounts(): { pending: number; assigned: number } {
  try {
    const exchange = createRuntimeExchangeStore().read();
    return {
      pending: exchange.tasks.filter((task) => task.status === "pending").length,
      assigned: exchange.tasks.filter(
        (task) => task.status === "assigned" || task.status === "in_progress" || task.status === "blocked",
      ).length,
    };
  } catch {
    return { pending: 0, assigned: 0 };
  }
}

export const persistenceMethods = {
  async cleanupGraveyard(
    this: any,
    input?: { dryRun?: boolean; now?: Date | string },
  ): Promise<GraveyardCleanupRunResult> {
    const plan = buildGraveyardCleanupPlan({ now: input?.now });
    const result = await runGraveyardCleanup(
      plan,
      {
        deleteAgent: (sessionId) => {
          const deleted = deleteGraveyardAgent(sessionId);
          this.offlineSessions = (this.offlineSessions ?? []).filter((session: any) => session.id !== sessionId);
          return deleted;
        },
        deleteWorktree: (path) => this.deleteGraveyardWorktree(path),
      },
      { dryRun: input?.dryRun === true },
    );
    const changed = result.results.some((item) => item.status === "removed");
    if (changed && input?.dryRun !== true) {
      refreshAfterGraveyardCleanup(this);
    }
    return result;
  },
  startGraveyardCleanup(this: any): void {
    if (this.graveyardCleanupInterval) return;
    const graveyardConfig = loadConfig().graveyard;
    if (graveyardConfig.cleanupEnabled === false) return;
    const intervalMs = normalizeGraveyardCleanupIntervalMs(graveyardConfig.cleanupIntervalMs);
    this.graveyardCleanupInterval = setInterval(() => {
      if (this.graveyardCleanupRunning) return;
      this.graveyardCleanupRunning = true;
      void this.cleanupGraveyard()
        .catch((error: unknown) => {
          debug(`graveyard cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "graveyard");
        })
        .finally(() => {
          this.graveyardCleanupRunning = false;
        });
    }, intervalMs);
  },
  stopGraveyardCleanup(this: any): void {
    if (!this.graveyardCleanupInterval) return;
    clearInterval(this.graveyardCleanupInterval);
    this.graveyardCleanupInterval = null;
  },
  async cleanupInbox(this: any, input?: { dryRun?: boolean; now?: Date | string }): Promise<InboxCleanupRunResult> {
    const plan = buildInboxCleanupPlan({ now: input?.now, protectedIds: actionableUnreadNotificationIds(this) });
    const result = runInboxCleanup(plan, {}, { dryRun: input?.dryRun === true });
    const changed = result.results.some((item) => item.status === "cleared");
    if (changed && input?.dryRun !== true) {
      this.metadataServer?.notifyChange?.();
      if (this.isDashboardScreen?.("coordination")) {
        void this.refreshCoordinationFromService?.()
          .then(() => this.renderCurrentDashboardView?.())
          .catch(() => {});
      }
    }
    return result;
  },
  startInboxCleanup(this: any): void {
    if (this.inboxCleanupInterval) return;
    const inboxConfig = loadConfig().inbox;
    if (inboxConfig.cleanupEnabled === false) return;
    const intervalMs = normalizeInboxCleanupIntervalMs(inboxConfig.cleanupIntervalMs);
    this.inboxCleanupInterval = setInterval(() => {
      if (this.inboxCleanupRunning) return;
      this.inboxCleanupRunning = true;
      void this.cleanupInbox()
        .catch((error: unknown) => {
          debug(`inbox cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "notification");
        })
        .finally(() => {
          this.inboxCleanupRunning = false;
        });
    }, intervalMs);
  },
  stopInboxCleanup(this: any): void {
    if (!this.inboxCleanupInterval) return;
    clearInterval(this.inboxCleanupInterval);
    this.inboxCleanupInterval = null;
  },
  writeStatuslineFile(this: any, input?: { force?: boolean }): void {
    try {
      if (this.mode !== "project-service") return;
      this.repairManagedTmuxTargets();
      for (const session of this.sessions) {
        this.syncTmuxWindowMetadata(session.id);
      }
      this.dashboardUiStateStore.loadSharedState(this.dashboardState);
      this.refreshDesktopStateSnapshot();
      const dir = getProjectStateDir();
      const filePath = join(dir, "statusline.json");
      const data = this.buildStatuslineSnapshot();
      const { updatedAt: _updatedAt, ...stableData } = data;
      const snapshotKey = JSON.stringify(stableData);
      if (!input?.force && snapshotKey === this.lastStatuslineSnapshotKey) {
        return;
      }
      this.lastStatuslineSnapshotKey = snapshotKey;
      writeTextAtomic(filePath, JSON.stringify(data) + "\n");
      this.writePrecomputedTmuxStatuslineFiles(data);
      this.tmuxRuntimeManager.refreshStatus();
    } catch {}
  },

  repairManagedTmuxTargets(this: any): void {
    const managedWindows = this.tmuxRuntimeManager.listProjectManagedWindows(process.cwd());
    const liveTargets = new Map<string, any>();
    for (const { target, metadata } of managedWindows) {
      if (metadata.kind !== "agent") continue;
      liveTargets.set(metadata.sessionId, target);
    }
    for (const session of this.sessions) {
      const target = liveTargets.get(session.id);
      if (!target) continue;
      this.sessionTmuxTargets.set(session.id, target);
      if (session.transport instanceof Object && typeof session.transport.retarget === "function") {
        session.transport.retarget(target);
      }
    }
  },

  refreshProjectStatusline(this: any, _input?: { sessionId?: string; force?: boolean }): { ok: true } {
    if (_input?.force) {
      invalidateTmuxStatuslineArtifacts(process.cwd());
      this.lastStatuslineSnapshotKey = null;
    }
    this.repairManagedTmuxTargets();
    this.invalidateDesktopStateSnapshot();
    this.writeStatuslineFile({ force: _input?.force === true });
    return { ok: true };
  },

  getTmuxStatuslineDir(this: any): string {
    return ensureTmuxStatuslineDir();
  },

  writeStatuslineTextFile(this: any, name: string, content: string): void {
    // Cosmetic per-window statusline text, written concurrently from the refresh
    // path: unique-temp atomic write (never a shared ".tmp"), and never fatal.
    try {
      writeTextAtomic(join(this.getTmuxStatuslineDir(), name), `${content}\n`);
    } catch (error) {
      debug(
        `statusline write failed for ${name}: ${error instanceof Error ? error.message : String(error)}`,
        "statusline",
      );
    }
  },

  writePrecomputedTmuxStatuslineFiles(this: any, data: ReturnType<any["buildStatuslineSnapshot"]>): void {
    const dashboardTop = renderTmuxStatuslineFromData(data, process.cwd(), "top", {
      currentWindow: "dashboard",
      currentPath: process.cwd(),
    });
    const dashboardBottom = renderTmuxStatuslineFromData(data, process.cwd(), "bottom", {
      currentWindow: "dashboard",
      currentPath: process.cwd(),
    });
    this.writeStatuslineTextFile("top-dashboard.txt", dashboardTop);
    this.writeStatuslineTextFile("bottom-dashboard.txt", dashboardBottom);

    for (const entry of [...data.sessions, ...(data.teammates ?? [])]) {
      if (!entry.tmuxWindowId) continue;
      const renderOptions = {
        currentWindow: entry.windowName,
        currentWindowId: entry.tmuxWindowId,
        currentPath: entry.worktreePath ?? process.cwd(),
      };
      const top = renderTmuxStatuslineFromData(data, process.cwd(), "top", renderOptions);
      const bottom = renderTmuxStatuslineFromData(data, process.cwd(), "bottom", renderOptions);
      this.writeStatuslineTextFile(`top-${entry.tmuxWindowId}.txt`, top);
      this.writeStatuslineTextFile(`bottom-${entry.tmuxWindowId}.txt`, bottom);
    }
  },

  writeDashboardClientStatuslineFile(this: any): void {
    if (this.mode !== "dashboard") return;
    const clientSession = this.tmuxRuntimeManager.currentClientSession();
    if (!clientSession) return;
    const localData = loadStatusline(process.cwd()) ?? {
      project: basename(process.cwd()),
      sessions: [],
      metadata: {},
      tasks: exchangeTaskCounts(),
      controlPlane: { daemonAlive: true, projectServiceAlive: false },
      flash: null,
      updatedAt: new Date().toISOString(),
    };
    const data = { ...localData, dashboardScreen: this.dashboardState.screen };
    const bottom = renderTmuxStatuslineFromData(data, process.cwd(), "bottom", {
      currentSession: clientSession,
      currentWindow: this.tmuxRuntimeManager.displayMessage("#{window_name}") ?? "dashboard",
      currentPath: process.cwd(),
    });
    this.writeStatuslineTextFile(`bottom-dashboard-${clientSession}.txt`, bottom);
  },

  buildStatuslineSnapshot(this: any): {
    project: string;
    dashboardScreen: DashboardScreen;
    sessions: Array<{
      id: string;
      kind?: "agent" | "service";
      tool: string;
      label?: string;
      tmuxWindowId?: string;
      tmuxWindowIndex?: number;
      windowName: string;
      headline?: string;
      status: string;
      role?: string;
      active: boolean;
      worktreePath?: string;
      launchCommandLine?: string;
    }>;
    teammates: Array<{
      id: string;
      kind?: "agent" | "service";
      tool: string;
      label?: string;
      tmuxWindowId?: string;
      tmuxWindowIndex?: number;
      windowName: string;
      headline?: string;
      status: string;
      role?: string;
      active: boolean;
      worktreePath?: string;
      team?: DashboardSession["team"];
    }>;
    tasks: { pending: number; assigned: number };
    controlPlane: {
      daemonAlive: boolean;
      projectServiceAlive: boolean;
    };
    flash: string | null;
    metadata: ReturnType<typeof loadMetadataState>["sessions"];
    updatedAt: string;
  } {
    const desktopState = this.desktopStateSnapshot ?? this.buildDesktopStateSnapshot();
    const orderedSessions = orderStatuslineItemsByWorktree(desktopState.sessions, (sessions, worktreePath) =>
      this.dashboardUiStateStore.orderSessionsForWorktree(sessions, worktreePath),
    );
    const teammateSessions = this.dashboardPendingActions
      .applyToSessions(desktopState.teammates ?? [], { includeTeammates: true })
      .filter((session: DashboardSession) => isTeammateSession(session));
    const orderedTeammates = orderStatuslineItemsByWorktree(teammateSessions, (sessions, worktreePath) =>
      this.dashboardUiStateStore.orderSessionsForWorktree(sessions, worktreePath),
    );
    const orderedServices = orderStatuslineItemsByWorktree(desktopState.services, (services, worktreePath) =>
      this.dashboardUiStateStore.orderServicesForWorktree(services, worktreePath),
    );
    return {
      project: basename(process.cwd()),
      dashboardScreen: this.dashboardState.screen,
      sessions: [
        ...orderedSessions.map((session: any) => ({
          id: session.id,
          kind: "agent" as const,
          tool: session.command,
          label: session.label,
          tmuxWindowId: session.tmuxWindowId,
          tmuxWindowIndex: session.tmuxWindowIndex,
          windowName: session.command,
          headline: session.headline,
          status: session.status,
          role: session.role,
          active: session.active,
          worktreePath: session.worktreePath,
          semantic: session.semantic,
        })),
        ...orderedServices.map((service: any) => ({
          id: service.id,
          kind: "service" as const,
          tool: service.command,
          label: service.label,
          tmuxWindowId: service.tmuxWindowId,
          tmuxWindowIndex: service.tmuxWindowIndex,
          windowName: service.command,
          headline: service.previewLine,
          status: service.status,
          active: service.active,
          worktreePath: service.worktreePath,
          launchCommandLine: service.launchCommandLine,
        })),
      ],
      teammates: orderedTeammates.map((session: any) => ({
        id: session.id,
        kind: "agent" as const,
        tool: session.command,
        label: session.label,
        tmuxWindowId: session.tmuxWindowId,
        tmuxWindowIndex: session.tmuxWindowIndex,
        windowName: session.command,
        headline: session.headline,
        status: session.status,
        role: session.role,
        active: session.active,
        worktreePath: session.worktreePath,
        semantic: session.semantic,
        team: session.team,
      })),
      tasks: exchangeTaskCounts(),
      controlPlane: {
        daemonAlive: Boolean(loadDaemonInfo()),
        projectServiceAlive: true,
      },
      flash: this.footerFlash,
      metadata: loadMetadataState().sessions,
      updatedAt: new Date().toISOString(),
    };
  },

  buildDesktopState(this: any): {
    sessions: DashboardSession[];
    teammates: DashboardSession[];
    services: DashboardService[];
    statusline: ReturnType<any["buildStatuslineSnapshot"]>;
    worktrees: Array<{ name: string; path: string; branch: string; isBare: boolean }>;
    worktreeGroups: WorktreeGroup[];
    operationFailures: DashboardOperationFailure[];
    mainCheckoutInfo: { name: string; branch: string };
    mainCheckoutPath?: string;
  } {
    if (!this.desktopStateSnapshot) {
      this.refreshDesktopStateSnapshot();
    }
    const desktopState = this.desktopStateSnapshot ?? this.buildDesktopStateSnapshot();
    const sessions = this.dashboardPendingActions.applyToSessions(desktopState.sessions);
    const teammates = this.dashboardPendingActions
      .applyToSessions(desktopState.teammates ?? [], { includeTeammates: true })
      .filter((session: DashboardSession) => isTeammateSession(session));
    const services = this.dashboardPendingActions.applyToServices(desktopState.services);
    const worktrees = this.dashboardPendingActions.applyToWorktrees(desktopState.worktrees);
    const worktreeGroups = composeDashboardWorktreeGroups(
      this.dashboardPendingActions.applyToWorktrees(desktopState.worktreeGroups ?? desktopState.worktrees),
      sessions,
      services,
    );
    return {
      sessions,
      teammates,
      services,
      statusline: this.buildStatuslineSnapshot(),
      worktrees,
      worktreeGroups,
      operationFailures: desktopState.operationFailures,
      mainCheckoutInfo: desktopState.mainCheckoutInfo,
      mainCheckoutPath: desktopState.mainCheckoutPath,
    };
  },

  reapplyDashboardPendingActions(this: any): void {
    this.dashboardSessionsCache = this.dashboardPendingActions.applyToSessions(
      this.dashboardSessionsCache.map(
        ({
          pending: _pending,
          pendingAction: _pendingAction,
          pendingStartedAt: _pendingStartedAt,
          optimistic: _optimistic,
          ...session
        }: any) => session,
      ),
    );
    this.dashboardTeammatesCache = this.dashboardPendingActions
      .applyToSessions(
        (this.dashboardTeammatesCache ?? []).map(
          ({
            pending: _pending,
            pendingAction: _pendingAction,
            pendingStartedAt: _pendingStartedAt,
            optimistic: _optimistic,
            ...session
          }: any) => session,
        ),
        { includeTeammates: true },
      )
      .filter((session: DashboardSession) => isTeammateSession(session));
    this.dashboardServicesCache = this.dashboardPendingActions.applyToServices(
      this.dashboardServicesCache.map(
        ({
          pending: _pending,
          pendingAction: _pendingAction,
          pendingStartedAt: _pendingStartedAt,
          optimistic: _optimistic,
          ...service
        }: any) => service,
      ),
    );
    this.dashboardWorktreeGroupsCache = this.dashboardUiStateStore.orderWorktreeGroups(
      composeDashboardWorktreeGroups(
        this.dashboardPendingActions.applyToWorktrees(
          this.dashboardWorktreeGroupsCache.map(
            ({
              pendingAction: _pendingAction,
              pendingStartedAt: _pendingStartedAt,
              optimistic: _optimistic,
              pending: _pending,
              removing: _removing,
              ...wt
            }: any) => wt,
          ),
        ),
        this.dashboardSessionsCache,
        this.dashboardServicesCache,
      ),
    );
  },

  listDesktopWorktrees(this: any): Array<{
    name: string;
    path: string;
    branch: string;
    isBare: boolean;
    createdAt?: string;
    pending?: boolean;
    removing?: boolean;
    pendingAction?: Extract<PendingWorktreeActionKind, "creating">;
    operationFailure?: DashboardOperationFailure;
  }> {
    const hiddenPaths = listWorktreeGraveyardPaths();
    const worktrees: Array<{
      name: string;
      path: string;
      branch: string;
      isBare: boolean;
      createdAt?: string;
      pending?: boolean;
      removing?: boolean;
      pendingAction?: Extract<PendingWorktreeActionKind, "creating">;
      operationFailure?: DashboardOperationFailure;
    }> = listAllWorktrees()
      .filter((wt) => !wt.isBare && !hiddenPaths.has(wt.path) && !isToolInternalWorktree(wt))
      .map((wt) => ({
        ...wt,
      }));
    const worktreePaths = new Set(worktrees.map((worktree) => worktree.path));
    for (const failure of listDashboardOperationFailures()) {
      if (failure.targetKind !== "worktree" || failure.operation !== "create" || !failure.worktreePath) continue;
      if (hiddenPaths.has(failure.worktreePath) || worktreePaths.has(failure.worktreePath)) continue;
      worktrees.push({
        name: failure.worktreeName ?? basename(failure.worktreePath),
        path: failure.worktreePath,
        branch: "(failed)",
        isBare: false,
        createdAt: failure.createdAt,
        operationFailure: failure,
      });
      worktreePaths.add(failure.worktreePath);
    }
    sortDesktopWorktrees(worktrees);
    return worktrees;
  },

  listProjectedDesktopWorktrees(this: any): Array<{
    name: string;
    path: string;
    branch: string;
    isBare: boolean;
    createdAt?: string;
    pending?: boolean;
    removing?: boolean;
    pendingAction?: Extract<PendingWorktreeActionKind, "creating" | "removing" | "graveyarding">;
    operationFailure?: DashboardOperationFailure;
  }> {
    return this.dashboardPendingActions.applyToWorktrees(this.listDesktopWorktrees() as any);
  },

  listWorktreeGraveyardEntries(this: any): any[] {
    return listWorktreeGraveyardEntriesImpl();
  },

  async graveyardDesktopWorktree(this: any, path: string): Promise<{ path: string; status: "graveyarded" }> {
    const mainRepo = findMainRepo();
    if (path === mainRepo) {
      throw new Error("Cannot graveyard the main checkout");
    }
    const matching = this.listDesktopWorktrees().find((worktree: any) => worktree.path === path);
    if (!matching) {
      throw new Error(`Worktree "${path}" not found`);
    }
    const attachedSession = this.sessions?.find(
      (session: any) => this.sessionWorktreePaths?.get(session.id) === path && this.isSessionRuntimeLive?.(session),
    );
    if (attachedSession) {
      throw new Error(
        `Cannot graveyard "${matching.name}" while agent "${attachedSession.label || attachedSession.id}" is attached`,
      );
    }
    stopWorktreeServicesForGraveyard(this, path);
    upsertTopologyWorktree(
      {
        path,
        name: matching.name,
        branch: matching.branch,
        createdAt: matching.createdAt,
      },
      "active",
    );
    const moved = moveTopologyWorktreeToGraveyard(path, { reason: "user-requested" });
    if (!moved) {
      throw new Error(`Unable to graveyard worktree "${path}"`);
    }
    this.saveState?.();
    this.invalidateDesktopStateSnapshot?.();
    this.refreshLocalDashboardModel?.();
    this.metadataServer?.notifyChange?.();
    return { path, status: "graveyarded" };
  },

  async resurrectGraveyardWorktree(this: any, path: string): Promise<{ path: string; status: "active" }> {
    if (!existsSync(path)) {
      throw new Error(`Cannot resurrect worktree "${path}" because the checkout is missing`);
    }
    const resurrected = resurrectTopologyWorktreeFromGraveyard(path);
    if (!resurrected) {
      throw new Error(`Graveyard worktree "${path}" not found`);
    }
    this.invalidateDesktopStateSnapshot?.();
    this.refreshLocalDashboardModel?.();
    this.metadataServer?.notifyChange?.();
    return { path, status: "active" };
  },

  async deleteGraveyardWorktree(this: any, path: string): Promise<{ path: string; status: "removed" }> {
    const existing = listTopologyWorktreeGraveyard().find((entry) => entry.path === path);
    if (!existing) {
      throw new Error(`Graveyard worktree "${path}" not found`);
    }
    const mainRepo = findMainRepo();
    if (path === mainRepo) {
      throw new Error("Cannot remove the main checkout");
    }
    if (existsSync(path)) {
      await removeGraveyardedDesktopWorktree(this, mainRepo, path);
    } else {
      await pruneGitWorktrees(mainRepo);
      removeWorktreeDependents(this, path);
      removeTopologyWorktree(path);
      this.saveState?.();
      await pruneGitWorktrees(mainRepo);
    }
    deleteTopologyWorktreeGraveyardEntry(path);
    this.invalidateDesktopStateSnapshot?.();
    this.refreshLocalDashboardModel?.();
    this.metadataServer?.notifyChange?.();
    return { path, status: "removed" };
  },

  createDesktopWorktree(this: any, name: string): { path: string; status: "creating" | "created" } {
    const targetPath = getWorktreeCreatePath(name);
    const pendingCreates = this.pendingWorktreeCreates as Map<
      string,
      Promise<{ path: string; status: "creating" | "created" }>
    >;
    const existingCreate = pendingCreates.get(targetPath);
    if (existingCreate) {
      return { path: targetPath, status: "creating" };
    }
    if (
      this.listDesktopWorktrees().some(
        (worktree: any) => worktree.path === targetPath && !worktree.pending && !worktree.operationFailure,
      )
    ) {
      throw new Error(`Worktree "${name}" already exists`);
    }
    clearDashboardOperationFailures({ targetKind: "worktree", operation: "create", worktreePath: targetPath });

    let resolveCreate!: (value: { path: string; status: "creating" | "created" }) => void;
    let rejectCreate!: (reason?: unknown) => void;
    const createPromise = new Promise<{ path: string; status: "creating" | "created" }>((resolve, reject) => {
      resolveCreate = resolve;
      rejectCreate = reject;
    });
    pendingCreates.set(targetPath, createPromise);
    const createStartedAt = Date.now();
    this.worktreeCreateJob = {
      path: targetPath,
      name,
      startedAt: createStartedAt,
    };
    upsertTopologyWorktree(
      {
        path: targetPath,
        name,
        branch: name,
        createdAt: new Date(createStartedAt).toISOString(),
      },
      "creating",
    );
    const clearPendingCreate = () => {
      if (pendingCreates.get(targetPath) === createPromise) {
        pendingCreates.delete(targetPath);
      }
      if (this.worktreeCreateJob?.path === targetPath) {
        this.worktreeCreateJob = null;
      }
    };
    this.dashboardPendingActions.setWorktreeAction(targetPath, "creating", {
      worktreeSeed: {
        name,
        branch: name,
        path: targetPath,
        createdAt: new Date(createStartedAt).toISOString(),
        status: "offline",
        isBare: false,
        sessions: [],
        services: [],
      },
      timeoutMs: 180_000,
      onTimeout: () => {
        clearPendingCreate();
        const message = `Timed out creating worktree "${name}"`;
        recordDashboardFailure(this, {
          targetKind: "worktree",
          operation: "create",
          title: `Failed to create worktree "${name}"`,
          message,
          worktreePath: targetPath,
          worktreeName: name,
        });
        this.footerFlash = message;
        this.footerFlashTicks = 5;
        this.invalidateDesktopStateSnapshot();
        this.refreshLocalDashboardModel();
        if (this.mode === "dashboard") {
          this.renderDashboard();
        }
      },
    });
    this.invalidateDesktopStateSnapshot();
    this.refreshLocalDashboardModel();
    if (this.mode === "dashboard") {
      this.renderDashboard();
    }

    void (async () => {
      try {
        const mainRepo = findMainRepo();
        await new Promise<void>((resolve, reject) => {
          let stderr = "";
          let child;
          try {
            child = spawn("git", getWorktreeAddArgs(name, targetPath, mainRepo), {
              cwd: mainRepo,
              stdio: ["ignore", "ignore", "pipe"],
            });
          } catch (error) {
            reject(error);
            return;
          }

          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });

          child.on("error", reject);
          child.on("close", (code: number | null) => {
            if (code === 0) {
              resolve();
              return;
            }
            const detail = stderr
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .at(-1);
            reject(new Error(detail || `git worktree add exited with code ${code ?? 1}`));
          });
        });
        upsertTopologyWorktree(
          {
            path: targetPath,
            name,
            branch: name,
            basePath: mainRepo,
            createdAt: new Date(createStartedAt).toISOString(),
          },
          "active",
        );
        resolveCreate({ path: targetPath, status: "created" });
      } catch (error) {
        upsertTopologyWorktree(
          {
            path: targetPath,
            name,
            branch: name,
            createdAt: new Date(createStartedAt).toISOString(),
            operationFailure: error instanceof Error ? error.message : String(error),
          },
          "error",
        );
        rejectCreate(error);
      }
    })();

    void createPromise
      .then(() => {
        clearDashboardOperationFailures({ targetKind: "worktree", operation: "create", worktreePath: targetPath });
        this.footerFlash = `Created: ${name}`;
        this.footerFlashTicks = 3;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        recordDashboardFailure(this, {
          targetKind: "worktree",
          operation: "create",
          title: `Failed to create worktree "${name}"`,
          message,
          worktreePath: targetPath,
          worktreeName: name,
        });
        this.footerFlash = `Failed: ${message}`;
        this.footerFlashTicks = 5;
        if (this.mode === "dashboard") {
          this.showDashboardError(`Failed to create "${name}"`, [`Path: ${targetPath}`, `Error: ${message}`]);
        }
      });

    const finalizeCreate = () => {
      clearPendingCreate();
      this.dashboardPendingActions.clearWorktreeAction(targetPath);
      this.invalidateDesktopStateSnapshot();
      this.refreshLocalDashboardModel();
      this.metadataServer?.notifyChange?.();
      if (this.mode === "dashboard") {
        this.renderDashboard();
      }
    };
    void createPromise.then(finalizeCreate, finalizeCreate);

    return { path: targetPath, status: "creating" };
  },

  async removeDesktopWorktree(this: any, path: string): Promise<{ path: string; status: "removing" | "removed" }> {
    const pendingRemovals = this.pendingWorktreeRemovals as Map<
      string,
      Promise<{ path: string; status: "removing" | "removed" }>
    >;
    const setRemovePending = () => {
      this.dashboardPendingActions.setWorktreeAction(path, "removing", {
        timeoutMs: 180_000,
        onTimeout: () => {
          const name = path.split("/").pop() ?? path;
          const message = `Timed out removing worktree "${name}"`;
          recordDashboardFailure(this, {
            targetKind: "worktree",
            operation: "remove",
            title: `Failed to remove worktree "${name}"`,
            message,
            worktreePath: path,
            worktreeName: name,
          });
          this.footerFlash = message;
          this.footerFlashTicks = 5;
          refreshDashboardWorktreeProjection(this);
        },
      });
      refreshDashboardWorktreeProjection(this);
    };
    const existingRemoval = pendingRemovals.get(path);
    if (existingRemoval) {
      setRemovePending();
      return existingRemoval;
    }

    let resolveRemoval!: (value: { path: string; status: "removing" | "removed" }) => void;
    let rejectRemoval!: (reason?: unknown) => void;
    const removalPromise = new Promise<{ path: string; status: "removing" | "removed" }>((resolve, reject) => {
      resolveRemoval = resolve;
      rejectRemoval = reject;
    });
    pendingRemovals.set(path, removalPromise);
    setRemovePending();

    let startedRemoval = false;
    void (async () => {
      try {
        this.syncSessionsFromTopology();

        const mainRepo = findMainRepo();
        if (path === mainRepo) {
          throw new Error("Cannot remove the main checkout");
        }

        if (!existsSync(path)) {
          await removeOrphanedDesktopWorktree(this, mainRepo, path);
          removeTopologyWorktree(path);
          clearDashboardOperationFailures({ targetKind: "worktree", operation: "remove", worktreePath: path });
          resolveRemoval({ path, status: "removed" });
          return;
        }

        const matching = this.listDesktopWorktrees().find((worktree: any) => worktree.path === path);
        if (!matching) {
          const worktreeBaseDir = getWorktreeBaseDir();
          if (path.startsWith(`${worktreeBaseDir}/`) || path === worktreeBaseDir) {
            await removeOrphanedDesktopWorktree(this, mainRepo, path);
            removeTopologyWorktree(path);
            clearDashboardOperationFailures({ targetKind: "worktree", operation: "remove", worktreePath: path });
            resolveRemoval({ path, status: "removed" });
            return;
          }
          throw new Error(`Worktree "${path}" not found`);
        }

        const attachedSession = this.sessions.find(
          (session: any) => this.sessionWorktreePaths?.get(session.id) === path && this.isSessionRuntimeLive(session),
        );
        if (attachedSession) {
          throw new Error(
            `Cannot remove "${matching.name}" while agent "${attachedSession.label || attachedSession.id}" is attached`,
          );
        }
        upsertTopologyWorktree(
          {
            path,
            name: matching.name,
            branch: matching.branch,
            createdAt: matching.createdAt,
          },
          "removing",
        );
        startedRemoval = true;
        detachWorktreeServices(this, path);

        await new Promise<void>((resolve, reject) => {
          let stderr = "";
          let child;
          try {
            child = spawn("git", ["worktree", "remove", path, "--force"], {
              cwd: mainRepo,
              stdio: ["ignore", "ignore", "pipe"],
            });
          } catch (error) {
            reject(error);
            return;
          }

          child.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            stderr += text;
            if (this.worktreeRemovalJob?.path === path) {
              this.worktreeRemovalJob.stderr = stderr;
              if (this.mode === "dashboard") {
                this.renderDashboard();
              }
            }
          });

          child.on("error", reject);
          child.on("close", (code: number | null) => {
            if (code === 0) {
              resolve();
              return;
            }
            const detail = stderr
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .at(-1);
            reject(new Error(detail || `git worktree remove exited with code ${code ?? 1}`));
          });
        });

        removeWorktreeDependents(this, path);
        removeTopologyWorktree(path);
        this.saveState();
        clearDashboardOperationFailures({ targetKind: "worktree", operation: "remove", worktreePath: path });
        resolveRemoval({ path, status: "removed" });
      } catch (error) {
        if (startedRemoval) {
          upsertTopologyWorktree(
            {
              path,
              name: path.split("/").pop() ?? path,
              operationFailure: error instanceof Error ? error.message : String(error),
            },
            "error",
          );
        }
        rejectRemoval(error);
      }
    })();

    void removalPromise.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const name = path.split("/").pop() ?? path;
      recordDashboardFailure(this, {
        targetKind: "worktree",
        operation: "remove",
        title: `Failed to remove worktree "${name}"`,
        message,
        worktreePath: path,
        worktreeName: name,
      });
      this.footerFlash = `Failed: ${message}`;
      this.footerFlashTicks = 5;
    });

    const finalizeRemoval = () => {
      this.dashboardPendingActions.clearWorktreeAction(path);
      pendingRemovals.delete(path);
      refreshDashboardWorktreeProjection(this);
    };
    void removalPromise.then(finalizeRemoval, finalizeRemoval);

    return removalPromise;
  },

  listGraveyardEntries(this: any): any[] {
    return listTopologySessionStates({ statuses: ["graveyard"] });
  },

  async resurrectGraveyardSession(this: any, sessionId: string): Promise<{ sessionId: string; status: "offline" }> {
    const graveyarded = listTopologySessionStates({ statuses: ["graveyard"] }).find((s: any) => s.id === sessionId);
    if (!graveyarded) {
      throw new Error(`Graveyard session "${sessionId}" not found`);
    }
    const worktreePath = graveyarded.worktreePath;
    if (worktreePath && !listWorktreeGraveyardPaths().has(worktreePath) && !existsSync(worktreePath)) {
      throw new Error(
        `Cannot resurrect agent "${sessionId}" because its worktree "${worktreePath}" is missing; restore the worktree first`,
      );
    }
    const restored = resurrectTopologySession(sessionId);
    if (!restored) {
      throw new Error(`Graveyard session "${sessionId}" not found`);
    }
    const offlineEntry = { ...restored, lifecycle: "offline" as const, status: "offline" as const };
    if (Array.isArray(this.offlineSessions)) {
      const existingIndex = this.offlineSessions.findIndex((session: any) => session.id === sessionId);
      if (existingIndex >= 0) {
        this.offlineSessions[existingIndex] = { ...this.offlineSessions[existingIndex], ...offlineEntry };
      } else {
        this.offlineSessions.push(offlineEntry);
      }
    }
    this.loadOfflineTopologySessions?.();
    this.invalidateDesktopStateSnapshot?.();
    this.writeStatuslineFile?.();
    this.metadataServer?.notifyChange?.();
    if (this.mode === "dashboard") {
      this.renderCurrentDashboardView?.();
    }
    return { sessionId, status: "offline" };
  },

  stripAnsi(this: any, text: string): string {
    return text.replace(/\u001B\[[0-9;]*m/g, "");
  },

  centerInWidth(this: any, text: string, width: number): string {
    const pad = Math.max(0, Math.floor((width - this.stripAnsi(text).length) / 2));
    return " ".repeat(pad) + text;
  },

  renderCurrentDashboardView(this: any): void {
    renderCurrentDashboardViewImpl(this);
  },
};

export type PersistenceMethods = typeof persistenceMethods;

async function pruneGitWorktrees(mainRepo: string): Promise<void> {
  try {
    const child = spawn("git", ["worktree", "prune"], {
      cwd: mainRepo,
      stdio: ["ignore", "ignore", "ignore"],
    });
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
    });
  } catch {}
}

function sortDesktopWorktrees(
  worktrees: Array<{
    name: string;
    path: string;
    branch: string;
    isBare: boolean;
    createdAt?: string;
  }>,
): void {
  let mainRepo: string | undefined;
  try {
    mainRepo = findMainRepo();
  } catch {}
  worktrees.sort((a, b) => {
    const aMain = a.path === mainRepo;
    const bMain = b.path === mainRepo;
    if (aMain !== bMain) return aMain ? -1 : 1;
    const aCreated = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
    const bCreated = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
    if (Number.isFinite(aCreated) || Number.isFinite(bCreated)) {
      return (Number.isFinite(bCreated) ? bCreated : 0) - (Number.isFinite(aCreated) ? aCreated : 0);
    }
    return a.name.localeCompare(b.name);
  });
}

async function removeOrphanedDesktopWorktree(host: any, mainRepo: string, path: string): Promise<void> {
  await pruneGitWorktrees(mainRepo);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
  await pruneGitWorktrees(mainRepo);
  removeWorktreeDependents(host, path);
  host.saveState();
}

async function removeGraveyardedDesktopWorktree(host: any, mainRepo: string, path: string): Promise<void> {
  await removeGitWorktreeCheckout(mainRepo, path);
  removeWorktreeDependents(host, path);
  removeTopologyWorktree(path);
  host.saveState?.();
}

async function removeGitWorktreeCheckout(mainRepo: string, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    let child;
    try {
      child = spawn("git", ["worktree", "remove", path, "--force"], {
        cwd: mainRepo,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      reject(new Error(detail || `git worktree remove exited with code ${code ?? 1}`));
    });
  });
}

function detachWorktreeServices(host: any, path: string): void {
  for (const { target, metadata } of host.tmuxRuntimeManager.listProjectManagedWindows(process.cwd())) {
    if (metadata.kind !== "service" || metadata.worktreePath !== path) continue;
    markLifecycleUsed(host, metadata.sessionId);
    try {
      host.tmuxRuntimeManager.killWindow(target);
    } catch {}
  }

  host.offlineServices = host.offlineServices.filter((service: any) => service.worktreePath !== path);
  removeTopologyServicesForWorktree(path);
  removePersistedServicesForWorktree(path);
}

function stopWorktreeServicesForGraveyard(host: any, path: string): void {
  for (const { target, metadata } of host.tmuxRuntimeManager.listProjectManagedWindows(process.cwd())) {
    if (metadata.kind !== "service" || metadata.worktreePath !== path) continue;
    markLifecycleUsed(host, metadata.sessionId);
    try {
      host.tmuxRuntimeManager.killWindow(target);
    } catch {}
    const serviceState = {
      id: metadata.sessionId,
      command: metadata.command,
      args: metadata.args ?? [],
      launchCommandLine: metadata.launchCommandLine,
      worktreePath: metadata.worktreePath,
      cwd: metadata.worktreePath,
      label: metadata.label,
      createdAt: metadata.createdAt,
    };
    upsertTopologyService(serviceState, "stopped");
    host.offlineServices ??= [];
    const existingIndex = host.offlineServices.findIndex((service: any) => service.id === metadata.sessionId);
    if (existingIndex >= 0) {
      host.offlineServices[existingIndex] = { ...host.offlineServices[existingIndex], ...serviceState };
    } else {
      host.offlineServices.push(serviceState);
    }
  }
}

function removeWorktreeDependents(host: any, path: string): void {
  cleanupAgentAssetsForWorktree(path);
  host.offlineSessions = (host.offlineSessions ?? []).filter((session: any) => session.worktreePath !== path);
  host.offlineServices = (host.offlineServices ?? []).filter((service: any) => service.worktreePath !== path);
  removeTopologySessionsForWorktree(path);
  removeTopologyServicesForWorktree(path);
  removePersistedServicesForWorktree(path);
}

function cleanupAgentAssetsForWorktree(path: string): void {
  for (const session of listTopologySessionStates()) {
    if (session.worktreePath !== path) continue;
    deleteAgentAssets(session.id);
  }
}

function removePersistedServicesForWorktree(path: string): void {
  const statePath = getStatePath();
  if (!existsSync(statePath)) return;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as { services?: Array<{ worktreePath?: string }> };
    const nextServices = (state.services ?? []).filter((service) => service.worktreePath !== path);
    if (nextServices.length === (state.services ?? []).length) return;
    writeJsonAtomic(statePath, { ...state, services: nextServices });
  } catch {}
}

function markLifecycleUsed(host: any, itemId: string): void {
  try {
    if (typeof host.noteLastUsedItem === "function") {
      host.noteLastUsedItem(itemId);
      return;
    }
    if (host.mode === "dashboard" || host.mode === "project-service") {
      markLastUsed(process.cwd(), {
        itemId,
        clientSession: host.tmuxRuntimeManager?.currentClientSession?.() ?? undefined,
      });
    }
  } catch {}
}
