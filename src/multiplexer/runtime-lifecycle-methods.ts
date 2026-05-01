import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeDebug, debug } from "../debug.js";
import { loadConfig } from "../config.js";
import { getStatePath } from "../paths.js";
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

type RuntimeLifecycleHost = {
  writtenInstructionFiles: Set<string>;
  sessions: SessionRuntime[];
  sessionToolKeys: Map<string, string>;
  sessionOriginalArgs: Map<string, string[]>;
  sessionWorktreePaths: Map<string, string>;
  sessionTmuxTargets: Map<string, unknown>;
  offlineSessions: SessionState[];
  offlineServices: ServiceState[];
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
  graveyardSession(this: Multiplexer, sessionId: string): void;
  isSessionRuntimeLive(this: Multiplexer, runtime: SessionRuntime): boolean;
  evictZombieSession(this: Multiplexer, runtime: SessionRuntime): void;
  resumeOfflineSession(this: Multiplexer, session: SessionState): void;
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
      "You are running inside aimux, an agent multiplexer. " +
      "Other agents may be working on this codebase simultaneously.\n\n" +
      "## Context Files\n" +
      "- `.aimux/context/{session-id}/live.md` — each agent's recent conversation\n" +
      "- `.aimux/context/{session-id}/summary.md` — each agent's compacted history\n" +
      "- `.aimux/sessions.json` — all running agents (use to find other agents' session IDs)\n" +
      "- `.aimux/history/` — full raw conversation history (JSONL)\n\n" +
      "Check sessions.json to discover other agents, then read their context files.\n" +
      "This file is auto-generated by aimux and will be removed when aimux exits.\n";

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
  graveyardSession(this: Multiplexer, sessionId) {
    graveyardSessionImpl(this, sessionId);
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
    const liveSessions = mux.sessions.map((s: SessionRuntime) => ({
      id: s.id,
      tool: s.command,
      toolConfigKey: mux.sessionToolKeys.get(s.id) ?? s.command,
      command: s.command,
      args: mux.sessionOriginalArgs.get(s.id) ?? [],
      createdAt: s.startTime ? new Date(s.startTime).toISOString() : undefined,
      backendSessionId: s.backendSessionId,
      worktreePath: mux.sessionWorktreePaths.get(s.id),
      label: this.getSessionLabel(s.id),
      headline: this.deriveHeadline(s.id),
      tmuxTarget: mux.sessionTmuxTargets.get(s.id) as never,
    }));
    const mySessions = [...mux.offlineSessions, ...liveSessions];
    const liveServices = this.buildLiveServiceStates();
    const myServices = [...mux.offlineServices, ...liveServices].filter(
      (service, index, services) => services.findIndex((entry) => entry.id === service.id) === index,
    );

    const statePath = getStatePath();
    let mergedSessions: SessionState[] = mySessions;
    let mergedServices: ServiceState[] = myServices;

    if (existsSync(statePath)) {
      try {
        const existing = JSON.parse(readFileSync(statePath, "utf-8")) as SavedState;
        const remoteRefs = this.getRemoteInstancesSafe().flatMap((instance: InstanceInfo) => instance.sessions);
        const remoteIds = new Set(remoteRefs.map((s: InstanceSessionRef) => s.id));
        const remoteBackendIds = new Set(remoteRefs.map((s: InstanceSessionRef) => s.backendSessionId).filter(Boolean));
        const myBackendIds = new Set(mySessions.map((s) => s.backendSessionId).filter(Boolean));
        const myIds = new Set(mySessions.map((s) => s.id));
        const otherSessions = existing.sessions.filter((s) => {
          if (remoteIds.has(s.id)) return true;
          if (s.backendSessionId && remoteBackendIds.has(s.backendSessionId)) return true;
          if (s.backendSessionId && myBackendIds.has(s.backendSessionId)) return false;
          if (myIds.has(s.id)) return false;
          return false;
        });
        mergedSessions = [...otherSessions, ...mySessions];

        const myServiceIds = new Set(myServices.map((service) => service.id));
        const otherServices = (existing.services ?? []).filter((service) => {
          if (myServiceIds.has(service.id)) return false;
          return false;
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
    for (const session of mux.sessions) {
      session.destroy();
    }
    void this.stopProjectServices().catch(() => {});
    this.teardown();
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
