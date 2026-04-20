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
import { findMainRepo } from "../worktree.js";
import { listThreadSummaries, readMessages } from "../threads.js";
import { deriveSessionSemantics } from "../session-semantics.js";
import { requestJson } from "../http-client.js";
import { buildWorkflowEntries, describeWorkflowNextAction } from "../workflow.js";
import { ensureDaemonRunning, ensureProjectService } from "../daemon.js";
import { isDashboardWindowName } from "../tmux/runtime-manager.js";

type DashboardModelHost = any;

function runProjectServiceUiRefresh(host: DashboardModelHost): void {
  host.writeStatuslineFile();
  if (host.mode === "dashboard") {
    host.renderCurrentDashboardView();
  }
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
    pending?: boolean;
    removing?: boolean;
    pendingAction?: "creating";
  }>,
  mainRepoPath?: string,
): WorktreeGroup[] {
  return worktrees
    .filter((wt) => !wt.isBare && wt.path !== mainRepoPath)
    .map((wt) => {
      const wtSessions = dashSessions.filter((s) => s.worktreePath === wt.path);
      const wtServices = dashServices.filter((s) => s.worktreePath === wt.path);
      return {
        name: wt.name,
        branch: wt.branch,
        path: wt.path,
        pending: wt.pending,
        removing: wt.removing,
        pendingAction: wt.pendingAction,
        status: (wtSessions.length > 0 || wtServices.length > 0 ? "active" : "offline") as "active" | "offline",
        sessions: wtSessions,
        services: wtServices,
      };
    });
}

export function applyDashboardModel(
  host: DashboardModelHost,
  dashSessions: DashboardSession[],
  dashServices: DashboardService[],
  worktreeGroups: WorktreeGroup[],
  mainCheckoutInfo: { name: string; branch: string },
): boolean {
  const snapshotKey = JSON.stringify({
    sessions: dashSessions,
    services: dashServices,
    worktreeGroups,
    mainCheckoutInfo,
  });
  if (snapshotKey === host.dashboardModelSnapshotKey) {
    host.dashboardModelRefreshedAt = Date.now();
    return false;
  }
  host.dashboardModelSnapshotKey = snapshotKey;
  host.dashboardSessionsCache = host.dashboardPendingActions.applyToSessions(dashSessions);
  host.dashboardServicesCache = host.dashboardPendingActions.applyToServices(dashServices);
  host.dashboardWorktreeGroupsCache = host.dashboardPendingActions.applyToWorktrees(worktreeGroups);
  host.dashboardMainCheckoutInfoCache = mainCheckoutInfo;
  host.dashboardModelRefreshedAt = Date.now();
  host.dashboardUiStateStore.markSelectionDirty();
  return true;
}

export function invalidateDesktopStateSnapshot(host: DashboardModelHost): void {
  host.desktopStateSnapshot = null;
}

export function refreshDesktopStateSnapshot(host: DashboardModelHost): void {
  host.desktopStateSnapshot = buildDesktopStateSnapshot(host);
}

export function computeDashboardSessions(host: DashboardModelHost): DashboardSession[] {
  const lastUsedState = loadLastUsedState(process.cwd());
  const metadata = loadMetadataState().sessions;
  const threadSummaries = listThreadSummaries();
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
      backendSessionId: session.backendSessionId,
      status: session.status,
      worktreePath: host.sessionWorktreePaths.get(session.id),
      tmuxWindowId: host.sessionTmuxTargets.get(session.id)?.windowId,
    })),
    activeIndex: host.activeIndex,
    offlineSessions: host.offlineSessions,
    remoteInstances: [],
    mainRepoPath,
    getSessionLabel: (sessionId: string) => host.getSessionLabel(sessionId),
    getSessionHeadline: (sessionId: string) => host.deriveHeadline(sessionId),
    getSessionTaskDescription: (sessionId: string) => host.taskDispatcher?.getSessionTask(sessionId),
    getSessionRole: (sessionId: string) => host.sessionRoles.get(sessionId),
    getSessionContext: (sessionId: string) => metadata[sessionId]?.context,
    getSessionDerived: (sessionId: string) => metadata[sessionId]?.derived,
  });
  return sessions.map((session) => {
    const stats = threadStats.get(session.id);
    const workflow = workflowStats.get(session.id);
    const target = host.sessionTmuxTargets.get(session.id);
    const runtimeInfo = target ? readTmuxProcessInfo(host, target) : {};
    return {
      ...session,
      tmuxWindowIndex: target?.windowIndex,
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
      semantic: deriveSessionSemantics({
        status: session.status,
        activity: session.activity,
        attention: session.attention,
        unseenCount: session.unseenCount,
        threadUnreadCount: stats?.unread ?? 0,
        threadPendingCount: stats?.pending ?? 0,
        threadWaitingOnMeCount: stats?.waitingOnMe ?? 0,
        threadWaitingOnThemCount: stats?.waitingOnThem ?? 0,
        workflowOnMeCount: workflow?.onMe ?? 0,
        workflowBlockedCount: workflow?.blocked ?? 0,
        workflowFamilyCount: workflow?.families.size ?? 0,
        hasActiveTask: Boolean(session.taskDescription),
      }),
    };
  });
}

export function computeDashboardServices(
  host: DashboardModelHost,
  worktrees = host.listDesktopWorktrees(),
): DashboardService[] {
  const lastUsedState = loadLastUsedState(process.cwd());
  const worktreeByPath = new Map<string, { name: string; path: string; branch: string; isBare: boolean }>(
    worktrees.map((wt: any) => [wt.path, wt] as const),
  );
  const liveServices = host.tmuxRuntimeManager
    .listProjectManagedWindows(process.cwd())
    .filter(({ target, metadata }: any) => !isDashboardWindowName(target.windowName) && metadata.kind === "service")
    .map(({ target, metadata }: any) => {
      const worktree = metadata.worktreePath ? worktreeByPath.get(metadata.worktreePath) : undefined;
      const info = readTmuxProcessInfo(host, target);
      return {
        id: metadata.sessionId,
        command: metadata.command,
        args: metadata.args ?? [],
        tmuxWindowId: target.windowId,
        tmuxWindowIndex: target.windowIndex,
        lastUsedAt: lastUsedState.items[metadata.sessionId]?.lastUsedAt,
        worktreePath: metadata.worktreePath,
        worktreeName: worktree?.name,
        worktreeBranch: worktree?.branch,
        status: host.tmuxRuntimeManager.isWindowAlive(target) ? ("running" as const) : ("exited" as const),
        active: false,
        label: metadata.label,
        cwd: host.tmuxRuntimeManager.displayMessage("#{pane_current_path}", target.windowId) ?? metadata.worktreePath,
        foregroundCommand: info.command,
        pid: info.pid,
        previewLine: info.previewLine,
      };
    });
  const liveIds = new Set(liveServices.map((service: any) => service.id));
  const offlineServices = host.offlineServices
    .filter((service: any) => !liveIds.has(service.id))
    .map((service: any) => {
      const worktree = service.worktreePath ? worktreeByPath.get(service.worktreePath) : undefined;
      const label = service.label ?? host.serviceLabelForCommand(service.launchCommandLine ?? "");
      const previewLine = service.launchCommandLine?.trim() || "Interactive shell";
      return {
        id: service.id,
        command: service.launchCommandLine?.trim() ?? "",
        args: [],
        lastUsedAt: lastUsedState.items[service.id]?.lastUsedAt,
        worktreePath: service.worktreePath,
        worktreeName: worktree?.name,
        worktreeBranch: worktree?.branch,
        status: "offline" as const,
        active: false,
        label,
        cwd: service.worktreePath,
        foregroundCommand: label,
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

export function buildDesktopStateSnapshot(host: DashboardModelHost) {
  host.syncSessionsFromState();
  const worktrees = host.listDesktopWorktrees();
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
  return {
    sessions: computeDashboardSessions(host),
    services: computeDashboardServices(host, worktrees),
    worktrees,
    mainCheckoutInfo,
    mainCheckoutPath,
  };
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
            timeoutMs: 250,
          });
          if (status >= 200 && status < 300) {
            const body = json as {
              ok?: boolean;
              sessions?: DashboardSession[];
              services?: DashboardService[];
              worktrees?: Array<{
                name: string;
                path: string;
                branch: string;
                isBare: boolean;
                pending?: boolean;
                removing?: boolean;
                pendingAction?: "creating";
              }>;
              mainCheckoutInfo?: { name: string; branch: string };
              mainCheckoutPath?: string;
            };
            const dashSessions = body.sessions ?? [];
            const dashServices = body.services ?? [];
            const worktrees = body.worktrees ?? [];
            const worktreeGroups = buildDashboardWorktreeGroups(
              host,
              dashSessions,
              dashServices,
              worktrees,
              body.mainCheckoutPath,
            );
            return applyDashboardModel(
              host,
              dashSessions,
              dashServices,
              worktreeGroups,
              body.mainCheckoutInfo ?? { name: "Main Checkout", branch: "" },
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
  applyDashboardModel(host, snapshot.sessions, snapshot.services, worktreeGroups, snapshot.mainCheckoutInfo);
}

export async function startProjectServices(host: DashboardModelHost): Promise<void> {
  if (host.metadataServer) return;
  host.projectServiceStartupMetadataSettling = true;
  host.projectServiceUiRefreshPending = false;
  host.metadataServer = new MetadataServer({
    events: { bus: host.eventBus },
    desktop: {
      getState: () => host.buildDesktopState(),
      listWorktrees: () => host.listDesktopWorktrees(),
      refreshStatusline: ({ sessionId, force }: any) => host.refreshProjectStatusline({ sessionId, force }),
      createWorktree: ({ name }: any) => host.createDesktopWorktree(name),
      removeWorktree: ({ path }: any) => host.removeDesktopWorktree(path),
      createService: ({ command, worktreePath }: any) => host.createService(command ?? "", worktreePath),
      stopService: ({ serviceId }: any) => host.stopService(serviceId),
      resumeService: ({ serviceId }: any) => host.resumeOfflineServiceById(serviceId),
      removeService: ({ serviceId }: any) => host.removeOfflineService(serviceId),
      resumeAgent: ({ sessionId }: any) => {
        const offline = host.offlineSessions.find((session: any) => session.id === sessionId);
        if (!offline) {
          throw new Error(`Agent "${sessionId}" not found`);
        }
        host.resumeOfflineSession(offline);
        return { sessionId, status: "running" as const };
      },
      listGraveyard: () => host.listGraveyardEntries(),
      resurrectGraveyard: ({ sessionId }: any) => host.resurrectGraveyardSession(sessionId),
    },
    threads: {
      sendMessage: (input: any) => host.sendOrchestrationMessage(input),
    },
    actions: {
      sendHandoff: (input: any) => host.sendHandoffMessage(input),
    },
    lifecycle: {
      spawnAgent: (input: any) =>
        host.spawnAgent({
          toolConfigKey: input.tool,
          targetWorktreePath: input.worktreePath,
          open: input.open ?? false,
        }),
      forkAgent: (input: any) =>
        host.forkAgent({
          sourceSessionId: input.sourceSessionId,
          targetToolConfigKey: input.tool,
          instruction: input.instruction,
          targetWorktreePath: input.worktreePath,
          open: input.open ?? false,
        }),
      stopAgent: (input: any) => host.stopAgent(input.sessionId),
      interruptAgent: (input: any) => host.interruptAgent(input.sessionId),
      renameAgent: (input: any) => host.renameAgent(input.sessionId, input.label),
      migrateAgent: (input: any) => host.migrateAgent(input.sessionId, input.worktreePath),
      killAgent: (input: any) => host.sendAgentToGraveyard(input.sessionId),
      writeAgentInput: (input: any) =>
        host.writeAgentInput(input.sessionId, input.data, input.parts, input.clientMessageId, input.submit),
      readAgentOutput: (input: any) => host.readAgentOutput(input.sessionId, input.startLine),
      readAgentHistory: (input: any) => host.readAgentHistory(input.sessionId, input.lastN),
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
    await host.pluginRuntime.start();
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
