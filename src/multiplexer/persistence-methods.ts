import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { debug } from "../debug.js";
import { DashboardPendingActions } from "../dashboard/pending-actions.js";
import { type DashboardScreen } from "../dashboard/state.js";
import { loadDaemonInfo } from "../daemon.js";
import { type DashboardService, type DashboardSession } from "../dashboard/index.js";
import { getGraveyardPath, getLocalAimuxDir, getProjectStateDir, getStatePath } from "../paths.js";
import { loadMetadataState } from "../metadata-store.js";
import { renderCurrentDashboardView as renderCurrentDashboardViewImpl } from "./runtime-state.js";
import { loadStatusline, renderTmuxStatuslineFromData } from "../tmux/statusline.js";
import { ensureTmuxStatuslineDir, invalidateTmuxStatuslineArtifacts } from "../tmux/statusline-cache.js";
import { findMainRepo, getWorktreeCreatePath, listWorktrees as listAllWorktrees } from "../worktree.js";

export const persistenceMethods = {
  writeSessionsFile(this: any): void {
    const dir = getLocalAimuxDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const localSessions = this.sessions.map((s: any) => ({
      id: s.id,
      tool: s.command,
      backendSessionId: s.backendSessionId,
      worktreePath: this.sessionWorktreePaths.get(s.id),
    }));
    const data = this.instanceDirectory.buildSessionsFileEntries(
      localSessions,
      this.instanceDirectory.getRemoteInstancesSafe(this.instanceId, process.cwd()),
    );

    writeFileSync(`${dir}/sessions.json`, JSON.stringify(data, null, 2) + "\n");
  },

  writeStatuslineFile(this: any, input?: { force?: boolean }): void {
    try {
      if (this.mode !== "project-service") return;
      this.repairManagedTmuxTargets();
      for (const session of this.sessions) {
        this.syncTmuxWindowMetadata(session.id);
      }
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

    for (const entry of data.sessions) {
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
    return {
      project: basename(process.cwd()),
      dashboardScreen: this.dashboardState.screen,
      sessions: [
        ...desktopState.sessions.map((session: any) => ({
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
        ...desktopState.services.map((service: any) => ({
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
        })),
      ],
      tasks: this.taskDispatcher?.getTaskCounts() ?? { pending: 0, assigned: 0 },
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
    services: DashboardService[];
    statusline: ReturnType<any["buildStatuslineSnapshot"]>;
    worktrees: Array<{ name: string; path: string; branch: string; isBare: boolean }>;
    mainCheckoutInfo: { name: string; branch: string };
    mainCheckoutPath?: string;
  } {
    if (!this.desktopStateSnapshot) {
      this.refreshDesktopStateSnapshot();
    }
    const desktopState = this.desktopStateSnapshot ?? this.buildDesktopStateSnapshot();
    return {
      sessions: desktopState.sessions,
      services: desktopState.services,
      statusline: this.buildStatuslineSnapshot(),
      worktrees: desktopState.worktrees,
      mainCheckoutInfo: desktopState.mainCheckoutInfo,
      mainCheckoutPath: desktopState.mainCheckoutPath,
    };
  },

  reapplyDashboardPendingActions(this: any): void {
    this.dashboardSessionsCache = this.dashboardPendingActions.applyToSessions(
      this.dashboardSessionsCache.map(
        ({ pendingAction: _pendingAction, optimistic: _optimistic, ...session }: any) => session,
      ),
    );
    this.dashboardServicesCache = this.dashboardPendingActions.applyToServices(
      this.dashboardServicesCache.map(
        ({ pendingAction: _pendingAction, optimistic: _optimistic, ...service }: any) => service,
      ),
    );
    this.dashboardWorktreeGroupsCache = this.dashboardPendingActions.applyToWorktrees(
      this.dashboardWorktreeGroupsCache.map(
        ({
          pendingAction: _pendingAction,
          optimistic: _optimistic,
          pending: _pending,
          removing: _removing,
          ...wt
        }: any) => wt,
      ),
    );
  },

  listDesktopWorktrees(this: any): Array<{
    name: string;
    path: string;
    branch: string;
    isBare: boolean;
    pending?: boolean;
    removing?: boolean;
    pendingAction?: "creating";
  }> {
    const pendingCreates = this.pendingWorktreeCreates as
      | Map<string, Promise<{ path: string; status: "creating" | "created" }>>
      | undefined;
    const pendingRemovals = this.pendingWorktreeRemovals as
      | Map<string, Promise<{ path: string; status: "removing" | "removed" }>>
      | undefined;
    const worktrees: Array<{
      name: string;
      path: string;
      branch: string;
      isBare: boolean;
      pending?: boolean;
      removing?: boolean;
      pendingAction?: "creating";
    }> = listAllWorktrees()
      .filter((wt) => !wt.isBare)
      .map((wt) => ({
        ...wt,
        pending: pendingRemovals?.has(wt.path) ?? false,
        removing: pendingRemovals?.has(wt.path) ?? false,
      }));
    if (pendingCreates?.size) {
      let mainRepo: string | undefined;
      try {
        mainRepo = findMainRepo();
      } catch {}
      for (const path of pendingCreates.keys()) {
        if (worktrees.some((wt) => wt.path === path)) continue;
        worktrees.push({
          name: basename(path),
          path,
          branch: "(creating)",
          isBare: false,
          pending: true,
          pendingAction: "creating",
        });
      }
      worktrees.sort((a, b) => {
        const aMain = a.path === mainRepo;
        const bMain = b.path === mainRepo;
        if (aMain !== bMain) return aMain ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
    return worktrees;
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
    if (this.listDesktopWorktrees().some((worktree: any) => worktree.path === targetPath && !worktree.pending)) {
      throw new Error(`Worktree "${name}" already exists`);
    }

    let resolveCreate!: (value: { path: string; status: "creating" | "created" }) => void;
    let rejectCreate!: (reason?: unknown) => void;
    const createPromise = new Promise<{ path: string; status: "creating" | "created" }>((resolve, reject) => {
      resolveCreate = resolve;
      rejectCreate = reject;
    });
    pendingCreates.set(targetPath, createPromise);
    this.dashboardPendingActions.set(DashboardPendingActions.worktreeKey(targetPath), "creating", {
      timeoutMs: 180_000,
      onTimeout: () => {
        this.footerFlash = `Timed out creating ${name}`;
        this.footerFlashTicks = 5;
        this.invalidateDesktopStateSnapshot();
        this.refreshLocalDashboardModel();
        if (this.mode === "dashboard") {
          this.renderDashboard();
        }
      },
    });
    this.worktreeCreateJob = {
      path: targetPath,
      name,
      startedAt: Date.now(),
    };
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
            child = spawn("git", ["worktree", "add", targetPath, "-b", name], {
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
      } finally {
        pendingCreates.delete(targetPath);
        this.dashboardPendingActions.set(DashboardPendingActions.worktreeKey(targetPath), null);
        this.worktreeCreateJob = null;
        this.invalidateDesktopStateSnapshot();
        this.refreshLocalDashboardModel();
        if (this.mode === "dashboard") {
          this.renderDashboard();
        }
      }
    })()
      .then(() => {
        this.footerFlash = `Created: ${name}`;
        this.footerFlashTicks = 3;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.footerFlash = `Failed: ${message}`;
        this.footerFlashTicks = 5;
        if (this.mode === "dashboard") {
          this.showDashboardError(`Failed to create "${name}"`, [`Path: ${targetPath}`, `Error: ${message}`]);
        }
      });

    return { path: targetPath, status: "creating" };
  },

  async removeDesktopWorktree(this: any, path: string): Promise<{ path: string; status: "removing" | "removed" }> {
    const pendingRemovals = this.pendingWorktreeRemovals as Map<
      string,
      Promise<{ path: string; status: "removing" | "removed" }>
    >;
    const existingRemoval = pendingRemovals.get(path);
    if (existingRemoval) {
      return existingRemoval;
    }

    let resolveRemoval!: (value: { path: string; status: "removing" | "removed" }) => void;
    let rejectRemoval!: (reason?: unknown) => void;
    const removalPromise = new Promise<{ path: string; status: "removing" | "removed" }>((resolve, reject) => {
      resolveRemoval = resolve;
      rejectRemoval = reject;
    });
    pendingRemovals.set(path, removalPromise);
    this.dashboardPendingActions.set(DashboardPendingActions.worktreeKey(path), "removing", {
      timeoutMs: 180_000,
      onTimeout: () => {
        this.footerFlash = `Timed out removing ${path.split("/").pop() ?? path}`;
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
        this.syncSessionsFromState();

        const mainRepo = findMainRepo();
        if (path === mainRepo) {
          throw new Error("Cannot remove the main checkout");
        }

        const matching = this.listDesktopWorktrees().find((worktree: any) => worktree.path === path);
        if (!matching) {
          if (!existsSync(path)) {
            this.offlineSessions = this.offlineSessions.filter((session: any) => session.worktreePath !== path);
            this.offlineServices = this.offlineServices.filter((service: any) => service.worktreePath !== path);
            this.saveState();
            resolveRemoval({ path, status: "removed" });
            return;
          }
          throw new Error(`Worktree "${path}" not found`);
        }

        const attachedSession = this.sessions.find(
          (session: any) => session.worktreePath === path && this.isSessionRuntimeLive(session),
        );
        if (attachedSession) {
          throw new Error(
            `Cannot remove "${matching.name}" while agent "${attachedSession.label || attachedSession.id}" is attached`,
          );
        }
        const attachedService = this.buildLiveServiceStates().find((service: any) => service.worktreePath === path);
        if (attachedService) {
          throw new Error(
            `Cannot remove "${matching.name}" while service "${attachedService.label || attachedService.id}" is attached`,
          );
        }

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
        this.saveState();
        resolveRemoval({ path, status: "removed" });
      } catch (error) {
        rejectRemoval(error);
      }
    })();

    removalPromise.finally(() => {
      this.dashboardPendingActions.set(DashboardPendingActions.worktreeKey(path), null);
      pendingRemovals.delete(path);
      this.invalidateDesktopStateSnapshot();
      this.refreshLocalDashboardModel();
      if (this.mode === "dashboard") {
        this.renderDashboard();
      }
    });

    return removalPromise;
  },

  listGraveyardEntries(this: any): any[] {
    try {
      const content = readFileSync(getGraveyardPath(), "utf-8");
      return JSON.parse(content) as any[];
    } catch {
      return [];
    }
  },

  async resurrectGraveyardSession(this: any, sessionId: string): Promise<{ sessionId: string; status: "offline" }> {
    this.loadOfflineSessions();
    const graveyardEntries = this.listGraveyardEntries();
    const entry = graveyardEntries.find((candidate: any) => candidate.id === sessionId);
    if (!entry) {
      throw new Error(`Graveyard session "${sessionId}" not found`);
    }

    const nextGraveyard = graveyardEntries.filter((candidate: any) => candidate.id !== sessionId);
    writeFileSync(getGraveyardPath(), JSON.stringify(nextGraveyard, null, 2) + "\n");

    this.offlineSessions.push(entry);
    const statePath = getStatePath();
    try {
      let state: any = { savedAt: new Date().toISOString(), cwd: process.cwd(), sessions: [] };
      if (existsSync(statePath)) {
        state = JSON.parse(readFileSync(statePath, "utf-8")) as any;
      }
      state.sessions.push(entry);
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    } catch {}

    debug(`resurrected ${entry.id} from graveyard`, "session");
    return { sessionId, status: "offline" };
  },

  removeSessionsFile(this: any): void {
    try {
      unlinkSync(`${getLocalAimuxDir()}/sessions.json`);
    } catch {}
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
