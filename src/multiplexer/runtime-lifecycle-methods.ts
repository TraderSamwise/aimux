import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeDebug, debug } from "../debug.js";
import { loadConfig } from "../config.js";
import { getStatePath } from "../paths.js";
import { buildAimuxAgentInstructions } from "../session-bootstrap.js";
import { loadMetadataState } from "../metadata-store.js";
import type { InstanceInfo, InstanceSessionRef } from "../instance-registry.js";
import type { SessionRuntime } from "../session-runtime.js";
import type { Multiplexer, SavedState, ServiceState, SessionState } from "./index.js";
import {
  adjustAfterRemove as adjustAfterRemoveImpl,
  buildLiveServiceStates as buildLiveServiceStatesImpl,
  evictZombieSession as evictZombieSessionImpl,
  getInstanceSessionRefs as getInstanceSessionRefsImpl,
  getRemoteInstancesSafe as getRemoteInstancesSafeImpl,
  getRemoteOwnedSessionKeys as getRemoteOwnedSessionKeysImpl,
  graveyardSession as graveyardSessionImpl,
  handleSessionClaimed as handleSessionClaimedImpl,
  isSessionRuntimeLive as isSessionRuntimeLiveImpl,
  loadOfflineServices as loadOfflineServicesImpl,
  loadOfflineSessions as loadOfflineSessionsImpl,
  restoreTmuxSessionsFromState as restoreTmuxSessionsFromStateImpl,
  recordSessionBackendSessionId as recordSessionBackendSessionIdImpl,
  resumeOfflineSession as resumeOfflineSessionImpl,
  startHeartbeat as startHeartbeatImpl,
  startProjectServiceRefresh as startProjectServiceRefreshImpl,
  startStatusRefresh as startStatusRefreshImpl,
  stopHeartbeat as stopHeartbeatImpl,
  stopProjectServiceRefresh as stopProjectServiceRefreshImpl,
  stopSessionToOffline as stopSessionToOfflineImpl,
  stopStatusRefresh as stopStatusRefreshImpl,
  syncSessionsFromState as syncSessionsFromStateImpl,
} from "./runtime-state.js";

function sanitizeOfflineSessionState(session: SessionState, metadataState = loadMetadataState()): SessionState {
  const { tmuxTarget: _tmuxTarget, ...rest } = session;
  return {
    ...rest,
    backendSessionId: rest.backendSessionId ?? metadataState.sessions[rest.id]?.backendSessionId,
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

function sessionStateFromInstanceRef(ref: InstanceSessionRef): SessionState | null {
  const tool = ref.tool;
  if (!ref.id || !tool) return null;
  return {
    id: ref.id,
    tool,
    toolConfigKey: tool,
    command: tool,
    args: [],
    lifecycle: "offline",
    createdAt: ref.createdAt,
    backendSessionId: ref.backendSessionId,
    worktreePath: ref.worktreePath,
  };
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
  writtenInstructionFiles: Set<string>;
  sessions: SessionRuntime[];
  sessionToolKeys: Map<string, string>;
  sessionOriginalArgs: Map<string, string[]>;
  sessionWorktreePaths: Map<string, string>;
  sessionTmuxTargets: Map<string, unknown>;
  offlineSessions: SessionState[];
  offlineServices: ServiceState[];
  removedServiceIds?: Set<string>;
  taskDispatcher: unknown;
  orchestrationDispatcher: unknown;
  instanceDirectory: { unregisterInstance(instanceId: string, cwd: string): Promise<void> };
  instanceId: string;
  contextWatcher: { stop(): void };
  onStdinData: ((data: Buffer) => void) | null;
  onResize: (() => void) | null;
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

export type RuntimeLifecycleMethods = {
  writeInstructionFiles(this: Multiplexer): void;
  removeInstructionFiles(this: Multiplexer): void;
  startStatusRefresh(this: Multiplexer): void;
  stopStatusRefresh(this: Multiplexer): void;
  syncSessionsFromState(this: Multiplexer, state?: SavedState | null): void;
  loadOfflineSessions(this: Multiplexer, state?: SavedState | null): boolean;
  loadOfflineServices(this: Multiplexer, state?: SavedState | null): boolean;
  buildLiveServiceStates(this: Multiplexer): ServiceState[];
  restoreTmuxSessionsFromState(this: Multiplexer, state?: SavedState | null): void;
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
  handleSessionClaimed(this: Multiplexer, sessionId: string): void;
  stopHeartbeat(this: Multiplexer): void;
  startProjectServiceRefresh(this: Multiplexer): void;
  stopProjectServiceRefresh(this: Multiplexer): void;
  getRemoteInstancesSafe(this: Multiplexer): ReturnType<typeof getRemoteInstancesSafeImpl>;
  getRemoteOwnedSessionKeys(this: Multiplexer): Set<string>;
  getInstanceSessionRefs(this: Multiplexer): InstanceSessionRef[];
  saveState(this: Multiplexer): void;
  teardown(this: Multiplexer): void;
  cleanup(this: Multiplexer): void;
  cleanupTerminalOnly(this: Multiplexer): void;
  exitDashboardClientOrProcess(this: Multiplexer): void;
};

export function loadStateStatic(): SavedState | null {
  const statePath = getStatePath();
  if (!existsSync(statePath)) return null;

  try {
    const raw = readFileSync(statePath, "utf-8");
    const state = JSON.parse(raw) as SavedState;

    return state;
  } catch {
    return null;
  }
}

export const runtimeLifecycleMethods: RuntimeLifecycleMethods = {
  writeInstructionFiles(this: Multiplexer) {
    const mux = this as unknown as RuntimeLifecycleHost;
    const config = loadConfig();
    const preamble =
      "# aimux Agent Instructions\n\n" +
      buildAimuxAgentInstructions() +
      "\n\nThis file is auto-generated by aimux and will be removed when aimux exits.\n";

    let fullPreamble = preamble;
    for (const mdPath of [join(homedir(), "AIMUX.md"), join(process.cwd(), "AIMUX.md")]) {
      if (existsSync(mdPath)) {
        try {
          const userContent = readFileSync(mdPath, "utf-8").trim();
          if (userContent) {
            fullPreamble += "\n## User Instructions\n\n" + userContent + "\n";
            debug(`loaded ${mdPath} for instructions file (${userContent.length} chars)`, "preamble");
          }
        } catch {}
      }
    }

    for (const [, tool] of Object.entries(config.tools)) {
      if (!tool.instructionsFile || !tool.enabled) continue;
      const filePath = join(process.cwd(), tool.instructionsFile);
      if (existsSync(filePath) && !mux.writtenInstructionFiles.has(filePath)) {
        debug(`skipping ${tool.instructionsFile} — already exists`, "context");
        continue;
      }
      writeFileSync(filePath, fullPreamble);
      mux.writtenInstructionFiles.add(filePath);
      debug(`wrote ${tool.instructionsFile}`, "context");
    }
  },
  removeInstructionFiles(this: Multiplexer) {
    const mux = this as unknown as RuntimeLifecycleHost;
    for (const filePath of mux.writtenInstructionFiles) {
      try {
        unlinkSync(filePath);
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
  syncSessionsFromState(this: Multiplexer, state = loadStateStatic()) {
    syncSessionsFromStateImpl(this, state);
  },
  loadOfflineSessions(this: Multiplexer, state = loadStateStatic()) {
    return loadOfflineSessionsImpl(this, state);
  },
  loadOfflineServices(this: Multiplexer, state = loadStateStatic()) {
    return loadOfflineServicesImpl(this, state);
  },
  buildLiveServiceStates(this: Multiplexer) {
    return buildLiveServiceStatesImpl(this);
  },
  restoreTmuxSessionsFromState(this: Multiplexer, state = loadStateStatic()) {
    restoreTmuxSessionsFromStateImpl(this, state);
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
  handleSessionClaimed(this: Multiplexer, sessionId) {
    handleSessionClaimedImpl(this, sessionId);
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
  getRemoteInstancesSafe(this: Multiplexer) {
    return getRemoteInstancesSafeImpl(this);
  },
  getRemoteOwnedSessionKeys(this: Multiplexer) {
    return getRemoteOwnedSessionKeysImpl(this);
  },
  getInstanceSessionRefs(this: Multiplexer) {
    return getInstanceSessionRefsImpl(this);
  },
  saveState(this: Multiplexer) {
    const mux = this as unknown as RuntimeLifecycleHost;
    const metadataState = loadMetadataState();
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
        backendSessionId: s.backendSessionId ?? metadataState.sessions[s.id]?.backendSessionId,
        worktreePath: mux.sessionWorktreePaths.get(s.id),
        label: this.getSessionLabel(s.id),
        headline: this.deriveHeadline(s.id),
        tmuxTarget: mux.sessionTmuxTargets.get(s.id) as never,
      }));
    const liveKeys = new Set(liveSessions.map(sessionStateKey));
    const offlineSessions = mux.offlineSessions
      .map((session) => sanitizeOfflineSessionState(session, metadataState))
      .filter((session) => !liveKeys.has(sessionStateKey(session)));
    const mySessions = dedupeSessionStates([...liveSessions, ...offlineSessions]);
    const remoteRefs = this.getRemoteInstancesSafe().flatMap((instance: InstanceInfo) => instance.sessions);
    const remoteSessions = dedupeSessionStates(
      remoteRefs.flatMap((ref: InstanceSessionRef) => {
        const session = sessionStateFromInstanceRef(ref);
        return session ? [session] : [];
      }),
    );
    const removedServiceIds = mux.removedServiceIds ?? new Set<string>();
    const liveServices = this.buildLiveServiceStates().filter((service) => !removedServiceIds.has(service.id));
    const myServices = [...mux.offlineServices, ...liveServices].filter(
      (service, index, services) => services.findIndex((entry) => entry.id === service.id) === index,
    );

    const statePath = getStatePath();
    let mergedSessions: SessionState[] = dedupeSessionStates([...remoteSessions, ...mySessions]);
    let mergedServices: ServiceState[] = myServices;

    if (existsSync(statePath)) {
      try {
        const existing = JSON.parse(readFileSync(statePath, "utf-8")) as SavedState;
        const remoteIds = new Set(remoteRefs.map((s: InstanceSessionRef) => s.id));
        const remoteBackendIds = new Set(remoteRefs.map((s: InstanceSessionRef) => s.backendSessionId).filter(Boolean));
        const myBackendIds = new Set(mySessions.map((s) => s.backendSessionId).filter(Boolean));
        const myIds = new Set(mySessions.map((s) => s.id));
        const otherSessions = existing.sessions.flatMap((s) => {
          if (remoteIds.has(s.id)) return [s];
          if (s.backendSessionId && remoteBackendIds.has(s.backendSessionId)) return [s];
          if (s.backendSessionId && myBackendIds.has(s.backendSessionId)) return [];
          if (myIds.has(s.id)) return [];
          if (!isRecoverableExistingSession(s)) return [];
          return [sanitizeOfflineSessionState(s, metadataState)];
        });
        mergedSessions = dedupeSessionStates([...remoteSessions, ...otherSessions, ...mySessions]);

        const myServiceIds = new Set(myServices.map((service) => service.id));
        const otherServices = (existing.services ?? []).filter((service) => {
          if (removedServiceIds.has(service.id)) return false;
          if (myServiceIds.has(service.id)) return false;
          return true;
        });
        mergedServices = [...otherServices, ...myServices];
      } catch {}
    }

    const state: SavedState = {
      savedAt: new Date().toISOString(),
      cwd: process.cwd(),
      sessions: mergedSessions,
      services: mergedServices,
    };

    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    this.invalidateDesktopStateSnapshot();
  },
  teardown(this: Multiplexer) {
    const mux = this as unknown as RuntimeLifecycleHost;
    debug("teardown started", "session");
    this.clearDashboardBusy();
    this.stopHeartbeat();
    this.stopProjectServiceRefresh();
    mux.taskDispatcher = null;
    mux.orchestrationDispatcher = null;
    mux.instanceDirectory.unregisterInstance(mux.instanceId, process.cwd()).catch(() => {});
    this.saveState();
    this.stopStatusRefresh();
    mux.contextWatcher.stop();
    this.removeSessionsFile();
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
  cleanup(this: Multiplexer) {
    const mux = this as unknown as RuntimeLifecycleHost;
    this.teardown();
    for (const session of mux.sessions) {
      session.destroy();
    }
    void this.stopProjectServices().catch(() => {});
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
        sessionName: mux.tmuxRuntimeManager.getProjectSession(process.cwd()).sessionName,
      });
      return;
    }
    this.cleanup();
    process.exit(0);
  },
};
