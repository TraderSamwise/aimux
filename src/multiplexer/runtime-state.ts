import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { loadMetadataState, updateSessionMetadata } from "../metadata-store.js";
import { getRepoRoot } from "../paths.js";
import { isToolInternalWorktree, listWorktrees as listAllWorktrees } from "../worktree.js";
import { isDashboardWindowName } from "../tmux/runtime-manager.js";
import { TmuxSessionTransport } from "../tmux/session-transport.js";
import { markLastUsed } from "../last-used.js";
import { listWorktreeGraveyardPaths } from "./worktree-graveyard.js";
import { getServiceLaunchCommandLine } from "./services.js";
import {
  listTopologySessionStates,
  moveTopologySessionToGraveyard,
  upsertTopologySession,
} from "../runtime-core/topology-sessions.js";
import { listTopologyServiceStates } from "../runtime-core/topology-services.js";
import { reconcileBackendSessionIdForSession } from "../runtime-core/backend-id-reconcile.js";
import { recordTopologyBackendSessionId } from "../runtime-core/backend-session-ids.js";

type RuntimeStateHost = any;

type ManagedAgentWindow = { target: any; metadata: any };

const DASHBOARD_BACKGROUND_REFRESH_MS = 2000;
const IDLE_NOTIFICATION_SETTLE_MS = 10_000;

const idleNotificationCandidates = new WeakMap<
  RuntimeStateHost,
  Map<string, { idleSince: number; notified: boolean }>
>();

function isAvailableWorktreePath(worktreePath?: string, graveyardPaths = listWorktreeGraveyardPaths()): boolean {
  if (!worktreePath) return true;
  if (graveyardPaths.has(worktreePath)) return false;
  return existsSync(worktreePath);
}

function listLiveAgentWindows(host: RuntimeStateHost): ManagedAgentWindow[] {
  if (!host.tmuxRuntimeManager?.listProjectManagedWindows) return [];
  const graveyardPaths = listWorktreeGraveyardPaths();
  const windows: ManagedAgentWindow[] = [];
  for (const entry of host.tmuxRuntimeManager.listProjectManagedWindows(process.cwd())) {
    const { target, metadata } = entry;
    if (isDashboardWindowName(target.windowName)) continue;
    if (metadata.kind !== "agent") continue;
    if (!isAvailableWorktreePath(metadata.worktreePath, graveyardPaths)) continue;
    if (host.tmuxRuntimeManager.isWindowAlive && !host.tmuxRuntimeManager.isWindowAlive(target)) continue;
    windows.push(entry);
  }
  return windows;
}

function removeRuntimeRegistration(host: RuntimeStateHost, runtime: any): void {
  const idx = host.sessions.indexOf(runtime);
  if (idx >= 0) {
    host.sessions.splice(idx, 1);
  }
  host.stoppingSessionIds?.delete?.(runtime.id);
  host.sessionTmuxTargets.delete(runtime.id);
  host.sessionToolKeys?.delete?.(runtime.id);
  host.sessionOriginalArgs?.delete?.(runtime.id);
  host.sessionWorktreePaths?.delete?.(runtime.id);
  host.sessionRoles?.delete?.(runtime.id);
}

function offlineSessionState(session: any): any {
  const { tmuxTarget: _tmuxTarget, ...rest } = session;
  return { ...rest, lifecycle: "offline" };
}

function markLifecycleUsed(host: RuntimeStateHost, itemId: string): void {
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

function isIntentionalOfflineSession(session: any): boolean {
  if (session.lifecycle === "offline") return true;
  if (session.lifecycle === "live")
    return Boolean(session.id && (session.command || session.tool || session.toolConfigKey));
  if (session.lifecycle) return false;
  return !session.tmuxTarget;
}

export function renderCurrentDashboardView(host: RuntimeStateHost): void {
  host.reconcileDashboardRenderState();
  if (host.isDashboardScreen("coordination")) {
    host.renderCoordination();
    return;
  }
  if (host.isDashboardScreen("project")) {
    host.renderProject();
    return;
  }
  if (host.isDashboardScreen("library")) {
    host.renderLibrary();
    return;
  }
  if (host.isDashboardScreen("topology")) {
    host.renderTopology();
    return;
  }
  if (host.isDashboardScreen("help")) {
    host.renderHelp();
    return;
  }
  if (host.isDashboardScreen("graveyard")) {
    host.renderGraveyard();
    return;
  }
  host.renderDashboard();
}

export function startStatusRefresh(host: RuntimeStateHost): void {
  if (host.statusInterval) return;
  host.statusInterval = setInterval(() => {
    const idleCandidates =
      idleNotificationCandidates.get(host) ?? new Map<string, { idleSince: number; notified: boolean }>();
    idleNotificationCandidates.set(host, idleCandidates);
    let dashboardNeedsRender = false;

    if (host.dashboardFeedback.tickFlashVisibilityChanged()) {
      dashboardNeedsRender = true;
    }

    for (const session of host.sessions) {
      const prev = host.prevStatuses.get(session.id);
      const curr = session.status;
      const candidate = idleCandidates.get(session.id);
      if (curr !== "idle") {
        idleCandidates.delete(session.id);
      } else if (prev && prev !== curr && prev === "running") {
        idleCandidates.set(session.id, { idleSince: Date.now(), notified: false });
      } else if (candidate && !candidate.notified && Date.now() - candidate.idleSince >= IDLE_NOTIFICATION_SETTLE_MS) {
        host.publishAlert({
          kind: "next_step",
          sessionId: session.id,
          title: `${session.id} ready for next step`,
          message: "Agent stopped after a turn.",
          // Keep the legacy prefix so renamed idle alerts dedupe with prior needs-input alerts.
          dedupeKey: `idle-needs-input:${session.id}`,
          cooldownMs: 15_000,
        });
        candidate.notified = true;
      }
      host.prevStatuses.set(session.id, curr);
    }

    if (host.mode === "dashboard") {
      const now = Date.now();
      if (now >= host.dashboardNextBackgroundRefreshAt) {
        host.dashboardNextBackgroundRefreshAt = now + DASHBOARD_BACKGROUND_REFRESH_MS;
        void host.refreshDashboardModelFromService().then((refreshed: boolean) => {
          if (refreshed || dashboardNeedsRender) {
            host.renderCurrentDashboardView();
          }
        });
      } else if (dashboardNeedsRender) {
        host.renderCurrentDashboardView();
      }
    }
  }, 1000);
}

export function stopStatusRefresh(host: RuntimeStateHost): void {
  if (host.statusInterval) {
    clearInterval(host.statusInterval);
    host.statusInterval = null;
  }
  idleNotificationCandidates.delete(host);
}

export function syncSessionsFromTopology(host: RuntimeStateHost): void {
  const state = host.constructor.loadState();
  const liveAgentWindows = restoreTmuxSessionsFromTopology(host);
  reconcileOrphanedTopologySessions(host, liveAgentWindows);
  loadOfflineTopologySessions(host, liveAgentWindows);
  loadOfflineServices(host, state);
  host.invalidateDesktopStateSnapshot();
}

// A persisted session whose working directory is gone for good (deleted on disk,
// not merely graveyarded as a worktree we could resurrect) can never be relaunched.
function isOrphanWorktreeUnrecoverable(worktreePath: string | undefined, graveyardPaths: Set<string>): boolean {
  if (!worktreePath || graveyardPaths.has(worktreePath)) return false;
  return !isAvailableWorktreePath(worktreePath, graveyardPaths);
}

// After a crash or hard restart the tmux server is gone, so sessions persisted as
// running/idle have no live window and are surfaced by neither the live-restore nor
// the offline-load path — they silently vanish. Reconcile them so no agent is lost:
// demote recoverable orphans to offline (resumable), and document unrecoverable ones
// in the graveyard with a reason instead of dropping them.
export function reconcileOrphanedTopologySessions(
  host: RuntimeStateHost,
  liveAgentWindows = listLiveAgentWindows(host),
): boolean {
  const candidates = listTopologySessionStates({ statuses: ["running", "idle", "offline"] });
  if (candidates.length === 0) return false;

  const liveIds = new Set(liveAgentWindows.map(({ metadata }) => metadata.sessionId));
  const ownedIds = new Set<string>(host.sessions.map((session: any) => session.id));
  const ownedBackendIds = new Set(
    host.sessions
      .map((session: any) => session.backendSessionId)
      .filter((value: any): value is string => Boolean(value)),
  );
  const graveyardPaths = listWorktreeGraveyardPaths();

  let changed = false;
  for (const session of candidates) {
    if (liveIds.has(session.id)) continue;
    if (ownedIds.has(session.id)) continue;
    if (session.backendSessionId && ownedBackendIds.has(session.backendSessionId)) continue;
    if (host.dashboardPendingActions?.getSessionAction?.(session.id) === "starting") continue;

    if (isOrphanWorktreeUnrecoverable(session.worktreePath, graveyardPaths)) {
      const reason = `worktree missing after restart: ${session.worktreePath}`;
      moveTopologySessionToGraveyard(session.id, { reason });
      host.debug?.(`graveyarded unrecoverable orphaned session ${session.id}: ${reason}`, "session");
      changed = true;
      continue;
    }

    if (session.status === "offline") continue;
    upsertTopologySession({ ...session, lifecycle: "offline", tmuxTarget: undefined }, "offline");
    host.debug?.(`reconciled orphaned session ${session.id} → offline (no live tmux window)`, "session");
    changed = true;
  }
  return changed;
}

export function loadOfflineTopologySessions(
  host: RuntimeStateHost,
  liveAgentWindows = listLiveAgentWindows(host),
): boolean {
  const savedSessions = listTopologySessionStates({ statuses: ["offline"] });
  if (savedSessions.length === 0) {
    const changed = host.offlineSessions.length > 0;
    host.offlineSessions = [];
    return changed;
  }

  const liveIds = new Set(liveAgentWindows.map(({ metadata }) => metadata.sessionId));
  const ownedIds = new Set<string>();
  for (const s of host.sessions) ownedIds.add(s.id);

  const ownedBackendIds = new Set(
    host.sessions
      .map((session: any) => session.backendSessionId)
      .filter((value: any): value is string => Boolean(value)),
  );

  const nextOfflineSessions = savedSessions
    .filter((s: any) => {
      if (!isIntentionalOfflineSession(s)) return false;
      if (liveIds.has(s.id)) return false;
      if (ownedIds.has(s.id)) return false;
      if (s.backendSessionId && ownedBackendIds.has(s.backendSessionId)) return false;
      if (host.dashboardPendingActions?.getSessionAction?.(s.id) === "starting") return false;
      if (!isAvailableWorktreePath(s.worktreePath)) return false;
      return true;
    })
    .map(offlineSessionState);
  const previousKey = host.offlineSessions
    .map(
      (session: any) =>
        `${session.id}:${session.label ?? ""}:${session.worktreePath ?? ""}:${session.backendSessionId ?? ""}:${JSON.stringify(session.team ?? null)}`,
    )
    .join("|");
  const nextKey = nextOfflineSessions
    .map(
      (session: any) =>
        `${session.id}:${session.label ?? ""}:${session.worktreePath ?? ""}:${session.backendSessionId ?? ""}:${JSON.stringify(session.team ?? null)}`,
    )
    .join("|");
  host.offlineSessions = nextOfflineSessions;

  if (host.offlineSessions.length > 0) {
    host.debug?.(`loaded ${host.offlineSessions.length} offline session(s) from runtime topology`, "session");
  }
  return previousKey !== nextKey;
}

export function loadOfflineServices(host: RuntimeStateHost, state = host.constructor.loadState()): boolean {
  const topologyServices = listTopologyServiceStates({ statuses: ["stopped", "offline"] });
  const savedServices = topologyServices.length > 0 ? topologyServices : (state?.services ?? []);
  if (savedServices.length === 0) {
    const changed = host.offlineServices.length > 0;
    host.offlineServices = [];
    return changed;
  }

  const liveServiceIds = new Set(
    host.tmuxRuntimeManager
      .listProjectManagedWindows(process.cwd())
      .filter(
        ({ target, metadata }: any) =>
          !isDashboardWindowName(target.windowName) &&
          metadata.kind === "service" &&
          host.tmuxRuntimeManager.isWindowAlive(target) &&
          !savedServices.some((service: any) => service.id === metadata.sessionId && service.retained),
      )
      .map(({ metadata }: any) => metadata.sessionId),
  );

  const nextOfflineServices = savedServices.filter((service: any) => {
    if (liveServiceIds.has(service.id)) return false;
    if (host.dashboardPendingActions?.getServiceAction?.(service.id) === "starting") return false;
    if (!isAvailableWorktreePath(service.worktreePath)) return false;
    return true;
  });
  const previousKey = host.offlineServices
    .map(
      (service: any) =>
        `${service.id}:${service.label ?? ""}:${service.worktreePath ?? ""}:${service.cwd ?? ""}:${service.launchCommandLine ?? ""}:${service.tmuxTarget?.windowId ?? ""}:${service.retained ? "retained" : ""}`,
    )
    .join("|");
  const nextKey = nextOfflineServices
    .map(
      (service: any) =>
        `${service.id}:${service.label ?? ""}:${service.worktreePath ?? ""}:${service.cwd ?? ""}:${service.launchCommandLine ?? ""}:${service.tmuxTarget?.windowId ?? ""}:${service.retained ? "retained" : ""}`,
    )
    .join("|");
  host.offlineServices = nextOfflineServices;
  return previousKey !== nextKey;
}

export function buildLiveServiceStates(host: RuntimeStateHost): any[] {
  const seen = new Set<string>();
  const graveyardPaths = listWorktreeGraveyardPaths();
  const liveServices: any[] = [];
  for (const { target, metadata } of host.tmuxRuntimeManager.listProjectManagedWindows(process.cwd())) {
    if (metadata.kind !== "service") continue;
    if (!host.tmuxRuntimeManager.isWindowAlive(target)) continue;
    if (!isAvailableWorktreePath(metadata.worktreePath, graveyardPaths)) continue;
    if (seen.has(metadata.sessionId)) continue;
    seen.add(metadata.sessionId);
    const launchCommandLine = metadata.launchCommandLine?.trim() || getServiceLaunchCommandLine(metadata);
    liveServices.push({
      id: metadata.sessionId,
      createdAt: metadata.createdAt,
      worktreePath: metadata.worktreePath,
      label: metadata.label,
      launchCommandLine,
      cwd: host.tmuxRuntimeManager.displayMessage("#{pane_current_path}", target.windowId) ?? metadata.worktreePath,
      tmuxTarget: target,
    });
  }
  return liveServices;
}

export function restoreTmuxSessionsFromTopology(host: RuntimeStateHost): ManagedAgentWindow[] {
  const savedSessions = listTopologySessionStates({ statuses: ["running", "idle", "offline"] });
  const savedById = new Map<string, any>(savedSessions.map((session: any) => [session.id, session]));
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const liveAgentWindows = listLiveAgentWindows(host);
  const liveById = new Map<string, ManagedAgentWindow>(
    liveAgentWindows.map((entry) => [entry.metadata.sessionId, entry]),
  );

  for (const runtime of [...host.sessions]) {
    const live = liveById.get(runtime.id);
    if (!live) {
      host.debug?.(`evicting stale runtime ${runtime.id}: no live tmux metadata`, "session");
      removeRuntimeRegistration(host, runtime);
      continue;
    }
    const target = host.sessionTmuxTargets.get(runtime.id);
    if (!target || target.windowId !== live.target.windowId) {
      host.sessionTmuxTargets.set(runtime.id, live.target);
      if (runtime.transport instanceof TmuxSessionTransport) {
        runtime.transport.retarget(live.target);
      }
    }
  }

  if (host.sessions.length === 0) {
    host.contextWatcher?.stop?.();
  }

  for (const { target, metadata } of liveAgentWindows) {
    const existing = host.sessions.find((session: any) => session.id === metadata.sessionId);
    if (existing) continue;

    const transport = new TmuxSessionTransport(
      metadata.sessionId,
      metadata.command,
      target,
      host.tmuxRuntimeManager,
      cols,
      rows,
    );
    host.sessionTmuxTargets.set(metadata.sessionId, target);
    const saved = savedById.get(metadata.sessionId);
    const backendSessionId = metadata.backendSessionId ?? saved?.backendSessionId;
    if (backendSessionId) {
      transport.backendSessionId = backendSessionId;
    }
    host.registerManagedSession(
      transport,
      metadata.args,
      metadata.toolConfigKey,
      metadata.worktreePath,
      metadata.role,
      metadata.createdAt ? Date.parse(metadata.createdAt) : undefined,
      metadata.team,
    );

    if (backendSessionId) {
      const runtime = host.sessions.find((session: any) => session.id === metadata.sessionId);
      if (runtime) runtime.backendSessionId = backendSessionId;
    }
    const label = metadata.label ?? saved?.label;
    if (label) {
      host.sessionLabels.set(metadata.sessionId, label);
    }
    if (target.windowName !== metadata.command) {
      transport.renameWindow(metadata.command);
    }
    host.syncTmuxWindowMetadata(metadata.sessionId);
  }

  host.updateContextWatcherSessions?.();
  return liveAgentWindows;
}

export function stopSessionToOffline(host: RuntimeStateHost, session: any): void {
  if (host.stoppingSessionIds.has(session.id)) return;
  markLifecycleUsed(host, session.id);
  const backendSessionId = session.backendSessionId;
  const offlineEntry = {
    id: session.id,
    tool: session.command,
    toolConfigKey: host.sessionToolKeys.get(session.id) ?? session.command,
    command: session.command,
    args: host.sessionOriginalArgs.get(session.id) ?? [],
    lifecycle: "offline" as const,
    createdAt: session.startTime ? new Date(session.startTime).toISOString() : undefined,
    backendSessionId,
    team: session.team,
    worktreePath: host.sessionWorktreePaths.get(session.id),
    label: host.getSessionLabel(session.id),
    headline: host.deriveHeadline(session.id),
  };

  const existingIndex = host.offlineSessions.findIndex((entry: any) => entry.id === session.id);
  if (existingIndex >= 0) {
    host.offlineSessions[existingIndex] = { ...host.offlineSessions[existingIndex], ...offlineEntry };
  } else {
    host.offlineSessions.push(offlineEntry);
  }
  host.stoppingSessionIds.add(session.id);
  host.startedInDashboard = true;
  upsertTopologySession(offlineEntry, "offline");
  host.saveState();
  session.kill();
  host.debug?.(`stopped session ${session.id} → offline`, "session");
}

export function adjustAfterRemove(host: RuntimeStateHost, hasWorktrees: boolean): void {
  if (hasWorktrees && host.dashboardState.level === "sessions") {
    host.updateWorktreeSessions();
    if (host.dashboardState.worktreeEntries.length === 0) {
      host.dashboardState.level = "worktrees";
    } else if (host.dashboardState.sessionIndex >= host.dashboardState.worktreeEntries.length) {
      host.dashboardState.sessionIndex = host.dashboardState.worktreeEntries.length - 1;
    }
  } else if (!hasWorktrees) {
    const total = host.getDashboardSessions().length;
    if (host.activeIndex >= total) {
      host.activeIndex = Math.max(0, total - 1);
    }
  }
}

export function graveyardSession(host: RuntimeStateHost, sessionId: string, _sessionSeed?: any): void {
  const session =
    host.offlineSessions.find((s: any) => s.id === sessionId) ??
    listTopologySessionStates({ statuses: ["running", "idle", "offline"] }).find((s: any) => s.id === sessionId);
  if (!session) return;
  markLifecycleUsed(host, sessionId);

  host.offlineSessions = host.offlineSessions.filter((s: any) => s.id !== sessionId);

  moveTopologySessionToGraveyard(sessionId);
  host.invalidateDesktopStateSnapshot?.();
  host.writeStatuslineFile?.();
  if (host.mode === "dashboard") {
    host.renderCurrentDashboardView?.();
  }

  host.debug?.(`graveyarded session ${sessionId}`, "session");
}

export function isSessionRuntimeLive(host: RuntimeStateHost, runtime: any): boolean {
  if (runtime.exited) return false;
  const mappedTarget = host.sessionTmuxTargets.get(runtime.id);
  const runtimeTarget = runtime.transport instanceof TmuxSessionTransport ? runtime.transport.tmuxTarget : undefined;
  const target = mappedTarget ?? runtimeTarget;
  if (!target) return false;
  try {
    const resolved = host.tmuxRuntimeManager.getTargetByWindowId(target.sessionName, target.windowId);
    if (!resolved) return false;
    const metadata = host.tmuxRuntimeManager.getWindowMetadata?.(resolved);
    return metadata?.kind === "agent" && metadata.sessionId === runtime.id;
  } catch {
    return false;
  }
}

export function evictZombieSession(host: RuntimeStateHost, runtime: any): void {
  const idx = host.sessions.indexOf(runtime);
  if (idx >= 0) {
    host.sessions.splice(idx, 1);
  }
  host.stoppingSessionIds.delete(runtime.id);
  host.sessionTmuxTargets.delete(runtime.id);
  host.updateContextWatcherSessions();
  host.saveState();
}

export function resumeOfflineSession(host: RuntimeStateHost, session: any): void {
  const existing = host.sessions.find((runtime: any) => runtime.id === session.id);
  if (existing) {
    if (isSessionRuntimeLive(host, existing)) {
      host.offlineSessions = host.offlineSessions.filter((s: any) => s.id !== session.id);
      host.invalidateDesktopStateSnapshot();
      host.writeStatuslineFile();
      return;
    }
    evictZombieSession(host, existing);
  }

  const config = loadConfig();
  const toolCfg = config.tools[session.toolConfigKey];
  if (!toolCfg) return;

  const derived = loadMetadataState().sessions[session.id]?.derived;
  const relaunchFresh = derived?.activity === "error" || derived?.attention === "error";
  let backendSessionId = session.backendSessionId;
  if (!backendSessionId && !relaunchFresh) {
    // The durable backend id can be lost if a crash killed the tmux pane before
    // it was captured. Recover it from the tool's on-disk session store so the
    // agent stays resumable instead of being stranded.
    let discovered: string | null = null;
    try {
      discovered = reconcileBackendSessionIdForSession(session, getRepoRoot());
    } catch (error) {
      host.debug?.(
        `backend session id recovery failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
        "session",
      );
    }
    if (discovered) {
      backendSessionId = discovered;
      session.backendSessionId = discovered;
      const offline = host.offlineSessions.find((entry: any) => entry.id === session.id);
      if (offline) offline.backendSessionId = discovered;
      host.debug?.(`reconciled backend session id for ${session.id} from disk: ${discovered}`, "session");
    }
  }
  const useBackendResume =
    !relaunchFresh && host.sessionBootstrap.canResumeWithBackendSessionId(toolCfg, backendSessionId);

  let actionArgs: string[];
  if (useBackendResume) {
    actionArgs = toolCfg.resumeArgs!.map((a: string) => a.replace("{sessionId}", backendSessionId!));
  } else if (relaunchFresh) {
    actionArgs = [];
  } else {
    // Targeted dashboard restore must never use "latest session" style fallbacks
    // such as Claude --continue or Codex resume --last; those can resurrect the
    // wrong agent after a crash or stale-state mismatch.
    throw new Error(
      `Cannot restore session "${session.id}" without an exact resumable backend session id for "${session.toolConfigKey}"`,
    );
  }
  const args = [...(toolCfg.args ?? []), ...actionArgs];

  if (relaunchFresh) {
    updateSessionMetadata(session.id, (current: any) => {
      const next = { ...current };
      delete next.derived;
      delete next.status;
      delete next.progress;
      return next;
    });
  } else if (useBackendResume && derived?.activity === "running") {
    // A reattached agent is sitting at its prompt, not mid-generation. Restoring
    // the stale "running" from disk would read as "working" forever (the
    // dropped-stop-hook trap). Settle it to idle so it derives "ready"; a real
    // prompt-submit hook re-marks it running the moment work resumes. Genuine
    // needs_input/blocked (activity "waiting") is preserved for the resumed agent.
    updateSessionMetadata(session.id, (current: any) => ({
      ...current,
      derived: current.derived ? { ...current.derived, activity: "idle" } : current.derived,
    }));
  }

  const preservedLabel = session.label ?? host.getSessionLabel(session.id);
  host.offlineSessions = host.offlineSessions.filter((s: any) => s.id !== session.id);
  host.invalidateDesktopStateSnapshot();
  host.writeStatuslineFile();

  if (preservedLabel) {
    host.sessionLabels.set(session.id, preservedLabel);
  }

  host.debug?.(
    `resuming offline session ${session.id} (${relaunchFresh ? "fresh" : useBackendResume ? `backend=${backendSessionId ?? "none"}` : "fallback"})`,
    "session",
  );
  const supersededBackendSessionId = relaunchFresh ? backendSessionId : undefined;
  const restoredSession = host.createSession(
    session.command,
    args,
    toolCfg.preambleFlag,
    session.toolConfigKey,
    undefined,
    undefined,
    session.worktreePath,
    useBackendResume ? backendSessionId : undefined,
    session.id,
    true,
    useBackendResume,
    session.team,
  );
  if (supersededBackendSessionId && restoredSession) {
    restoredSession.supersededBackendSessionId = supersededBackendSessionId;
  }
}

export function recordSessionBackendSessionId(
  host: RuntimeStateHost,
  sessionId: string,
  backendSessionId: string,
): { sessionId: string; backendSessionId: string } {
  const normalizedBackendSessionId = backendSessionId.trim();
  if (!normalizedBackendSessionId) throw new Error("backendSessionId is required");
  const runtime = host.sessions.find((session: any) => session.id === sessionId);
  const offline = host.offlineSessions.find((session: any) => session.id === sessionId);
  let recorded: { sessionId: string; backendSessionId: string };
  if (runtime) {
    if (!runtime.backendSessionId && runtime.supersededBackendSessionId === normalizedBackendSessionId) {
      throw new Error(
        `Agent "${sessionId}" ignored stale backend session "${normalizedBackendSessionId}" from a superseded launch`,
      );
    }
    if (runtime.backendSessionId && runtime.backendSessionId !== normalizedBackendSessionId) {
      throw new Error(
        `Agent "${sessionId}" already has backend session "${runtime.backendSessionId}", cannot replace with "${normalizedBackendSessionId}"`,
      );
    }
    const topologySession = listTopologySessionStates().find((session) => session.id === sessionId);
    if (!topologySession) {
      throw new Error(`Agent "${sessionId}" is not managed in runtime topology`);
    }
    upsertTopologySession({ ...topologySession, backendSessionId: normalizedBackendSessionId }, "running", {
      projectRoot: getRepoRoot(),
    });
    recorded = { sessionId, backendSessionId: normalizedBackendSessionId };
  } else {
    recorded = recordTopologyBackendSessionId({
      projectRoot: getRepoRoot(),
      sessionId,
      backendSessionId: normalizedBackendSessionId,
    });
  }
  if (runtime) {
    runtime.backendSessionId = recorded.backendSessionId;
    host.syncTmuxWindowMetadata?.(sessionId);
  }
  if (offline) {
    offline.backendSessionId = recorded.backendSessionId;
  }

  host.saveState?.();
  host.invalidateDesktopStateSnapshot?.();
  host.writeStatuslineFile?.();
  return recorded;
}

export function startHeartbeat(host: RuntimeStateHost): void {
  host.runtimeSync.startHeartbeat();
  // Probe the guard immediately so drift/disconnect is caught at startup, not after the first tick.
  void host.refreshRuntimeGuard?.();
}

export function stopHeartbeat(host: RuntimeStateHost): void {
  host.runtimeSync.stopHeartbeat();
}

export function startProjectServiceRefresh(host: RuntimeStateHost): void {
  host.runtimeSync.startProjectServiceRefresh();
}

export function stopProjectServiceRefresh(host: RuntimeStateHost): void {
  host.runtimeSync.stopProjectServiceRefresh();
}

export function listDesktopWorktrees(
  _host: RuntimeStateHost,
): Array<{ name: string; path: string; branch: string; isBare: boolean }> {
  return listAllWorktrees().filter((wt) => !wt.isBare && !isToolInternalWorktree(wt));
}
