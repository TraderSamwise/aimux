import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDebug, debug } from "../debug.js";
import { loadConfig } from "../config.js";
import { getRepoRoot, getStatePath } from "../paths.js";
import { quarantineCorruptFile, writeJsonAtomic } from "../atomic-write.js";
import type { SessionRuntime } from "../session-runtime.js";
import type { Multiplexer, SavedState, ServiceState, SessionState } from "./index.js";
import { listTopologySessionStates, saveRuntimeTopologySessions } from "../runtime-core/topology-sessions.js";
import { stopDashboardProjectEventStream } from "./project-event-stream.js";
import { clearTuiRuntimeMutationQueue } from "./tui-runtime-mutations.js";
import {
  adjustAfterRemove as adjustAfterRemoveImpl,
  buildLiveServiceStates as buildLiveServiceStatesImpl,
  evictZombieSession as evictZombieSessionImpl,
  graveyardSession as graveyardSessionImpl,
  isSessionRuntimeLive as isSessionRuntimeLiveImpl,
  loadOfflineServices as loadOfflineServicesImpl,
  loadOfflineTopologySessions as loadOfflineTopologySessionsImpl,
  restoreTmuxSessionsFromTopology as restoreTmuxSessionsFromTopologyImpl,
  recordSessionBackendSessionId as recordSessionBackendSessionIdImpl,
  resumeOfflineSession as resumeOfflineSessionImpl,
  startHeartbeat as startHeartbeatImpl,
  startProjectServiceRefresh as startProjectServiceRefreshImpl,
  startStatusRefresh as startStatusRefreshImpl,
  stopHeartbeat as stopHeartbeatImpl,
  stopProjectServiceRefresh as stopProjectServiceRefreshImpl,
  stopSessionToOffline as stopSessionToOfflineImpl,
  stopStatusRefresh as stopStatusRefreshImpl,
  syncSessionsFromTopology as syncSessionsFromTopologyImpl,
} from "./runtime-state.js";

const AIMUX_MANAGED_BLOCK_ID = "aimux-agent-instructions";
const AIMUX_MANAGED_BLOCK_START = `<!-- BEGIN Aimux MANAGED BLOCK: ${AIMUX_MANAGED_BLOCK_ID} -->`;
const AIMUX_MANAGED_BLOCK_END = `<!-- END Aimux MANAGED BLOCK: ${AIMUX_MANAGED_BLOCK_ID} -->`;
const LEGACY_DEFAULT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CODEX.md"];

function stripManagedInstructionBlock(existing: string): string {
  const pattern = new RegExp(
    `(?:\\n|^)\\s*${escapeRegex(AIMUX_MANAGED_BLOCK_START)}[\\s\\S]*?${escapeRegex(AIMUX_MANAGED_BLOCK_END)}\\s*(?=\\n|$)`,
    "m",
  );
  return existing
    .replace(pattern, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanupManagedInstructionFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const existing = readFileSync(filePath, "utf-8");
  if (!existing.includes(AIMUX_MANAGED_BLOCK_START) || !existing.includes(AIMUX_MANAGED_BLOCK_END)) return;
  const cleaned = stripManagedInstructionBlock(existing);
  if (cleaned) {
    writeFileSync(filePath, `${cleaned}\n`);
  } else {
    unlinkSync(filePath);
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeOfflineSessionState(session: SessionState): SessionState {
  const { tmuxTarget: _tmuxTarget, ...rest } = session;
  return {
    ...rest,
    lifecycle: "offline",
  };
}

function sessionStateKey(session: SessionState): string {
  return session.backendSessionId ? `backend:${session.backendSessionId}` : `id:${session.id}`;
}

function isRecoverableExistingSession(session: SessionState): boolean {
  if (!session.id || !(session.command || session.tool || session.toolConfigKey)) return false;
  if (session.lifecycle === "offline") return true;
  if (session.lifecycle === "live") return true;
  if (session.lifecycle) return false;
  return Boolean(session.backendSessionId);
}

function dedupeSessionStates(sessions: SessionState[]): SessionState[] {
  const byKey = new Map<string, SessionState>();
  for (const session of sessions) {
    const key = sessionStateKey(session);
    byKey.delete(key);
    byKey.set(key, session);
  }
  return [...byKey.values()];
}

type RuntimeLifecycleHost = {
  projectRoot?: string;
  writtenInstructionFiles: Set<string>;
  sessions: SessionRuntime[];
  sessionToolKeys: Map<string, string>;
  sessionOriginalArgs: Map<string, string[]>;
  sessionWorktreePaths: Map<string, string>;
  sessionTmuxTargets: Map<string, unknown>;
  offlineSessions: SessionState[];
  offlineServices: ServiceState[];
  removedServiceIds?: Set<string>;
  contextWatcher: { stop(): void };
  onStdinData: ((data: Buffer) => void) | null;
  onResize: (() => void) | null;
  unpreservedExitedSessionIds?: Set<string>;
  dashboardViewportPollInterval: ReturnType<typeof setInterval> | null;
  hotkeys: { destroy(): void };
  terminalHost: { restoreTerminalState(): void };
  tmuxRuntimeManager: {
    isInsideTmux(): boolean;
    currentClientSession(): string | null;
    isManagedSessionName(name: string): boolean;
    leaveManagedSession(opts: { insideTmux: boolean; sessionName: string }): void;
    getProjectSession(projectRoot: string): { sessionName: string };
  };
};

function projectRootFor(host: { projectRoot?: string }): string {
  return typeof host.projectRoot === "string" && host.projectRoot.trim() ? host.projectRoot.trim() : getRepoRoot();
}

export type RuntimeLifecycleMethods = {
  writeInstructionFiles(this: Multiplexer): void;
  removeInstructionFiles(this: Multiplexer): void;
  startStatusRefresh(this: Multiplexer): void;
  stopStatusRefresh(this: Multiplexer): void;
  syncSessionsFromTopology(this: Multiplexer): void;
  loadOfflineTopologySessions(this: Multiplexer): boolean;
  loadOfflineServices(this: Multiplexer, state?: SavedState | null): boolean;
  buildLiveServiceStates(this: Multiplexer): ServiceState[];
  restoreTmuxSessionsFromTopology(this: Multiplexer): void;
  stopSessionToOffline(this: Multiplexer, session: SessionRuntime): void;
  adjustAfterRemove(this: Multiplexer, hasWorktrees: boolean): void;
  graveyardSession(this: Multiplexer, sessionId: string, sessionSeed?: any): void;
  isSessionRuntimeLive(this: Multiplexer, runtime: SessionRuntime): boolean;
  evictZombieSession(this: Multiplexer, runtime: SessionRuntime): void;
  resumeOfflineSession(this: Multiplexer, session: SessionState): void;
  recordSessionBackendSessionId(
    this: Multiplexer,
    sessionId: string,
    backendSessionId: string,
  ): { sessionId: string; backendSessionId: string };
  startHeartbeat(this: Multiplexer): void;
  stopHeartbeat(this: Multiplexer): void;
  startProjectServiceRefresh(this: Multiplexer): void;
  stopProjectServiceRefresh(this: Multiplexer): void;
  saveState(this: Multiplexer): void;
  teardown(this: Multiplexer): void;
  cleanup(this: Multiplexer): Promise<void>;
  cleanupTerminalOnly(this: Multiplexer): void;
  exitDashboardClientOrProcess(this: Multiplexer): void;
};

export function loadStateStatic(): SavedState | null {
  const statePath = getStatePath();
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const raw = readFileSync(statePath, "utf-8");
    const state = JSON.parse(raw) as Record<string, unknown>;
    return {
      savedAt: typeof state.savedAt === "string" ? state.savedAt : new Date().toISOString(),
      cwd: typeof state.cwd === "string" ? state.cwd : getRepoRoot(),
      services: Array.isArray(state.services) ? (state.services as ServiceState[]) : undefined,
    };
  } catch {
    quarantineCorruptFile(statePath);
    return null;
  }
}

export const runtimeLifecycleMethods: RuntimeLifecycleMethods = {
  writeInstructionFiles(this: Multiplexer) {
    const mux = this as unknown as RuntimeLifecycleHost;
    const projectRoot = projectRootFor(mux);
    const config = loadConfig();
    const configuredInstructionFiles = new Set(
      Object.values(config.tools)
        .filter((tool) => tool.enabled && tool.instructionsFile)
        .map((tool) => tool.instructionsFile!),
    );

    for (const instructionFile of LEGACY_DEFAULT_INSTRUCTION_FILES) {
      if (!configuredInstructionFiles.has(instructionFile)) {
        try {
          cleanupManagedInstructionFile(join(projectRoot, instructionFile));
        } catch {}
      }
    }
    mux.writtenInstructionFiles.clear();
  },
  removeInstructionFiles(this: Multiplexer) {
    const mux = this as unknown as RuntimeLifecycleHost;
    for (const filePath of mux.writtenInstructionFiles) {
      try {
        cleanupManagedInstructionFile(filePath);
      } catch {}
    }
    mux.writtenInstructionFiles.clear();
  },
  startStatusRefresh(this: Multiplexer) {
    startStatusRefreshImpl(this);
  },
  stopStatusRefresh(this: Multiplexer) {
    stopStatusRefreshImpl(this);
  },
  syncSessionsFromTopology(this: Multiplexer) {
    syncSessionsFromTopologyImpl(this);
  },
  loadOfflineTopologySessions(this: Multiplexer) {
    return loadOfflineTopologySessionsImpl(this);
  },
  loadOfflineServices(this: Multiplexer, state = loadStateStatic()) {
    return loadOfflineServicesImpl(this, state);
  },
  buildLiveServiceStates(this: Multiplexer) {
    return buildLiveServiceStatesImpl(this);
  },
  restoreTmuxSessionsFromTopology(this: Multiplexer) {
    restoreTmuxSessionsFromTopologyImpl(this);
  },
  stopSessionToOffline(this: Multiplexer, session) {
    stopSessionToOfflineImpl(this, session);
  },
  adjustAfterRemove(this: Multiplexer, hasWorktrees) {
    adjustAfterRemoveImpl(this, hasWorktrees);
  },
  graveyardSession(this: Multiplexer, sessionId, sessionSeed) {
    graveyardSessionImpl(this, sessionId, sessionSeed);
  },
  isSessionRuntimeLive(this: Multiplexer, runtime) {
    return isSessionRuntimeLiveImpl(this, runtime);
  },
  evictZombieSession(this: Multiplexer, runtime) {
    evictZombieSessionImpl(this, runtime);
  },
  resumeOfflineSession(this: Multiplexer, session) {
    resumeOfflineSessionImpl(this, session);
  },
  recordSessionBackendSessionId(this: Multiplexer, sessionId, backendSessionId) {
    return recordSessionBackendSessionIdImpl(this, sessionId, backendSessionId);
  },
  startHeartbeat(this: Multiplexer) {
    startHeartbeatImpl(this);
  },
  stopHeartbeat(this: Multiplexer) {
    stopHeartbeatImpl(this);
  },
  startProjectServiceRefresh(this: Multiplexer) {
    startProjectServiceRefreshImpl(this);
  },
  stopProjectServiceRefresh(this: Multiplexer) {
    stopProjectServiceRefreshImpl(this);
  },
  saveState(this: Multiplexer) {
    const mux = this as unknown as RuntimeLifecycleHost;
    const projectRoot = projectRootFor(mux);
    const liveSessions = mux.sessions
      .filter((s: SessionRuntime) => !("stoppingSessionIds" in mux) || !(mux as any).stoppingSessionIds?.has?.(s.id))
      .filter((s: SessionRuntime) => this.isSessionRuntimeLive(s))
      .map((s: SessionRuntime) => ({
        id: s.id,
        tool: s.command,
        toolConfigKey: mux.sessionToolKeys.get(s.id) ?? s.command,
        command: s.command,
        args: mux.sessionOriginalArgs.get(s.id) ?? [],
        lifecycle: "live" as const,
        createdAt: s.startTime ? new Date(s.startTime).toISOString() : undefined,
        backendSessionId: s.backendSessionId,
        team: s.team,
        worktreePath: mux.sessionWorktreePaths.get(s.id),
        label: this.getSessionLabel(s.id),
        headline: this.deriveHeadline(s.id),
        tmuxTarget: mux.sessionTmuxTargets.get(s.id) as never,
      }));
    const liveKeys = new Set(liveSessions.map(sessionStateKey));
    const topologySessions = listTopologySessionStates({
      statuses: ["running", "idle", "offline"],
    }) as SessionState[];
    const topologyByKey = new Map(topologySessions.map((session) => [sessionStateKey(session), session]));
    const topologyById = new Map(topologySessions.map((session) => [session.id, session]));
    const offlineSessions = mux.offlineSessions
      .map((session) => sanitizeOfflineSessionState(session))
      .map((session) => {
        const existing =
          topologyByKey.get(sessionStateKey(session)) ??
          (!session.backendSessionId ? topologyById.get(session.id) : undefined);
        if (!existing) return session;
        return {
          ...session,
          backendSessionId: session.backendSessionId ?? existing.backendSessionId,
          restoreBlockedReason: session.restoreBlockedReason ?? existing.restoreBlockedReason,
        };
      })
      .filter((session) => !liveKeys.has(sessionStateKey(session)));
    const mySessions = dedupeSessionStates([...liveSessions, ...offlineSessions]);
    const removedServiceIds = mux.removedServiceIds ?? new Set<string>();
    const liveServices = this.buildLiveServiceStates().filter((service) => !removedServiceIds.has(service.id));
    const myServices = [...mux.offlineServices, ...liveServices].filter(
      (service, index, services) => services.findIndex((entry) => entry.id === service.id) === index,
    );

    const statePath = getStatePath();
    const myBackendIds = new Set(mySessions.map((s) => s.backendSessionId).filter(Boolean));
    const myIds = new Set(mySessions.map((s) => s.id));
    const unpreservedExitedIds = mux.unpreservedExitedSessionIds ?? new Set<string>();
    const otherSessions = topologySessions.flatMap((s) => {
      if (unpreservedExitedIds.has(s.id)) return [];
      if (s.backendSessionId && myBackendIds.has(s.backendSessionId)) return [];
      if (myIds.has(s.id)) return [];
      if (!isRecoverableExistingSession(s)) return [];
      return [s];
    });
    const mergedSessions: SessionState[] = dedupeSessionStates([...otherSessions, ...mySessions]);
    let mergedServices: ServiceState[] = myServices;

    if (existsSync(statePath)) {
      try {
        const existing = JSON.parse(readFileSync(statePath, "utf-8")) as SavedState;
        const myServiceIds = new Set(myServices.map((service) => service.id));
        const otherServices = (existing.services ?? []).filter((service) => {
          if (removedServiceIds.has(service.id)) return false;
          if (myServiceIds.has(service.id)) return false;
          return true;
        });
        mergedServices = [...otherServices, ...myServices];
      } catch {
        quarantineCorruptFile(statePath);
      }
    }

    saveRuntimeTopologySessions({ sessions: mergedSessions });
    unpreservedExitedIds.clear();

    const state: SavedState = {
      savedAt: new Date().toISOString(),
      cwd: projectRoot,
      services: mergedServices,
    };

    writeJsonAtomic(statePath, state);
    this.invalidateDesktopStateSnapshot();
  },
  teardown(this: Multiplexer) {
    const mux = this as unknown as RuntimeLifecycleHost;
    debug("teardown started", "session");
    this.clearDashboardBusy();
    this.stopHeartbeat();
    this.stopProjectServiceRefresh();
    stopDashboardProjectEventStream(this);
    if ((this as any).tuiApiRecoveryTimer) {
      clearTimeout((this as any).tuiApiRecoveryTimer);
      (this as any).tuiApiRecoveryTimer = null;
    }
    (this as any).tuiApiRecoveryDueAt = undefined;
    (this as any).tuiApiRecoveryPending = false;
    (this as any).tuiApiRecoveryInFlight = false;
    clearTuiRuntimeMutationQueue(this);
    (this as any).tuiApiRuntime?.dispose?.();
    (this as any).tuiApiRuntime = null;
    (this as any).stopGraveyardCleanup?.();
    (this as any).stopInboxCleanup?.();
    this.saveState();
    this.stopStatusRefresh();
    mux.contextWatcher.stop();
    this.removeInstructionFiles();
    closeDebug();
    if (mux.onStdinData) {
      process.stdin.removeListener("data", mux.onStdinData);
    }
    if (mux.onResize) {
      process.stdout.removeListener("resize", mux.onResize);
    }
    if (mux.dashboardViewportPollInterval) {
      clearInterval(mux.dashboardViewportPollInterval);
      mux.dashboardViewportPollInterval = null;
    }
    mux.hotkeys.destroy();
    mux.terminalHost.restoreTerminalState();
  },
  async cleanup(this: Multiplexer) {
    const mux = this as unknown as RuntimeLifecycleHost;
    this.teardown();
    for (const session of mux.sessions) {
      session.destroy();
    }
    await this.stopProjectServices().catch((error: unknown) => {
      debug(`project service cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "runtime");
    });
  },
  cleanupTerminalOnly(this: Multiplexer) {
    const mux = this as unknown as RuntimeLifecycleHost;
    mux.terminalHost.restoreTerminalState();
  },
  exitDashboardClientOrProcess(this: Multiplexer) {
    const mux = this as unknown as RuntimeLifecycleHost;
    const insideTmux = mux.tmuxRuntimeManager.isInsideTmux();
    const currentSession = insideTmux ? mux.tmuxRuntimeManager.currentClientSession() : null;
    if (insideTmux && currentSession && mux.tmuxRuntimeManager.isManagedSessionName(currentSession)) {
      mux.tmuxRuntimeManager.leaveManagedSession({
        insideTmux: true,
        sessionName: mux.tmuxRuntimeManager.getProjectSession(projectRootFor(mux)).sessionName,
      });
      return;
    }
    void this.cleanup().finally(() => process.exit(0));
  },
};
