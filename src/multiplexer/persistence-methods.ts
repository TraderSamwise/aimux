import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { debug } from "../debug.js";
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
import { type DashboardService, type DashboardSession } from "../dashboard/index.js";
import { getProjectStateDir, getStatePath } from "../paths.js";
import { loadMetadataState } from "../metadata-store.js";
import { renderCurrentDashboardView as renderCurrentDashboardViewImpl, stopSessionToOffline } from "./runtime-state.js";
import {
  listWorktreeGraveyardEntries as listWorktreeGraveyardEntriesImpl,
  listWorktreeGraveyardPaths,
  writeWorktreeGraveyardEntries,
  type WorktreeGraveyardEntry,
} from "./worktree-graveyard.js";
import { loadStatusline, renderTmuxStatuslineFromData } from "../tmux/statusline.js";
import { ensureTmuxStatuslineDir, invalidateTmuxStatuslineArtifacts } from "../tmux/statusline-cache.js";
import { markLastUsed } from "../last-used.js";
import { isTeammateSession, selectDirectTeammates } from "../team.js";
import {
  listTopologySessionStates,
  resurrectTopologySession,
  topologySessionToSessionState,
  upsertTopologySession,
} from "../runtime-core/topology-sessions.js";
import { createRuntimeTopologyStore } from "../runtime-core/topology-store.js";
import {
  findMainRepo,
  getWorktreeBaseDir,
  getWorktreeAddArgs,
  getWorktreeCreatePath,
  isToolInternalWorktree,
  listWorktrees as listAllWorktrees,
} from "../worktree.js";

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

export const persistenceMethods = {
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
      const tmpPath = `${filePath}.tmp`;
      const data = this.buildStatuslineSnapshot();
      const { updatedAt: _updatedAt, ...stableData } = data;
      const snapshotKey = JSON.stringify(stableData);
      if (!input?.force && snapshotKey === this.lastStatuslineSnapshotKey) {
        return;
      }
      this.lastStatuslineSnapshotKey = snapshotKey;
      writeFileSync(tmpPath, JSON.stringify(data) + "\n");
      renameSync(tmpPath, filePath);
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
    const dir = this.getTmuxStatuslineDir();
    const filePath = join(dir, name);
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, `${content}\n`);
    renameSync(tmpPath, filePath);
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
      tasks: { pending: 0, assigned: 0 },
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
      tasks: { pending: 0, assigned: 0 },
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
    operationFailures: DashboardOperationFailure[];
    mainCheckoutInfo: { name: string; branch: string };
    mainCheckoutPath?: string;
  } {
    if (!this.desktopStateSnapshot) {
      this.refreshDesktopStateSnapshot();
    }
    const desktopState = this.desktopStateSnapshot ?? this.buildDesktopStateSnapshot();
    return {
      sessions: this.dashboardPendingActions.applyToSessions(desktopState.sessions),
      teammates: this.dashboardPendingActions
        .applyToSessions(desktopState.teammates ?? [], { includeTeammates: true })
        .filter((session: DashboardSession) => isTeammateSession(session)),
      services: this.dashboardPendingActions.applyToServices(desktopState.services),
      statusline: this.buildStatuslineSnapshot(),
      worktrees: this.dashboardPendingActions.applyToWorktrees(desktopState.worktrees),
      operationFailures: desktopState.operationFailures,
      mainCheckoutInfo: desktopState.mainCheckoutInfo,
      mainCheckoutPath: desktopState.mainCheckoutPath,
    };
  },

  reapplyDashboardPendingActions(this: any): void {
    this.dashboardSessionsCache = this.dashboardPendingActions.applyToSessions(
      this.dashboardSessionsCache.map(
        ({ pending: _pending, pendingAction: _pendingAction, optimistic: _optimistic, ...session }: any) => session,
      ),
    );
    this.dashboardTeammatesCache = this.dashboardPendingActions
      .applyToSessions(
        (this.dashboardTeammatesCache ?? []).map(
          ({ pending: _pending, pendingAction: _pendingAction, optimistic: _optimistic, ...session }: any) => session,
        ),
        { includeTeammates: true },
      )
      .filter((session: DashboardSession) => isTeammateSession(session));
    this.dashboardServicesCache = this.dashboardPendingActions.applyToServices(
      this.dashboardServicesCache.map(
        ({ pending: _pending, pendingAction: _pendingAction, optimistic: _optimistic, ...service }: any) => service,
      ),
    );
    this.dashboardWorktreeGroupsCache = this.dashboardUiStateStore.orderWorktreeGroups(
      composeDashboardWorktreeGroups(
        this.dashboardPendingActions.applyToWorktrees(
          this.dashboardWorktreeGroupsCache.map(
            ({
              pendingAction: _pendingAction,
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
    this.syncSessionsFromState();

    const mainRepo = findMainRepo();
    if (path === mainRepo) {
      throw new Error("Cannot graveyard the main checkout");
    }

    const matching = listAllWorktrees()
      .filter((worktree) => !worktree.isBare)
      .find((worktree) => worktree.path === path);
    if (!matching) {
      throw new Error(`Worktree "${path}" not found`);
    }

    const worktreeGraveyardEntries = this.listWorktreeGraveyardEntries() as WorktreeGraveyardEntry[];
    if (worktreeGraveyardEntries.some((entry: WorktreeGraveyardEntry) => entry.path === path)) {
      throw new Error(`Worktree "${matching.name}" is already in the graveyard`);
    }

    let pendingSet = false;
    const setGraveyardPending = () => {
      this.dashboardPendingActions.setWorktreeAction(path, "graveyarding", {
        timeoutMs: 180_000,
        onTimeout: () => {
          const message = `Timed out graveyarding worktree "${matching.name}"`;
          recordDashboardFailure(this, {
            targetKind: "worktree",
            operation: "graveyard",
            title: `Failed to graveyard worktree "${matching.name}"`,
            message,
            worktreePath: path,
            worktreeName: matching.name,
          });
          this.footerFlash = message;
          this.footerFlashTicks = 5;
          refreshDashboardWorktreeProjection(this);
        },
      });
      pendingSet = true;
      refreshDashboardWorktreeProjection(this);
    };

    setGraveyardPending();
    try {
      const baseAgents = [
        ...this.sessions.filter((session: any) => this.sessionWorktreePaths.get(session.id) === path),
        ...this.offlineSessions.filter((session: any) => session.worktreePath === path),
      ].filter((session: any) => !isTeammateSession(session));
      const directTeammateIds = new Set<string>();
      for (const parent of baseAgents) {
        for (const teammate of selectDirectTeammates([...this.sessions, ...this.offlineSessions], parent.id)) {
          directTeammateIds.add(teammate.id);
        }
      }
      const liveSessions = this.sessions.filter(
        (session: any) =>
          (this.sessionWorktreePaths.get(session.id) === path || directTeammateIds.has(session.id)) &&
          this.isSessionRuntimeLive(session) &&
          !session.exited,
      );
      for (const session of liveSessions) {
        stopSessionToOffline(this, session);
      }

      await waitForWorktreeSessionsToStop(this, path, directTeammateIds);

      const attachedServices = collectWorktreeServices(this, path);
      const attachedAgents = collectWorktreeAgents(this, path, directTeammateIds);
      const worktreeAgents = attachedAgents.filter(
        (agent) => agent.worktreePath === path || !directTeammateIds.has(agent.id),
      );
      const crossWorktreeTeammates = attachedAgents.filter(
        (agent) => directTeammateIds.has(agent.id) && agent.worktreePath !== path,
      );
      appendFlatGraveyardAgents(crossWorktreeTeammates);

      const nextEntries = [
        ...worktreeGraveyardEntries.filter((entry: WorktreeGraveyardEntry) => entry.path !== path),
        {
          name: matching.name,
          path: matching.path,
          branch: matching.branch,
          createdAt: matching.createdAt,
          graveyardedAt: new Date().toISOString(),
          agents: worktreeAgents,
          services: attachedServices,
        },
      ];
      writeWorktreeGraveyardEntries(nextEntries);
      this.worktreeGraveyardEntries = nextEntries;

      detachWorktreeServices(this, path);
      this.offlineSessions = this.offlineSessions.filter(
        (session: any) => session.worktreePath !== path && !directTeammateIds.has(session.id),
      );
      this.saveState();
      return { path, status: "graveyarded" };
    } finally {
      if (pendingSet) {
        this.dashboardPendingActions.clearWorktreeAction(path);
        refreshDashboardWorktreeProjection(this);
      }
    }
  },

  async resurrectGraveyardWorktree(this: any, path: string): Promise<{ path: string; status: "offline" }> {
    const entries = this.listWorktreeGraveyardEntries() as WorktreeGraveyardEntry[];
    const entry = entries.find((candidate: WorktreeGraveyardEntry) => candidate.path === path);
    if (!entry) {
      throw new Error(`Graveyard worktree "${path}" not found`);
    }

    const nextEntries = entries.filter((candidate: WorktreeGraveyardEntry) => candidate.path !== path);
    writeWorktreeGraveyardEntries(nextEntries);
    this.worktreeGraveyardEntries = nextEntries;

    const flatAgents = takeFlatGraveyardAgentsForWorktree(path);
    const seen = new Set(this.offlineSessions.map((session: any) => session.id));
    for (const agent of [...entry.agents, ...flatAgents]) {
      if (seen.has(agent.id)) continue;
      this.offlineSessions.push(agent);
      seen.add(agent.id);
    }
    const serviceSeen = new Set(this.offlineServices.map((service: any) => service.id));
    for (const service of entry.services ?? []) {
      if (serviceSeen.has(service.id)) continue;
      this.offlineServices.push(service);
      serviceSeen.add(service.id);
    }
    this.saveState();
    this.invalidateDesktopStateSnapshot();
    this.refreshLocalDashboardModel();
    this.metadataServer?.notifyChange?.();
    if (this.mode === "dashboard") {
      this.renderDashboard();
    }

    return { path, status: "offline" };
  },

  async deleteGraveyardWorktree(this: any, path: string): Promise<{ path: string; status: "removed" }> {
    const entries = this.listWorktreeGraveyardEntries() as WorktreeGraveyardEntry[];
    const entry = entries.find((candidate: WorktreeGraveyardEntry) => candidate.path === path);
    if (!entry) {
      throw new Error(`Graveyard worktree "${path}" not found`);
    }

    const mainRepo = findMainRepo();
    if (path !== mainRepo) {
      if (!existsSync(path)) {
        await removeOrphanedDesktopWorktree(this, mainRepo, path);
      } else {
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
    }

    const nextEntries = entries.filter((candidate: WorktreeGraveyardEntry) => candidate.path !== path);
    writeWorktreeGraveyardEntries(nextEntries);
    this.worktreeGraveyardEntries = nextEntries;
    this.offlineSessions = this.offlineSessions.filter((session: any) => session.worktreePath !== path);
    this.offlineServices = this.offlineServices.filter((service: any) => service.worktreePath !== path);
    removeFlatGraveyardAgentsForWorktree(path);
    this.saveState();
    this.invalidateDesktopStateSnapshot();
    this.refreshLocalDashboardModel();
    this.metadataServer?.notifyChange?.();
    if (this.mode === "dashboard") {
      this.renderDashboard();
    }

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
        resolveCreate({ path: targetPath, status: "created" });
      } catch (error) {
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

    void (async () => {
      try {
        this.syncSessionsFromState();

        const mainRepo = findMainRepo();
        if (path === mainRepo) {
          throw new Error("Cannot remove the main checkout");
        }

        if (!existsSync(path)) {
          await removeOrphanedDesktopWorktree(this, mainRepo, path);
          clearDashboardOperationFailures({ targetKind: "worktree", operation: "remove", worktreePath: path });
          resolveRemoval({ path, status: "removed" });
          return;
        }

        const matching = this.listDesktopWorktrees().find((worktree: any) => worktree.path === path);
        if (!matching) {
          const worktreeBaseDir = getWorktreeBaseDir();
          if (path.startsWith(`${worktreeBaseDir}/`) || path === worktreeBaseDir) {
            await removeOrphanedDesktopWorktree(this, mainRepo, path);
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

        this.offlineSessions = this.offlineSessions.filter((session: any) => session.worktreePath !== path);
        this.offlineServices = this.offlineServices.filter((service: any) => service.worktreePath !== path);
        removeFlatGraveyardAgentsForWorktree(path);
        this.saveState();
        clearDashboardOperationFailures({ targetKind: "worktree", operation: "remove", worktreePath: path });
        resolveRemoval({ path, status: "removed" });
      } catch (error) {
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
    this.loadOfflineSessions();
    const graveyardEntries = this.listGraveyardEntries();
    const entry = graveyardEntries.find((candidate: any) => candidate.id === sessionId);
    if (!entry) {
      throw new Error(`Graveyard session "${sessionId}" not found`);
    }

    const entriesToRestore = isTeammateSession(entry)
      ? [entry]
      : [entry, ...selectDirectTeammates(graveyardEntries, entry.id)];

    const offlineIds = new Set(this.offlineSessions.map((session: any) => session.id));
    for (const candidate of entriesToRestore) {
      resurrectTopologySession(candidate.id);
      if (offlineIds.has(candidate.id)) continue;
      this.offlineSessions.push(candidate);
      offlineIds.add(candidate.id);
    }

    debug(`resurrected ${entry.id} from graveyard`, "session");
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

function collectWorktreeAgents(host: any, path: string, additionalSessionIds = new Set<string>()): any[] {
  const byId = new Map<string, any>();
  for (const session of host.offlineSessions) {
    if (session.worktreePath !== path && !additionalSessionIds.has(session.id)) continue;
    byId.set(session.id, session);
  }
  return [...byId.values()].sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bTime - aTime || a.id.localeCompare(b.id);
  });
}

function collectWorktreeServices(host: any, path: string): any[] {
  const byId = new Map<string, any>();
  for (const service of host.offlineServices ?? []) {
    if (service.worktreePath !== path) continue;
    byId.set(service.id, service);
  }
  for (const service of host.buildLiveServiceStates?.() ?? []) {
    if (service.worktreePath !== path) continue;
    byId.set(service.id, service);
  }
  return [...byId.values()].sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bTime - aTime || a.id.localeCompare(b.id);
  });
}

async function waitForWorktreeSessionsToStop(
  host: any,
  path: string,
  additionalSessionIds = new Set<string>(),
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = host.sessions.some(
      (session: any) =>
        (host.sessionWorktreePaths.get(session.id) === path || additionalSessionIds.has(session.id)) &&
        host.isSessionRuntimeLive(session) &&
        !session.exited,
    );
    if (!remaining) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out offlining agents for worktree "${basename(path)}"`);
}

async function removeOrphanedDesktopWorktree(host: any, mainRepo: string, path: string): Promise<void> {
  await pruneGitWorktrees(mainRepo);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
  await pruneGitWorktrees(mainRepo);
  host.offlineSessions = host.offlineSessions.filter((session: any) => session.worktreePath !== path);
  host.offlineServices = host.offlineServices.filter((service: any) => service.worktreePath !== path);
  host.saveState();
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
  removePersistedServicesForWorktree(path);
}

function removePersistedServicesForWorktree(path: string): void {
  const statePath = getStatePath();
  if (!existsSync(statePath)) return;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as { services?: Array<{ worktreePath?: string }> };
    const nextServices = (state.services ?? []).filter((service) => service.worktreePath !== path);
    if (nextServices.length === (state.services ?? []).length) return;
    writeFileSync(statePath, JSON.stringify({ ...state, services: nextServices }, null, 2) + "\n");
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

function takeFlatGraveyardAgentsForWorktree(path: string): any[] {
  const store = createRuntimeTopologyStore();
  try {
    let matching: any[] = [];
    store.update((topology) => {
      matching = topology.sessions
        .filter((entry) => entry.status === "graveyard" && entry.worktreePath === path)
        .map((entry) => topologySessionToSessionState(entry, topology));
      if (matching.length > 0) {
        const matchingIds = new Set(matching.map((entry) => entry.id));
        topology.sessions = topology.sessions.filter((entry) => !matchingIds.has(entry.id));
      }
      return topology;
    });
    return matching;
  } catch {
    return [];
  }
}

function appendFlatGraveyardAgents(agents: any[]): void {
  if (agents.length === 0) return;
  for (const agent of agents) {
    if (agent?.id) upsertTopologySession(agent, "graveyard");
  }
}

function removeFlatGraveyardAgentsForWorktree(path: string): void {
  void takeFlatGraveyardAgentsForWorktree(path);
}
