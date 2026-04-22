import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { loadMetadataState, updateSessionMetadata } from "../metadata-store.js";
import { getGraveyardPath, getLocalAimuxDir, getStatePath } from "../paths.js";
import { listWorktrees as listAllWorktrees } from "../worktree.js";
import { isDashboardWindowName } from "../tmux/runtime-manager.js";
import { TmuxSessionTransport } from "../tmux/session-transport.js";

type RuntimeStateHost = any;

export function renderCurrentDashboardView(host: RuntimeStateHost): void {
  if (host.isDashboardScreen("activity")) {
    host.renderActivityDashboard();
    return;
  }
  if (host.isDashboardScreen("workflow")) {
    host.renderWorkflow();
    return;
  }
  if (host.isDashboardScreen("notifications")) {
    host.renderNotifications();
    return;
  }
  if (host.isDashboardScreen("threads")) {
    host.renderThreads();
    return;
  }
  if (host.isDashboardScreen("plans")) {
    host.renderPlans();
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
  host.renderActiveDashboardOverlay();
}

export function startStatusRefresh(host: RuntimeStateHost): void {
  if (host.statusInterval) return;
  host.statusInterval = setInterval(() => {
    let dashboardNeedsRender = false;
    if (host.mode === "project-service") {
      host.taskDispatcher?.tick(host.sessions.map((s: any) => s.id));
      host.orchestrationDispatcher?.tick(host.sessions.map((s: any) => s.id));
    }

    const events = host.taskDispatcher?.drainEvents() ?? [];
    for (const ev of events) {
      if (ev.type === "assigned") {
        host.footerFlash = `⧫ Task assigned → ${ev.sessionId}`;
      } else if (ev.type === "completed") {
        host.footerFlash = `✓ Task done by ${ev.sessionId}`;
      } else if (ev.type === "failed") {
        host.footerFlash = `✗ Task failed: ${ev.sessionId}`;
      } else if (ev.type === "review_created") {
        host.footerFlash = `⧫ Review created: ${ev.description}`;
      } else if (ev.type === "review_approved") {
        host.footerFlash = `✓ Review approved: ${ev.description}`;
      } else if (ev.type === "changes_requested") {
        host.footerFlash = `↻ Changes requested: ${ev.description}`;
      }
      host.footerFlashTicks = 3;
      dashboardNeedsRender = true;
    }

    const orchestrationEvents = host.orchestrationDispatcher?.drainEvents() ?? [];
    for (const event of orchestrationEvents) {
      if (event.type === "message_delivered") {
        host.footerFlash = `✉ Message delivered → ${event.sessionId}`;
        host.footerFlashTicks = 3;
        dashboardNeedsRender = true;
      }
    }

    if (host.dashboardFeedback.tickFlashVisibilityChanged()) {
      dashboardNeedsRender = true;
    }

    for (const session of host.sessions) {
      const prev = host.prevStatuses.get(session.id);
      const curr = session.status;
      if (prev && prev !== curr && curr === "idle" && prev === "running") {
        host.publishAlert({
          kind: "needs_input",
          sessionId: session.id,
          title: `${session.id} needs input`,
          message: "Agent is waiting for input.",
          dedupeKey: `idle-needs-input:${session.id}`,
          cooldownMs: 15_000,
        });
      }
      host.prevStatuses.set(session.id, curr);
    }

    if (host.mode === "dashboard") {
      const now = Date.now();
      if (now >= host.dashboardNextBackgroundRefreshAt) {
        host.dashboardNextBackgroundRefreshAt = now + 5000;
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
}

export function syncSessionsFromState(host: RuntimeStateHost, state = host.constructor.loadState()): void {
  restoreTmuxSessionsFromState(host, state);
  loadOfflineSessions(host, state);
  loadOfflineServices(host, state);
  host.invalidateDesktopStateSnapshot();
}

export function loadOfflineSessions(host: RuntimeStateHost, state = host.constructor.loadState()): boolean {
  if (!state || state.sessions.length === 0) {
    const changed = host.offlineSessions.length > 0;
    host.offlineSessions = [];
    return changed;
  }

  const ownedIds = new Set<string>();
  for (const s of host.sessions) ownedIds.add(s.id);
  for (const inst of host.getRemoteInstancesSafe()) {
    for (const rs of inst.sessions) ownedIds.add(rs.id);
  }

  const ownedBackendIds = new Set(
    host.sessions
      .map((session: any) => session.backendSessionId)
      .filter((value: any): value is string => Boolean(value)),
  );

  const nextOfflineSessions = state.sessions.filter((s: any) => {
    if (ownedIds.has(s.id)) return false;
    if (s.backendSessionId && ownedBackendIds.has(s.backendSessionId)) return false;
    if (host.dashboardPendingActions?.get?.(s.id) === "starting") return false;
    if (s.worktreePath && !existsSync(s.worktreePath)) return false;
    return true;
  });
  const previousKey = host.offlineSessions
    .map((session: any) => `${session.id}:${session.label ?? ""}:${session.worktreePath ?? ""}`)
    .join("|");
  const nextKey = nextOfflineSessions
    .map((session: any) => `${session.id}:${session.label ?? ""}:${session.worktreePath ?? ""}`)
    .join("|");
  host.offlineSessions = nextOfflineSessions;

  if (host.offlineSessions.length > 0) {
    host.debug?.(`loaded ${host.offlineSessions.length} offline session(s) from state.json`, "session");
  }
  return previousKey !== nextKey;
}

export function loadOfflineServices(host: RuntimeStateHost, state = host.constructor.loadState()): boolean {
  const savedServices = state?.services ?? [];
  if (savedServices.length === 0) {
    const changed = host.offlineServices.length > 0;
    host.offlineServices = [];
    return changed;
  }

  const liveServiceIds = new Set(
    host.tmuxRuntimeManager
      .listProjectManagedWindows(process.cwd())
      .filter(({ target, metadata }: any) => !isDashboardWindowName(target.windowName) && metadata.kind === "service")
      .map(({ metadata }: any) => metadata.sessionId),
  );

  const nextOfflineServices = savedServices.filter((service: any) => {
    if (liveServiceIds.has(service.id)) return false;
    if (service.worktreePath && !existsSync(service.worktreePath)) return false;
    return true;
  });
  const previousKey = host.offlineServices
    .map(
      (service: any) =>
        `${service.id}:${service.label ?? ""}:${service.worktreePath ?? ""}:${service.launchCommandLine ?? ""}`,
    )
    .join("|");
  const nextKey = nextOfflineServices
    .map(
      (service: any) =>
        `${service.id}:${service.label ?? ""}:${service.worktreePath ?? ""}:${service.launchCommandLine ?? ""}`,
    )
    .join("|");
  host.offlineServices = nextOfflineServices;
  return previousKey !== nextKey;
}

export function buildLiveServiceStates(host: RuntimeStateHost): any[] {
  const seen = new Set<string>();
  const liveServices: any[] = [];
  for (const { metadata } of host.tmuxRuntimeManager.listProjectManagedWindows(process.cwd())) {
    if (metadata.kind !== "service") continue;
    if (seen.has(metadata.sessionId)) continue;
    seen.add(metadata.sessionId);
    const launchCommandLine =
      metadata.command === "shell" ? "" : metadata.args?.[0] === "-lc" ? (metadata.args[1] ?? "") : "";
    liveServices.push({
      id: metadata.sessionId,
      createdAt: metadata.createdAt,
      worktreePath: metadata.worktreePath,
      label: metadata.label,
      launchCommandLine,
    });
  }
  return liveServices;
}

export function restoreTmuxSessionsFromState(host: RuntimeStateHost, state = host.constructor.loadState()): void {
  const savedById = new Map<string, any>((state?.sessions ?? []).map((session: any) => [session.id, session]));
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;

  for (const { target, metadata } of host.tmuxRuntimeManager.listProjectManagedWindows(process.cwd())) {
    if (isDashboardWindowName(target.windowName)) continue;
    if (metadata.kind === "service") continue;
    if (host.sessions.some((session: any) => session.id === metadata.sessionId)) continue;

    const transport = new TmuxSessionTransport(
      metadata.sessionId,
      metadata.command,
      target,
      host.tmuxRuntimeManager,
      cols,
      rows,
    );
    transport.backendSessionId = metadata.backendSessionId;
    host.sessionTmuxTargets.set(metadata.sessionId, target);
    host.registerManagedSession(
      transport,
      metadata.args,
      metadata.toolConfigKey,
      metadata.worktreePath,
      metadata.role,
      metadata.createdAt ? Date.parse(metadata.createdAt) : undefined,
    );

    const saved = savedById.get(metadata.sessionId);
    const label = metadata.label ?? saved?.label;
    if (label) {
      host.sessionLabels.set(metadata.sessionId, label);
    }
    if (target.windowName !== metadata.command) {
      transport.renameWindow(metadata.command);
    }
    host.syncTmuxWindowMetadata(metadata.sessionId);
  }
}

export function stopSessionToOffline(host: RuntimeStateHost, session: any): void {
  if (host.stoppingSessionIds.has(session.id)) return;
  const offlineEntry = {
    id: session.id,
    tool: session.command,
    toolConfigKey: host.sessionToolKeys.get(session.id) ?? session.command,
    command: session.command,
    args: host.sessionOriginalArgs.get(session.id) ?? [],
    createdAt: session.startTime ? new Date(session.startTime).toISOString() : undefined,
    backendSessionId: session.backendSessionId as string | undefined,
    worktreePath: host.sessionWorktreePaths.get(session.id),
    label: host.getSessionLabel(session.id),
    headline: host.deriveHeadline(session.id),
  };

  if (!host.offlineSessions.some((entry: any) => entry.id === session.id)) {
    host.offlineSessions.push(offlineEntry);
  }
  host.stoppingSessionIds.add(session.id);
  host.startedInDashboard = true;
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

export function graveyardSession(host: RuntimeStateHost, sessionId: string): void {
  const session = host.offlineSessions.find((s: any) => s.id === sessionId);
  if (!session) return;

  host.offlineSessions = host.offlineSessions.filter((s: any) => s.id !== sessionId);

  const graveyardPath = getGraveyardPath();
  let graveyard: Array<Record<string, unknown>> = [];
  if (existsSync(graveyardPath)) {
    try {
      graveyard = JSON.parse(readFileSync(graveyardPath, "utf-8"));
    } catch {}
  }
  graveyard.push({ ...session, id: session.id });
  writeFileSync(graveyardPath, JSON.stringify(graveyard, null, 2) + "\n");

  const statePath = getStatePath();
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8")) as any;
      state.sessions = state.sessions.filter((s: any) => s.id !== sessionId);
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    } catch {}
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
    return Boolean(host.tmuxRuntimeManager.getTargetByWindowId(target.sessionName, target.windowId));
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
  host.writeSessionsFile();
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
  const useBackendResume =
    !relaunchFresh && host.sessionBootstrap.canResumeWithBackendSessionId(toolCfg, session.backendSessionId);

  let actionArgs: string[];
  if (useBackendResume) {
    actionArgs = toolCfg.resumeArgs!.map((a: string) => a.replace("{sessionId}", session.backendSessionId!));
  } else if (relaunchFresh) {
    actionArgs = [];
  } else {
    actionArgs = [...(toolCfg.resumeFallback ?? [])];
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
  }

  const preservedLabel = session.label ?? host.getSessionLabel(session.id);
  host.offlineSessions = host.offlineSessions.filter((s: any) => s.id !== session.id);
  host.invalidateDesktopStateSnapshot();
  host.writeStatuslineFile();

  if (preservedLabel) {
    host.sessionLabels.set(session.id, preservedLabel);
  }

  host.debug?.(
    `resuming offline session ${session.id} (${relaunchFresh ? "fresh" : useBackendResume ? `backend=${session.backendSessionId ?? "none"}` : "fallback"})`,
    "session",
  );
  host.createSession(
    session.command,
    args,
    toolCfg.preambleFlag,
    session.toolConfigKey,
    undefined,
    undefined,
    session.worktreePath,
    useBackendResume ? session.backendSessionId : undefined,
    session.id,
    true,
    !relaunchFresh,
  );
}

export function startHeartbeat(host: RuntimeStateHost): void {
  host.runtimeSync.startHeartbeat();
}

export function handleSessionClaimed(host: RuntimeStateHost, sessionId: string): void {
  const session = host.sessions.find((s: any) => s.id === sessionId);
  if (!session) return;
  host.debug?.(`session ${sessionId} was claimed by another instance, killing local PTY`, "instance");
  session.kill();
  const idx = host.sessions.indexOf(session);
  if (idx >= 0) {
    host.sessions.splice(idx, 1);
    host.sessionToolKeys.delete(sessionId);
    host.sessionOriginalArgs.delete(sessionId);
    host.sessionWorktreePaths.delete(sessionId);
    host.sessionTmuxTargets.delete(sessionId);
  }
  if (host.activeIndex >= host.sessions.length) {
    host.activeIndex = Math.max(0, host.sessions.length - 1);
  }
  host.renderDashboard();
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

export function getRemoteInstancesSafe(host: RuntimeStateHost) {
  return host.instanceDirectory.getRemoteInstancesSafe(host.instanceId, process.cwd());
}

export function getRemoteOwnedSessionKeys(host: RuntimeStateHost): Set<string> {
  return host.instanceDirectory.getRemoteOwnedSessionKeys(host.instanceId, process.cwd());
}

export function getInstanceSessionRefs(host: RuntimeStateHost): any[] {
  return host.sessions.map((s: any) => ({
    id: s.id,
    tool: s.command,
    backendSessionId: s.backendSessionId,
    worktreePath: host.sessionWorktreePaths.get(s.id),
  }));
}

export function writeSessionsFile(host: RuntimeStateHost): void {
  const dir = getLocalAimuxDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const localSessions = host.sessions.map((s: any) => ({
    id: s.id,
    tool: s.command,
    backendSessionId: s.backendSessionId,
    worktreePath: host.sessionWorktreePaths.get(s.id),
  }));
  const data = host.instanceDirectory.buildSessionsFileEntries(
    localSessions,
    host.instanceDirectory.getRemoteInstancesSafe(host.instanceId, process.cwd()),
  );

  writeFileSync(`${dir}/sessions.json`, JSON.stringify(data, null, 2) + "\n");
}

export function removeSessionsFile(): void {
  try {
    unlinkSync(`${getLocalAimuxDir()}/sessions.json`);
  } catch {}
}

export function listDesktopWorktrees(
  _host: RuntimeStateHost,
): Array<{ name: string; path: string; branch: string; isBare: boolean }> {
  return listAllWorktrees().filter((wt: { isBare: boolean }) => !wt.isBare);
}
