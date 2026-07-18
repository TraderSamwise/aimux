import type { DashboardService, DashboardSession } from "../dashboard/index.js";
import type { Multiplexer, SessionState } from "./index.js";
import {
  handleGraveyardKey as handleGraveyardKeyImpl,
  renderGraveyard as renderGraveyardImpl,
  renderGraveyardDetailsForHost as renderGraveyardDetailsForHostImpl,
  resurrectGraveyardEntry as resurrectGraveyardEntryImpl,
  showGraveyard as showGraveyardImpl,
} from "./archives.js";
import {
  handleLibraryKey as handleLibraryKeyImpl,
  renderLibrary as renderLibraryImpl,
  showLibrary as showLibraryImpl,
} from "./library.js";
import {
  confirmSwitcher as confirmSwitcherImpl,
  dismissHelp as dismissHelpImpl,
  dismissSwitcher as dismissSwitcherImpl,
  getSwitcherList as getSwitcherListImpl,
  handleHelpKey as handleHelpKeyImpl,
  handleMigratePickerKey as handleMigratePickerKeyImpl,
  handleSwitcherKey as handleSwitcherKeyImpl,
  redrawCurrentView as redrawCurrentViewImpl,
  renderHelp as renderHelpImpl,
  renderMigratePicker as renderMigratePickerImpl,
  renderSwitcher as renderSwitcherImpl,
  resetSwitcherTimeout as resetSwitcherTimeoutImpl,
  showHelp as showHelpImpl,
  showMigratePicker as showMigratePickerImpl,
  showSwitcher as showSwitcherImpl,
} from "./navigation.js";
import {
  basenameForHost,
  clearDashboardSubscreens as clearDashboardSubscreensImpl,
  createDashboardServiceWithFeedback as createDashboardServiceWithFeedbackImpl,
  dashboardSessionActionDeps as dashboardSessionActionDepsImpl,
  graveyardSessionWithFeedback as graveyardSessionWithFeedbackImpl,
  migrateSessionWithFeedback as migrateSessionWithFeedbackImpl,
  removeDashboardServiceWithFeedback as removeDashboardServiceWithFeedbackImpl,
  renderSessionDetails as renderSessionDetailsImpl,
  resumeOfflineServiceWithFeedback as resumeOfflineServiceWithFeedbackImpl,
  resumeOfflineSessionWithFeedback as resumeOfflineSessionWithFeedbackImpl,
  runDashboardOperation as runDashboardOperationImpl,
  setPendingDashboardServiceAction as setPendingDashboardServiceActionImpl,
  setPendingDashboardSessionAction as setPendingDashboardSessionActionImpl,
  stopDashboardServiceWithFeedback as stopDashboardServiceWithFeedbackImpl,
  stopSessionToOfflineWithFeedback as stopSessionToOfflineWithFeedbackImpl,
  truncateAnsiForHost,
  truncatePlainForHost,
  waitForSessionStartForHost,
  wrapKeyValueForHost,
  wrapTextForHost,
} from "./dashboard-ops.js";
import type { DashboardMutationResult } from "./dashboard-ops.js";
import type { PendingServiceActionKind, PendingSessionActionKind } from "../pending-actions.js";
import { findMainRepo, listWorktrees as listAllWorktrees } from "../worktree.js";
import { orderDashboardSessionsByVisualWorktree } from "../dashboard/session-registry.js";
import type { SessionRuntime } from "../session-runtime.js";
import { loadConfig } from "../config.js";
import { getRepoRoot } from "../paths.js";
import type { LaunchOverride } from "../shell-args.js";
import type { SessionTeamMetadata } from "../team.js";
import { setSessionOverseer } from "../metadata-store.js";
import { createSessionAsync } from "./session-launch.js";
import { TmuxSessionTransport } from "../tmux/session-transport.js";
import { addDashboardOperationFailure, clearDashboardOperationFailures } from "../dashboard/operation-failures.js";
import {
  listTopologySessionStates,
  moveTopologySessionToGraveyard,
  upsertTopologySession,
  type RuntimeTopologySessionState,
} from "../runtime-core/topology-sessions.js";
import { shouldMarkFreshRelaunchAllowed } from "../session-fresh-relaunch.js";

type DashboardTailHost = {
  mode: "dashboard" | "project-service";
  dashboardSessionsCache: DashboardSession[];
  dashboardServicesCache: DashboardService[];
  dashboardWorktreeGroupsCache: Array<{ sessions: DashboardSession[] }>;
};

function isLiveTopologyStatus(status: RuntimeTopologySessionState["status"] | undefined): boolean {
  return status === "running" || status === "idle" || status === "starting";
}

function projectRootFor(host: Multiplexer): string {
  const projectRoot = typeof (host as any).projectRoot === "string" ? (host as any).projectRoot.trim() : "";
  return projectRoot || getRepoRoot();
}

function runtimeToTopologySessionState(host: Multiplexer, session: any): RuntimeTopologySessionState {
  const projectRoot = projectRootFor(host);
  const backendSessionId = session.backendSessionId;
  return {
    id: session.id,
    tool: session.command,
    toolConfigKey: (host as any).sessionToolKeys?.get?.(session.id) ?? session.command,
    command: session.command,
    args: (host as any).sessionOriginalArgs?.get?.(session.id) ?? [],
    lifecycle: "offline",
    createdAt: session.startTime ? new Date(session.startTime).toISOString() : undefined,
    backendSessionId,
    freshRelaunchAllowed: shouldMarkFreshRelaunchAllowed({ id: session.id, backendSessionId }, projectRoot),
    team: session.team,
    worktreePath: (host as any).sessionWorktreePaths?.get?.(session.id),
    label: (host as any).getSessionLabel?.(session.id),
    headline: (host as any).deriveHeadline?.(session.id),
  };
}

function cacheOfflineSession(host: Multiplexer, entry: RuntimeTopologySessionState): void {
  const cache = (host as any).offlineSessions;
  if (!Array.isArray(cache)) return;
  const offlineEntry = { ...entry, lifecycle: "offline" as const, status: "offline" as const };
  const existingIndex = cache.findIndex((session: any) => session.id === entry.id);
  if (existingIndex >= 0) {
    cache[existingIndex] = { ...cache[existingIndex], ...offlineEntry };
  } else {
    cache.push(offlineEntry);
  }
}

function removeOfflineSessionCache(host: Multiplexer, sessionId: string): void {
  if (!Array.isArray((host as any).offlineSessions)) return;
  (host as any).offlineSessions = (host as any).offlineSessions.filter((session: any) => session.id !== sessionId);
}

function findTopologySession(host: Multiplexer, sessionId: string): RuntimeTopologySessionState | undefined {
  return listTopologySessionStates({
    statuses: ["running", "idle", "starting", "offline", "graveyard"],
    projectRoot: projectRootFor(host),
  }).find((session) => session.id === sessionId);
}

function refreshLifecycleViews(host: Multiplexer): void {
  (host as any).invalidateDesktopStateSnapshot?.();
  if ((host as any).mode === "project-service") return;
  (host as any).writeStatuslineFile?.();
  if ((host as any).mode === "dashboard") {
    (host as any).renderCurrentDashboardView?.();
  }
  (host as any).updateContextWatcherSessions?.();
}

function notifyLifecycleChange(host: Multiplexer): void {
  refreshLifecycleViews(host);
  (host as any).metadataServer?.notifyChange?.();
}

function clearTerminatingSessionTracking(host: Multiplexer, sessionId: string): void {
  (host as any).stoppingSessionIds?.delete?.(sessionId);
  (host as any).graveyardAfterStopSessionIds?.delete?.(sessionId);
  notifyLifecycleChange(host);
}

function lifecycleFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().replace(/\s+/g, " ").slice(0, 500) || "unknown error";
}

function scheduleRuntimeKill(host: Multiplexer, runtime: SessionRuntime, sessionId: string): void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const manager = (host as any).tmuxRuntimeManager;
        if (runtime.transport instanceof TmuxSessionTransport && typeof manager?.killWindowAsync === "function") {
          await manager.killWindowAsync(runtime.transport.tmuxTarget);
          return;
        }
        runtime.kill();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (host as any).debug?.(`failed to kill tmux window for ${sessionId}: ${message}`, "session");
      } finally {
        clearTerminatingSessionTracking(host, sessionId);
      }
    })();
  }, 0);
  timer.unref?.();
}

function scheduleTmuxTargetKill(host: Multiplexer, target: any, sessionId: string): void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const manager = (host as any).tmuxRuntimeManager;
        if (typeof manager?.killWindowAsync === "function") {
          await manager.killWindowAsync(target);
        } else {
          manager?.killWindow?.(target);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (host as any).debug?.(`failed to kill tmux window for ${sessionId}: ${message}`, "session");
      } finally {
        clearTerminatingSessionTracking(host, sessionId);
      }
    })();
  }, 0);
  timer.unref?.();
}

function tmuxTargetForTransport(transport: any): any {
  return transport instanceof TmuxSessionTransport ? transport.tmuxTarget : transport?.tmuxTarget;
}

function forgetRuntimeSession(host: Multiplexer, sessionId: string): SessionRuntime | undefined {
  let runtime: SessionRuntime | undefined;
  const sessions = (host as any).sessions;
  if (Array.isArray(sessions)) {
    const index = sessions.findIndex((session: any) => session.id === sessionId);
    if (index >= 0) {
      [runtime] = sessions.splice(index, 1);
    }
  }
  (host as any).sessionTmuxTargets?.delete?.(sessionId);
  (host as any).sessionToolKeys?.delete?.(sessionId);
  (host as any).sessionOriginalArgs?.delete?.(sessionId);
  (host as any).sessionWorktreePaths?.delete?.(sessionId);
  (host as any).sessionStartTimes?.delete?.(sessionId);
  (host as any).sessionRoles?.delete?.(sessionId);
  (host as any).sessionTeams?.delete?.(sessionId);
  return runtime;
}

function tmuxWindowAlive(host: Multiplexer, target: any): boolean {
  const manager = (host as any).tmuxRuntimeManager;
  if (!target || typeof manager?.isWindowAlive !== "function") return true;
  try {
    const resolved = manager.getTargetByWindowId?.(target.sessionName, target.windowId) ?? target;
    if (!resolved) return false;
    return Boolean(manager.isWindowAlive(resolved));
  } catch {
    return false;
  }
}

async function verifyCreatedTmuxWindow(
  host: Multiplexer,
  input: ScheduledSessionCreate,
  transport: any,
): Promise<void> {
  const target = tmuxTargetForTransport(transport);
  const manager = (host as any).tmuxRuntimeManager;
  if (!target || typeof manager?.isWindowAlive !== "function") return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 150);
    timer.unref?.();
  });
  if (tmuxWindowAlive(host, target)) return;
  forgetRuntimeSession(host, input.sessionId);
  scheduleTmuxTargetKill(host, target, input.sessionId);
  throw new Error("agent exited during startup");
}

type ScheduledSessionCreate = {
  command: string;
  args: string[];
  preambleFlag?: string[];
  toolConfigKey: string;
  sessionIdFlag?: string[];
  targetWorktreePath?: string;
  sessionId: string;
  detached: boolean;
  team?: SessionTeamMetadata;
  env?: Record<string, string>;
  label?: string;
  open?: boolean;
  overseer?: boolean;
};

const sessionCreateQueue: Array<{ host: Multiplexer; input: ScheduledSessionCreate }> = [];
let sessionCreateQueueRunning = false;

function findRuntime(host: Multiplexer, sessionId: string): SessionRuntime | undefined {
  return (host as any).sessions?.find?.((session: any) => session.id === sessionId);
}

function resolveLifecycleRuntime(host: Multiplexer, sessionId: string): SessionRuntime | undefined {
  let runtime = findRuntime(host, sessionId);
  if (runtime) return runtime;
  (host as any).restoreTmuxSessionsFromTopology?.();
  runtime = findRuntime(host, sessionId);
  if (runtime) return runtime;
  (host as any).syncSessionsFromTopology?.();
  return findRuntime(host, sessionId);
}

function resolveLiveTmuxTargetForSession(host: Multiplexer, sessionId: string): any {
  const manager = (host as any).tmuxRuntimeManager;
  const cached = (host as any).sessionTmuxTargets?.get?.(sessionId);
  if (cached) {
    try {
      const resolved = manager?.getTargetByWindowId?.(cached.sessionName, cached.windowId) ?? cached;
      if (!manager?.isWindowAlive || manager.isWindowAlive(resolved)) return resolved;
    } catch {}
  }
  try {
    for (const { target, metadata } of manager?.listProjectManagedWindows?.(projectRootFor(host)) ?? []) {
      if (metadata?.kind !== "agent" || metadata.sessionId !== sessionId) continue;
      if (manager?.isWindowAlive && !manager.isWindowAlive(target)) continue;
      (host as any).sessionTmuxTargets?.set?.(sessionId, target);
      return target;
    }
  } catch {}
  return undefined;
}

function cancelQueuedSessionCreate(host: Multiplexer, sessionId: string): ScheduledSessionCreate | undefined {
  const projectRoot = projectRootFor(host);
  const index = sessionCreateQueue.findIndex(
    (entry) => entry.input.sessionId === sessionId && projectRootFor(entry.host) === projectRoot,
  );
  if (index === -1) return undefined;
  return sessionCreateQueue.splice(index, 1)[0]?.input;
}

function markTopologySessionOffline(host: Multiplexer, existing: RuntimeTopologySessionState): void {
  const offlineEntry: RuntimeTopologySessionState = {
    ...existing,
    lifecycle: "offline",
    status: "offline",
  };
  upsertTopologySession(offlineEntry, "offline", { projectRoot: projectRootFor(host) });
  cacheOfflineSession(host, offlineEntry);
}

function recordStartingSession(host: Multiplexer, input: ScheduledSessionCreate): void {
  clearDashboardOperationFailures({ targetKind: "agent", operation: "create", targetId: input.sessionId });
  upsertTopologySession(
    {
      id: input.sessionId,
      tool: input.toolConfigKey,
      toolConfigKey: input.toolConfigKey,
      command: input.command,
      args: input.args,
      lifecycle: "live",
      status: "starting",
      team: input.team,
      worktreePath: input.targetWorktreePath,
      label: input.label,
    },
    "starting",
    { projectRoot: projectRootFor(host) },
  );
}

function recordSessionCreateFailure(host: Multiplexer, input: ScheduledSessionCreate, error: unknown): void {
  const message = lifecycleFailureMessage(error);
  upsertTopologySession(
    {
      id: input.sessionId,
      tool: input.toolConfigKey,
      toolConfigKey: input.toolConfigKey,
      command: input.command,
      args: input.args,
      lifecycle: "offline",
      status: "offline",
      team: input.team,
      worktreePath: input.targetWorktreePath,
      label: input.label,
      restoreBlockedReason: `startup failed: ${message}`,
    },
    "offline",
    { projectRoot: projectRootFor(host) },
  );
  addDashboardOperationFailure({
    targetKind: "agent",
    operation: "create",
    title: `Failed to create ${input.toolConfigKey} agent`,
    message,
    targetId: input.sessionId,
    worktreePath: input.targetWorktreePath,
  });
  (host as any).publishAlert?.({
    kind: "task_failed",
    title: `Failed to create ${input.toolConfigKey} agent`,
    message,
    worktreePath: input.targetWorktreePath,
    dedupeKey: `agent-create-failed:${input.sessionId}:${message}`,
  });
  notifyLifecycleChange(host);
}

async function runScheduledSessionCreate(host: Multiplexer, input: ScheduledSessionCreate): Promise<void> {
  try {
    const transport = await createSessionAsync(
      host,
      input.command,
      input.args,
      input.preambleFlag,
      input.toolConfigKey,
      undefined,
      input.sessionIdFlag,
      input.targetWorktreePath,
      undefined,
      input.sessionId,
      input.detached,
      false,
      input.team,
      input.env,
    );
    await verifyCreatedTmuxWindow(host, input, transport);
    const runtime = findRuntime(host, input.sessionId);
    if ((host as any).graveyardAfterStopSessionIds?.has?.(input.sessionId)) {
      const moved = moveTopologySessionToGraveyard(input.sessionId, { projectRoot: projectRootFor(host) });
      removeOfflineSessionCache(host, input.sessionId);
      if (runtime) {
        forgetRuntimeSession(host, input.sessionId);
        scheduleRuntimeKill(host, runtime, input.sessionId);
      } else if (transport instanceof TmuxSessionTransport) {
        scheduleTmuxTargetKill(host, transport.tmuxTarget, input.sessionId);
      }
      if (!moved) recordSessionCreateFailure(host, input, new Error("graveyard request lost during startup"));
      else notifyLifecycleChange(host);
      return;
    }
    if ((host as any).stoppingSessionIds?.has?.(input.sessionId)) {
      const existing = findTopologySession(host, input.sessionId);
      if (existing) markTopologySessionOffline(host, existing);
      if (runtime) {
        forgetRuntimeSession(host, input.sessionId);
        scheduleRuntimeKill(host, runtime, input.sessionId);
      } else if (transport instanceof TmuxSessionTransport) {
        scheduleTmuxTargetKill(host, transport.tmuxTarget, input.sessionId);
      }
      notifyLifecycleChange(host);
      return;
    }
    if (input.overseer) {
      setSessionOverseer(transport.id, true);
    }
    if (input.label) {
      host.applySessionLabel(transport.id, input.label);
    }
    if (input.open) {
      host.openLiveTmuxWindowForEntry({ id: transport.id });
    }
    clearDashboardOperationFailures({ targetKind: "agent", operation: "create", targetId: input.sessionId });
    notifyLifecycleChange(host);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (host as any).debug?.(`failed to create tmux window for ${input.sessionId}: ${message}`, "session");
    recordSessionCreateFailure(host, input, error);
  }
}

function scheduleNextSessionCreate(): void {
  const timer = setTimeout(async () => {
    const next = sessionCreateQueue.shift();
    if (!next) {
      sessionCreateQueueRunning = false;
      return;
    }
    await runScheduledSessionCreate(next.host, next.input);
    if (sessionCreateQueue.length > 0) {
      scheduleNextSessionCreate();
    } else {
      sessionCreateQueueRunning = false;
    }
  }, 50);
  timer.unref?.();
}

function scheduleSessionCreate(host: Multiplexer, input: ScheduledSessionCreate): void {
  sessionCreateQueue.push({ host, input });
  if (sessionCreateQueueRunning) return;
  sessionCreateQueueRunning = true;
  scheduleNextSessionCreate();
}

export type DashboardTailMethods = {
  forkAgent(
    this: Multiplexer,
    opts: {
      sourceSessionId: string;
      targetToolConfigKey: string;
      targetSessionId?: string;
      instruction?: string;
      targetWorktreePath?: string;
      open?: boolean;
      launchOverride?: LaunchOverride;
    },
  ): Promise<{ sessionId: string; threadId: string }>;
  spawnAgent(
    this: Multiplexer,
    opts: {
      toolConfigKey: string;
      targetSessionId?: string;
      targetWorktreePath?: string;
      open?: boolean;
      launchOverride?: LaunchOverride;
      overseer?: boolean;
    },
  ): Promise<{ sessionId: string }>;
  createTeammateAgent(
    this: Multiplexer,
    opts: {
      parentSessionId: string;
      role?: string;
      label?: string;
      toolConfigKey?: string;
      targetSessionId?: string;
      targetWorktreePath?: string;
      open?: boolean;
      extraArgs?: string[];
      order?: number;
    },
  ): Promise<{ sessionId: string; parentSessionId: string; teamId: string; role?: string; label?: string }>;
  renameAgent(this: Multiplexer, sessionId: string, label?: string): Promise<{ sessionId: string; label?: string }>;
  stopAgent(this: Multiplexer, sessionId: string): Promise<{ sessionId: string; status: "offline" }>;
  sendAgentToGraveyard(
    this: Multiplexer,
    sessionId: string,
  ): Promise<{
    sessionId: string;
    status: "graveyard";
    previousStatus: "running" | "offline";
  }>;
  migrateAgentSession(
    this: Multiplexer,
    sessionId: string,
    targetWorktreePath: string,
  ): Promise<{ sessionId: string; worktreePath?: string }>;
  showGraveyard(this: Multiplexer): void;
  renderGraveyard(this: Multiplexer): void;
  handleGraveyardKey(this: Multiplexer, data: Buffer): void;
  resurrectGraveyardEntry(this: Multiplexer, idx: number): void;
  showLibrary(this: Multiplexer): void;
  renderLibrary(this: Multiplexer): void;
  renderGraveyardDetails(this: Multiplexer, width: number, height: number): string[];
  handleLibraryKey(this: Multiplexer, data: Buffer): void;
  getSwitcherList(this: Multiplexer): SessionRuntime[];
  showSwitcher(this: Multiplexer): void;
  resetSwitcherTimeout(this: Multiplexer): void;
  confirmSwitcher(this: Multiplexer): void;
  dismissSwitcher(this: Multiplexer): void;
  redrawCurrentView(this: Multiplexer): void;
  showHelp(this: Multiplexer): void;
  dismissHelp(this: Multiplexer): void;
  renderHelp(this: Multiplexer): void;
  handleHelpKey(this: Multiplexer, data: Buffer): void;
  renderSwitcher(this: Multiplexer): void;
  handleSwitcherKey(this: Multiplexer, data: Buffer): void;
  showMigratePicker(this: Multiplexer, sessionId?: string): void;
  renderMigratePicker(this: Multiplexer): void;
  runDashboardOperation<T>(
    this: Multiplexer,
    title: string,
    lines: string[],
    work: () => Promise<T> | T,
    errorTitle?: string,
  ): Promise<T | undefined>;
  setPendingDashboardSessionAction(
    this: Multiplexer,
    sessionId: string,
    kind: PendingSessionActionKind | null,
    opts?: { sessionSeed?: DashboardSession },
  ): number | undefined;
  setPendingDashboardServiceAction(
    this: Multiplexer,
    serviceId: string,
    kind: PendingServiceActionKind | null,
    opts?: { serviceSeed?: DashboardService },
  ): number | undefined;
  stopSessionToOfflineWithFeedback(this: Multiplexer, session: SessionRuntime): Promise<void>;
  clearDashboardSubscreens(this: Multiplexer): void;
  renderSessionDetails(
    this: Multiplexer,
    session: DashboardSession | undefined,
    width: number,
    height: number,
  ): string[];
  wrapKeyValue(this: Multiplexer, key: string, value: string, width: number): string[];
  wrapText(this: Multiplexer, text: string, width: number): string[];
  truncatePlain(this: Multiplexer, text: string, max: number): string;
  truncateAnsi(this: Multiplexer, text: string, max: number): string;
  basename(this: Multiplexer, value: string): string;
  listAllWorktrees(this: Multiplexer): Array<{ name: string; branch: string; path: string; isBare: boolean }>;
  graveyardSessionWithFeedback(this: Multiplexer, sessionId: string, hasWorktrees: boolean): Promise<void>;
  resumeOfflineServiceWithFeedback(
    this: Multiplexer,
    service: Pick<DashboardService, "id" | "label">,
  ): Promise<DashboardMutationResult>;
  createDashboardServiceWithFeedback(this: Multiplexer, commandLine: string, worktreePath?: string): Promise<void>;
  stopDashboardServiceWithFeedback(this: Multiplexer, service: Pick<DashboardService, "id" | "label">): Promise<void>;
  removeDashboardServiceWithFeedback(this: Multiplexer, service: Pick<DashboardService, "id" | "label">): Promise<void>;
  resumeOfflineSessionWithFeedback(this: Multiplexer, session: SessionState): Promise<DashboardMutationResult>;
  waitForSessionStart(this: Multiplexer, sessionId: string, timeoutMs?: number): Promise<boolean>;
  dashboardSessionActionDeps(this: Multiplexer): ReturnType<typeof dashboardSessionActionDepsImpl>;
  migrateSessionWithFeedback(
    this: Multiplexer,
    session: SessionRuntime,
    targetPath: string,
    targetName: string,
  ): Promise<void>;
  handleMigratePickerKey(this: Multiplexer, data: Buffer): void;
  getDashboardSessions(this: Multiplexer): DashboardSession[];
  getDashboardServices(this: Multiplexer): DashboardService[];
  getDashboardSessionsInVisualOrder(this: Multiplexer): DashboardSession[];
};

export const dashboardTailMethods: DashboardTailMethods = {
  async forkAgent(opts) {
    const result = await (this as any).forkSessionFromSource(
      opts.sourceSessionId,
      opts.targetToolConfigKey,
      opts.targetSessionId,
      opts.instruction,
      opts.targetWorktreePath,
      opts.launchOverride,
    );
    if (!result) {
      throw new Error(`Unable to fork agent "${opts.sourceSessionId}"`);
    }
    if (opts.open) {
      this.openLiveTmuxWindowForEntry({ id: result.sessionId });
    }
    return { sessionId: result.sessionId, threadId: result.threadId };
  },
  async spawnAgent(opts) {
    const config = loadConfig();
    const tool = config.tools[opts.toolConfigKey];
    if (!tool) {
      throw new Error(`Unknown tool config: ${opts.toolConfigKey}`);
    }
    const sessionId = opts.targetSessionId ?? (this as any).generateDashboardSessionId?.(tool.command);
    const team: SessionTeamMetadata | undefined = opts.overseer
      ? { teamId: "overseer", parentSessionId: "", role: "overseer" }
      : undefined;
    const createInput: ScheduledSessionCreate = {
      command: opts.launchOverride?.command ?? tool.command,
      args: opts.launchOverride?.args ?? tool.args,
      preambleFlag: tool.preambleFlag,
      toolConfigKey: opts.toolConfigKey,
      sessionIdFlag: tool.sessionIdFlag,
      targetWorktreePath: opts.targetWorktreePath,
      sessionId,
      detached: !opts.open,
      team,
      env: opts.launchOverride?.env,
      open: opts.open,
      overseer: opts.overseer,
    };
    recordStartingSession(this, createInput);
    notifyLifecycleChange(this);
    scheduleSessionCreate(this, createInput);
    return { sessionId };
  },
  async createTeammateAgent(opts) {
    const config = loadConfig();
    const toolConfigKey = opts.toolConfigKey ?? config.defaultTool;
    const tool = config.tools[toolConfigKey];
    if (!tool) {
      throw new Error(`Unknown tool config: ${toolConfigKey}`);
    }
    const sessionId = opts.targetSessionId ?? (this as any).generateDashboardSessionId?.(tool.command);
    const team: SessionTeamMetadata = {
      teamId: `team-${opts.parentSessionId}`,
      parentSessionId: opts.parentSessionId,
      role: opts.role,
      label: opts.label,
      order: typeof opts.order === "number" ? opts.order : undefined,
    };
    const createInput: ScheduledSessionCreate = {
      command: tool.command,
      args: [...tool.args, ...(opts.extraArgs ?? [])],
      preambleFlag: tool.preambleFlag,
      toolConfigKey,
      sessionIdFlag: tool.sessionIdFlag,
      targetWorktreePath: opts.targetWorktreePath,
      sessionId,
      detached: !opts.open,
      team,
      label: opts.label,
      open: opts.open,
    };
    recordStartingSession(this, createInput);
    notifyLifecycleChange(this);
    scheduleSessionCreate(this, createInput);
    return {
      sessionId,
      parentSessionId: opts.parentSessionId,
      teamId: team.teamId,
      role: opts.role,
      label: opts.label,
    };
  },
  async renameAgent(sessionId, label) {
    await this.updateSessionLabel(sessionId, label);
    return { sessionId, label: label?.trim() || undefined };
  },
  async stopAgent(sessionId) {
    const projectRoot = projectRootFor(this);
    const runtime = resolveLifecycleRuntime(this, sessionId);
    if (runtime) {
      if ((this as any).graveyardAfterStopSessionIds?.has?.(sessionId)) {
        throw new Error(`Session "${sessionId}" is being sent to graveyard`);
      }
      if ((this as any).stoppingSessionIds?.has?.(sessionId)) {
        return { sessionId, status: "offline" };
      }
      const offlineEntry = runtimeToTopologySessionState(this, runtime);
      upsertTopologySession(offlineEntry, "offline", { projectRoot });
      cacheOfflineSession(this, offlineEntry);
      (this as any).stoppingSessionIds?.add?.(sessionId);
      (this as any).startedInDashboard = true;
      forgetRuntimeSession(this, sessionId);
      scheduleRuntimeKill(this, runtime, sessionId);
      notifyLifecycleChange(this);
      (this as any).debug?.(`stopped session ${sessionId} -> offline`, "session");
      return { sessionId, status: "offline" };
    }
    const existing = findTopologySession(this, sessionId);
    if (existing?.status === "offline") {
      cacheOfflineSession(this, existing);
      return { sessionId, status: "offline" };
    }
    if (existing && isLiveTopologyStatus(existing.status)) {
      const canceled = cancelQueuedSessionCreate(this, sessionId);
      const tmuxTarget = canceled ? undefined : resolveLiveTmuxTargetForSession(this, sessionId);
      markTopologySessionOffline(this, existing);
      (this as any).stoppingSessionIds?.add?.(sessionId);
      if (tmuxTarget) scheduleTmuxTargetKill(this, tmuxTarget, sessionId);
      notifyLifecycleChange(this);
      (this as any).debug?.(
        canceled
          ? `canceled queued session create ${sessionId} -> offline`
          : `reconciled unowned live session ${sessionId} -> offline`,
        "session",
      );
      return { sessionId, status: "offline" };
    }
    if (existing?.status === "graveyard") {
      throw new Error(`Session "${sessionId}" is already in graveyard`);
    }
    throw new Error(`Unknown session "${sessionId}"`);
  },
  async sendAgentToGraveyard(sessionId) {
    const projectRoot = projectRootFor(this);
    const runtime = resolveLifecycleRuntime(this, sessionId);
    const existing = findTopologySession(this, sessionId);
    const previousStatus: "running" | "offline" =
      runtime || isLiveTopologyStatus(existing?.status) ? "running" : "offline";
    if (existing?.status === "graveyard") {
      return { sessionId, status: "graveyard", previousStatus };
    }
    if (!runtime && existing && isLiveTopologyStatus(existing.status)) {
      const canceled = cancelQueuedSessionCreate(this, sessionId);
      const tmuxTarget = canceled ? undefined : resolveLiveTmuxTargetForSession(this, sessionId);
      const moved = moveTopologySessionToGraveyard(sessionId, { projectRoot });
      if (!moved) {
        throw new Error(`Unable to graveyard session "${sessionId}"`);
      }
      removeOfflineSessionCache(this, sessionId);
      (this as any).graveyardAfterStopSessionIds?.add?.(sessionId);
      (this as any).stoppingSessionIds?.add?.(sessionId);
      if (tmuxTarget) scheduleTmuxTargetKill(this, tmuxTarget, sessionId);
      notifyLifecycleChange(this);
      (this as any).debug?.(
        canceled
          ? `canceled queued session create ${sessionId} -> graveyard`
          : `reconciled unowned live session ${sessionId} -> graveyard`,
        "session",
      );
      return { sessionId, status: "graveyard", previousStatus };
    }
    if (runtime && !existing) {
      upsertTopologySession(runtimeToTopologySessionState(this, runtime), "running", { projectRoot });
    } else if (!runtime && !existing) {
      throw new Error(`Unknown session "${sessionId}"`);
    }
    const moved = moveTopologySessionToGraveyard(sessionId, { projectRoot });
    if (!moved) {
      throw new Error(`Unable to graveyard session "${sessionId}"`);
    }
    removeOfflineSessionCache(this, sessionId);
    if (runtime) {
      (this as any).graveyardAfterStopSessionIds?.add?.(sessionId);
      (this as any).stoppingSessionIds?.add?.(sessionId);
      forgetRuntimeSession(this, sessionId);
      scheduleRuntimeKill(this, runtime, sessionId);
    }
    notifyLifecycleChange(this);
    (this as any).debug?.(`graveyarded session ${sessionId}`, "session");
    return { sessionId, status: "graveyard", previousStatus };
  },
  async migrateAgentSession(sessionId, targetWorktreePath) {
    await this.migrateAgent(sessionId, targetWorktreePath);
    return { sessionId, worktreePath: targetWorktreePath };
  },
  showGraveyard() {
    showGraveyardImpl(this);
  },
  renderGraveyard() {
    renderGraveyardImpl(this);
  },
  handleGraveyardKey(data) {
    handleGraveyardKeyImpl(this, data);
  },
  resurrectGraveyardEntry(idx) {
    resurrectGraveyardEntryImpl(this, idx);
  },
  showLibrary() {
    showLibraryImpl(this);
  },
  renderLibrary() {
    renderLibraryImpl(this);
  },
  renderGraveyardDetails(width, height) {
    return renderGraveyardDetailsForHostImpl(this, width, height);
  },
  handleLibraryKey(data) {
    handleLibraryKeyImpl(this, data);
  },
  getSwitcherList() {
    return getSwitcherListImpl(this);
  },
  showSwitcher() {
    showSwitcherImpl(this);
  },
  resetSwitcherTimeout() {
    resetSwitcherTimeoutImpl(this);
  },
  confirmSwitcher() {
    confirmSwitcherImpl(this);
  },
  dismissSwitcher() {
    dismissSwitcherImpl(this);
  },
  redrawCurrentView() {
    redrawCurrentViewImpl(this);
  },
  showHelp() {
    showHelpImpl(this);
  },
  dismissHelp() {
    dismissHelpImpl(this);
  },
  renderHelp() {
    renderHelpImpl(this);
  },
  handleHelpKey(data) {
    handleHelpKeyImpl(this, data);
  },
  renderSwitcher() {
    renderSwitcherImpl(this);
  },
  handleSwitcherKey(data) {
    handleSwitcherKeyImpl(this, data);
  },
  showMigratePicker(sessionId?: string) {
    showMigratePickerImpl(this, sessionId);
  },
  renderMigratePicker() {
    renderMigratePickerImpl(this);
  },
  async runDashboardOperation(title, lines, work, errorTitle = title) {
    return runDashboardOperationImpl(this, title, lines, work, errorTitle);
  },
  setPendingDashboardSessionAction(sessionId, kind, opts) {
    return setPendingDashboardSessionActionImpl(this, sessionId, kind, opts);
  },
  setPendingDashboardServiceAction(serviceId, kind, opts) {
    return setPendingDashboardServiceActionImpl(this, serviceId, kind, opts);
  },
  async stopSessionToOfflineWithFeedback(session) {
    await stopSessionToOfflineWithFeedbackImpl(this, session);
  },
  clearDashboardSubscreens() {
    clearDashboardSubscreensImpl(this);
  },
  renderSessionDetails(session, width, height) {
    return renderSessionDetailsImpl(this, session, width, height);
  },
  wrapKeyValue(key, value, width) {
    return wrapKeyValueForHost(key, value, width);
  },
  wrapText(text, width) {
    return wrapTextForHost(text, width);
  },
  truncatePlain(text, max) {
    return truncatePlainForHost(text, max);
  },
  truncateAnsi(text, max) {
    return truncateAnsiForHost(text, max);
  },
  basename(value) {
    return basenameForHost(value);
  },
  listAllWorktrees() {
    return listAllWorktrees();
  },
  async graveyardSessionWithFeedback(sessionId, hasWorktrees) {
    await graveyardSessionWithFeedbackImpl(this, sessionId, hasWorktrees);
  },
  async resumeOfflineServiceWithFeedback(service) {
    return resumeOfflineServiceWithFeedbackImpl(this, service);
  },
  async createDashboardServiceWithFeedback(commandLine, worktreePath) {
    await createDashboardServiceWithFeedbackImpl(this, commandLine, worktreePath);
  },
  async stopDashboardServiceWithFeedback(service) {
    await stopDashboardServiceWithFeedbackImpl(this, service);
  },
  async removeDashboardServiceWithFeedback(service) {
    await removeDashboardServiceWithFeedbackImpl(this, service);
  },
  async resumeOfflineSessionWithFeedback(session) {
    return resumeOfflineSessionWithFeedbackImpl(this, session);
  },
  async waitForSessionStart(sessionId, timeoutMs = 8000) {
    return waitForSessionStartForHost(this, sessionId, timeoutMs);
  },
  dashboardSessionActionDeps() {
    return dashboardSessionActionDepsImpl(this);
  },
  async migrateSessionWithFeedback(session, targetPath, targetName) {
    await migrateSessionWithFeedbackImpl(this, session, targetPath, targetName);
  },
  handleMigratePickerKey(data) {
    handleMigratePickerKeyImpl(this, data);
  },
  getDashboardSessions() {
    const mux = this as unknown as DashboardTailHost;
    return mux.mode === "dashboard" ? mux.dashboardSessionsCache : this.computeDashboardSessions();
  },
  getDashboardServices() {
    const mux = this as unknown as DashboardTailHost;
    return mux.mode === "dashboard" ? mux.dashboardServicesCache : this.computeDashboardServices();
  },
  getDashboardSessionsInVisualOrder() {
    const mux = this as unknown as DashboardTailHost;
    const allDash = this.getDashboardSessions();
    if (mux.mode === "dashboard") {
      const mainSessions = allDash.filter((session) => !session.worktreePath);
      const ordered = [...mainSessions];
      const seen = new Set(mainSessions.map((session) => session.id));
      for (const group of mux.dashboardWorktreeGroupsCache) {
        for (const session of group.sessions) {
          if (seen.has(session.id)) continue;
          ordered.push(session);
          seen.add(session.id);
        }
      }
      for (const session of allDash) {
        if (!seen.has(session.id)) ordered.push(session);
      }
      return ordered;
    }
    let mainRepoPath: string | undefined;
    try {
      mainRepoPath = findMainRepo();
    } catch {}
    let worktreePaths: Array<string | undefined> = [];
    try {
      const worktrees = listAllWorktrees();
      worktreePaths = [
        undefined,
        ...worktrees.filter((wt) => !wt.isBare && wt.path !== mainRepoPath).map((wt) => wt.path),
      ];
    } catch {
      return allDash;
    }
    return orderDashboardSessionsByVisualWorktree(allDash, worktreePaths, mainRepoPath);
  },
};
