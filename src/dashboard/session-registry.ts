import { existsSync } from "node:fs";
import type { DashboardSession } from "./index.js";
import type { SessionState } from "../multiplexer/index.js";
import type { InstanceInfo } from "../instance-registry.js";
import { listWorktrees as listAllWorktrees } from "../worktree.js";

export interface DashboardLocalSession {
  id: string;
  command: string;
  tmuxWindowId?: string;
  backendSessionId?: string;
  createdAt?: string;
  status: DashboardSession["status"];
  worktreePath?: string;
}

export interface DashboardSessionRegistryOptions {
  sessions: DashboardLocalSession[];
  activeIndex: number;
  offlineSessions: SessionState[];
  remoteInstances: InstanceInfo[];
  mainRepoPath?: string;
  getSessionLabel: (sessionId: string) => string | undefined;
  getSessionHeadline: (sessionId: string) => string | undefined;
  getSessionTaskDescription: (sessionId: string) => string | undefined;
  getSessionRole: (sessionId: string) => string | undefined;
  getSessionContext: (sessionId: string) =>
    | {
        cwd?: string;
        repo?: { owner?: string; name?: string; remote?: string };
        pr?: { number?: number; title?: string; url?: string };
      }
    | undefined;
  getSessionDerived: (sessionId: string) =>
    | {
        activity?: import("../agent-events.js").AgentActivityState;
        attention?: import("../agent-events.js").AgentAttentionState;
        unseenCount?: number;
        lastEvent?: import("../agent-events.js").AgentEvent;
        services?: import("../metadata-store.js").SessionServiceMetadata[];
        threadId?: string;
        threadName?: string;
      }
    | undefined;
}

export function getRemoteOwnedSessionKeys(remoteInstances: InstanceInfo[]): Set<string> {
  const owned = new Set<string>();
  for (const inst of remoteInstances) {
    for (const session of inst.sessions) {
      owned.add(session.id);
      if (session.backendSessionId) owned.add(session.backendSessionId);
    }
  }
  return owned;
}

export function buildDashboardSessions(options: DashboardSessionRegistryOptions): DashboardSession[] {
  const normalizeWtPath = normalizeWorktreePathFactory(options.mainRepoPath);
  const seenLocalSessionKeys = new Set<string>();

  const dashSessions: DashboardSession[] = [];
  for (const [index, session] of options.sessions.entries()) {
    const dedupeKey = `${session.id}::${session.backendSessionId ?? ""}`;
    if (seenLocalSessionKeys.has(dedupeKey)) continue;
    seenLocalSessionKeys.add(dedupeKey);
    dashSessions.push({
      index: dashSessions.length,
      id: session.id,
      command: session.command,
      tmuxWindowId: session.tmuxWindowId,
      backendSessionId: session.backendSessionId,
      createdAt: session.createdAt,
      status: session.status,
      active: index === options.activeIndex,
      worktreePath: normalizeWtPath(session.worktreePath),
      label: options.getSessionLabel(session.id),
      headline: options.getSessionHeadline(session.id),
      taskDescription: options.getSessionTaskDescription(session.id),
      role: options.getSessionRole(session.id),
      cwd: options.getSessionContext(session.id)?.cwd,
      repoOwner: options.getSessionContext(session.id)?.repo?.owner,
      repoName: options.getSessionContext(session.id)?.repo?.name,
      repoRemote: options.getSessionContext(session.id)?.repo?.remote,
      prNumber: options.getSessionContext(session.id)?.pr?.number,
      prTitle: options.getSessionContext(session.id)?.pr?.title,
      prUrl: options.getSessionContext(session.id)?.pr?.url,
      activity: options.getSessionDerived(session.id)?.activity,
      attention: options.getSessionDerived(session.id)?.attention,
      unseenCount: options.getSessionDerived(session.id)?.unseenCount,
      lastEvent: options.getSessionDerived(session.id)?.lastEvent,
      services: options.getSessionDerived(session.id)?.services,
      threadId: options.getSessionDerived(session.id)?.threadId,
      threadName: options.getSessionDerived(session.id)?.threadName,
    });
  }

  for (const inst of options.remoteInstances) {
    for (const session of inst.sessions) {
      if (dashSessions.some((existing) => existing.id === session.id)) continue;
      dashSessions.push({
        index: dashSessions.length,
        id: session.id,
        command: session.tool,
        backendSessionId: session.backendSessionId,
        createdAt: session.createdAt,
        status: "running",
        active: false,
        worktreePath: normalizeWtPath(session.worktreePath),
        remoteInstancePid: inst.pid,
        remoteInstanceId: inst.instanceId,
        remoteBackendSessionId: session.backendSessionId,
        label: options.getSessionLabel(session.id),
        headline: options.getSessionHeadline(session.id),
        cwd: options.getSessionContext(session.id)?.cwd,
        repoOwner: options.getSessionContext(session.id)?.repo?.owner,
        repoName: options.getSessionContext(session.id)?.repo?.name,
        repoRemote: options.getSessionContext(session.id)?.repo?.remote,
        prNumber: options.getSessionContext(session.id)?.pr?.number,
        prTitle: options.getSessionContext(session.id)?.pr?.title,
        prUrl: options.getSessionContext(session.id)?.pr?.url,
        activity: options.getSessionDerived(session.id)?.activity,
        attention: options.getSessionDerived(session.id)?.attention,
        unseenCount: options.getSessionDerived(session.id)?.unseenCount,
        lastEvent: options.getSessionDerived(session.id)?.lastEvent,
        services: options.getSessionDerived(session.id)?.services,
        threadId: options.getSessionDerived(session.id)?.threadId,
        threadName: options.getSessionDerived(session.id)?.threadName,
      });
    }
  }

  for (const offline of options.offlineSessions) {
    const alreadyShown = dashSessions.some(
      (session) =>
        session.id === offline.id ||
        (offline.backendSessionId && session.backendSessionId === offline.backendSessionId),
    );
    if (alreadyShown) continue;
    if (offline.worktreePath && !existsSync(offline.worktreePath)) continue;

    const worktreePath = normalizeWtPath(offline.worktreePath);
    const worktreeInfo = resolveWorktreeInfo(worktreePath);
    dashSessions.push({
      index: dashSessions.length,
      id: offline.id,
      command: offline.command,
      backendSessionId: offline.backendSessionId,
      createdAt: offline.createdAt,
      status: "offline",
      active: false,
      worktreePath,
      worktreeName: worktreeInfo?.name,
      worktreeBranch: worktreeInfo?.branch,
      remoteBackendSessionId: offline.backendSessionId,
      label: offline.label,
      headline: offline.headline,
      cwd: options.getSessionContext(offline.id)?.cwd,
      repoOwner: options.getSessionContext(offline.id)?.repo?.owner,
      repoName: options.getSessionContext(offline.id)?.repo?.name,
      repoRemote: options.getSessionContext(offline.id)?.repo?.remote,
      prNumber: options.getSessionContext(offline.id)?.pr?.number,
      prTitle: options.getSessionContext(offline.id)?.pr?.title,
      prUrl: options.getSessionContext(offline.id)?.pr?.url,
      activity: options.getSessionDerived(offline.id)?.activity,
      attention: options.getSessionDerived(offline.id)?.attention,
      unseenCount: options.getSessionDerived(offline.id)?.unseenCount,
      lastEvent: options.getSessionDerived(offline.id)?.lastEvent,
      services: options.getSessionDerived(offline.id)?.services,
      threadId: options.getSessionDerived(offline.id)?.threadId,
      threadName: options.getSessionDerived(offline.id)?.threadName,
    });
  }

  return dashSessions;
}

export function orderDashboardSessionsByVisualWorktree(
  sessions: DashboardSession[],
  worktreePaths: Array<string | undefined>,
  mainRepoPath?: string,
): DashboardSession[] {
  if (worktreePaths.length <= 1) {
    return sessions;
  }

  const normalizeWtPath = normalizeWorktreePathFactory(mainRepoPath);
  const ordered: DashboardSession[] = [];
  const seen = new Set<string>();

  for (const worktreePath of worktreePaths) {
    for (const session of sessions) {
      if (seen.has(session.id)) continue;
      if (normalizeWtPath(session.worktreePath) === worktreePath) {
        ordered.push(session);
        seen.add(session.id);
      }
    }
  }

  for (const session of sessions) {
    if (!seen.has(session.id)) {
      ordered.push(session);
    }
  }

  return ordered;
}

function normalizeWorktreePathFactory(mainRepoPath?: string) {
  return (path?: string) => (path && mainRepoPath && path === mainRepoPath ? undefined : path);
}

function resolveWorktreeInfo(worktreePath?: string): { name: string; branch: string } | undefined {
  if (!worktreePath) return undefined;
  try {
    const allWorktrees = listAllWorktrees(worktreePath);
    const worktree = allWorktrees.find((entry) => entry.path === worktreePath);
    if (worktree) {
      return { name: worktree.name, branch: worktree.branch };
    }
  } catch {}

  const name = worktreePath.split("/").pop();
  if (!name) return undefined;
  return { name, branch: "unknown" };
}
