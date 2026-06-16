import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../config.js";
import { readHistory } from "../context/history.js";
import { getAimuxDirFor, getProjectStateDir, getStatusDir } from "../paths.js";
import { loadTeamConfig } from "../team.js";
import { SessionRuntime } from "../session-runtime.js";
import { TmuxSessionTransport } from "../tmux/session-transport.js";
import { loadMetadataState } from "../metadata-store.js";
import { isAgentOutputEventKind } from "../agent-events.js";
import { sessionRecencyAnchor } from "../session-recency.js";
import { deriveSessionSemantics } from "../session-semantics.js";
import { parseAgentOutput } from "../agent-output-parser.js";
import { normalizeSubmittedPrompt, waitForTmuxPromptSubmit } from "../agent-prompt-delivery.js";
import { captureGitContext } from "../context/context-bridge.js";
import type { SessionTeamMetadata } from "../team.js";

type SessionRuntimeHost = any;

export function getSessionLabel(host: SessionRuntimeHost, sessionId: string): string | undefined {
  return (
    host.sessionLabels.get(sessionId) ?? host.offlineSessions.find((session: any) => session.id === sessionId)?.label
  );
}

export function applySessionLabel(host: SessionRuntimeHost, sessionId: string, label?: string): void {
  const trimmed = label?.trim();
  if (trimmed) {
    host.sessionLabels.set(sessionId, trimmed);
  } else {
    host.sessionLabels.delete(sessionId);
  }

  const offline = host.offlineSessions.find((session: any) => session.id === sessionId);
  if (offline) {
    if (trimmed) offline.label = trimmed;
    else delete offline.label;
  }
}

export function applyDashboardSessionLabel(host: SessionRuntimeHost, sessionId: string, label?: string): void {
  const trimmed = label?.trim();
  host.dashboardSessionsCache = host.dashboardSessionsCache.map((session: any) =>
    session.id === sessionId ? { ...session, label: trimmed || undefined } : session,
  );
  host.dashboardWorktreeGroupsCache = host.dashboardWorktreeGroupsCache.map((group: any) => ({
    ...group,
    sessions: group.sessions.map((session: any) =>
      session.id === sessionId ? { ...session, label: trimmed || undefined } : session,
    ),
  }));
  host.dashboardState.worktreeSessions = host.dashboardState.worktreeSessions.map((session: any) =>
    session.id === sessionId ? { ...session, label: trimmed || undefined } : session,
  );
}

export async function updateSessionLabel(host: SessionRuntimeHost, sessionId: string, label?: string): Promise<void> {
  if (host.mode === "dashboard") {
    host.setPendingDashboardSessionAction(sessionId, "renaming");
    host.writeStatuslineFile();
    host.renderCurrentDashboardView();
    try {
      await host.postToProjectService("/agents/rename", { sessionId, label });
      host.invalidateDesktopStateSnapshot();
      if (typeof host.refreshDashboardModelFromService === "function") {
        await host.refreshDashboardModelFromService(true);
      }
    } catch (err: unknown) {
      host.footerFlash = `Rename failed: ${err instanceof Error ? err.message : String(err)}`;
      host.footerFlashTicks = 4;
      if (typeof host.refreshDashboardModelFromService === "function") {
        await host.refreshDashboardModelFromService(true);
      }
    } finally {
      host.setPendingDashboardSessionAction(sessionId, null);
      host.writeStatuslineFile();
      host.renderCurrentDashboardView();
    }
    return;
  }

  applySessionLabel(host, sessionId, label);
  host.invalidateDesktopStateSnapshot();

  const localSession = host.sessions.find((session: any) => session.id === sessionId)?.transport;
  if (localSession instanceof TmuxSessionTransport) {
    const target = resolveLiveSessionTmuxTarget(host, sessionId, localSession.tmuxTarget);
    if (target) {
      localSession.retarget(target);
      localSession.renameWindow(localSession.command);
      host.sessionTmuxTargets.set(sessionId, localSession.tmuxTarget);
      host.syncTmuxWindowMetadata(sessionId);
    }
  }

  host.saveState();
  host.writeStatuslineFile();
  host.renderDashboard();
}

export function readStatusHeadline(_host: SessionRuntimeHost, sessionId: string): string | undefined {
  try {
    const statusPath = join(getStatusDir(), `${sessionId}.md`);
    if (!existsSync(statusPath)) return undefined;
    const content = readFileSync(statusPath, "utf-8").trim();
    if (!content) return undefined;
    return content.split("\n")[0].slice(0, 80);
  } catch {
    return undefined;
  }
}

export function deriveHeadline(host: SessionRuntimeHost, sessionId: string): string | undefined {
  const statusHeadline = readStatusHeadline(host, sessionId);
  if (statusHeadline) return statusHeadline;

  try {
    const turns = readHistory(sessionId, { lastN: 3 });
    const lastPrompt = turns.filter((turn: any) => turn.type === "prompt").pop();
    if (lastPrompt) return lastPrompt.content.slice(0, 80);
  } catch {}

  return undefined;
}

export function resolveRunningSession(host: SessionRuntimeHost, sessionId: string): any {
  const session = host.sessions.find((candidate: any) => candidate.id === sessionId);
  if (!session || session.exited) {
    throw new Error(`Session "${sessionId}" is not running`);
  }
  return session;
}

export function resolveLiveSessionTmuxTarget(host: SessionRuntimeHost, sessionId: string, fallback?: any): any {
  const candidate = host.sessionTmuxTargets.get(sessionId) ?? fallback;
  if (candidate) {
    try {
      if (!host.tmuxRuntimeManager.getTargetByWindowId || !host.tmuxRuntimeManager.getWindowMetadata) {
        return candidate;
      }
      const resolved = host.tmuxRuntimeManager.getTargetByWindowId(candidate.sessionName, candidate.windowId);
      const metadata = resolved ? host.tmuxRuntimeManager.getWindowMetadata(resolved) : null;
      if (!resolved) {
        return undefined;
      }
      if (!metadata || (metadata.kind === "agent" && metadata.sessionId === sessionId)) {
        host.sessionTmuxTargets.set(sessionId, resolved);
        return resolved;
      }
    } catch {}
  }

  try {
    for (const { target, metadata } of host.tmuxRuntimeManager.listProjectManagedWindows(process.cwd())) {
      if (metadata.kind !== "agent" || metadata.sessionId !== sessionId) continue;
      if (host.tmuxRuntimeManager.isWindowAlive && !host.tmuxRuntimeManager.isWindowAlive(target)) continue;
      host.sessionTmuxTargets.set(sessionId, target);
      return target;
    }
  } catch {}

  return undefined;
}

export async function interruptAgent(host: SessionRuntimeHost, sessionId: string): Promise<{ sessionId: string }> {
  const session = resolveRunningSession(host, sessionId);
  if (session.transport instanceof TmuxSessionTransport) {
    const target = resolveLiveSessionTmuxTarget(host, sessionId, session.transport.tmuxTarget);
    if (!target) throw new Error(`Session "${sessionId}" does not have a live tmux target`);
    session.transport.retarget(target);
    host.tmuxRuntimeManager.sendEscape(target);
  } else {
    session.write("\x1b");
  }
  return { sessionId };
}

export async function sendAgentInput(
  host: SessionRuntimeHost,
  sessionId: string,
  text: string,
): Promise<{ sessionId: string; accepted: true }> {
  const session = resolveRunningSession(host, sessionId);
  if (session.transport instanceof TmuxSessionTransport) {
    const target = resolveLiveSessionTmuxTarget(host, sessionId, session.transport.tmuxTarget);
    if (!target) throw new Error(`Session "${sessionId}" does not have a live tmux target`);
    session.transport.retarget(target);
    const prompt = normalizeSubmittedPrompt(host.sessionToolKeys.get(sessionId), text, true);
    session.transport.write(prompt);
    await waitForTmuxPromptSubmit({
      tmuxRuntimeManager: host.tmuxRuntimeManager,
      target,
      draft: prompt,
      isTargetCurrent: () => resolveLiveSessionTmuxTarget(host, sessionId, target)?.windowId === target.windowId,
    });
  } else {
    session.write(text);
    session.write("\r");
  }
  return { sessionId, accepted: true };
}

export async function readAgentOutput(
  host: SessionRuntimeHost,
  sessionId: string,
  startLine?: number,
): Promise<{ sessionId: string; output: string; startLine?: number; parsed: any }> {
  resolveRunningSession(host, sessionId);
  const target = resolveLiveSessionTmuxTarget(host, sessionId);
  if (!target) {
    throw new Error(`Session "${sessionId}" does not have a live tmux target`);
  }
  const output = host.tmuxRuntimeManager.captureTarget(target, {
    startLine: startLine ?? -120,
  });
  return {
    sessionId,
    output,
    startLine: startLine ?? -120,
    parsed: parseAgentOutput(output, {
      tool: host.sessionToolKeys.get(sessionId),
    }),
  };
}

export function registerManagedSession(
  host: SessionRuntimeHost,
  session: any,
  args: string[],
  toolConfigKey?: string,
  worktreePath?: string,
  role?: string,
  startTime?: number,
  team?: SessionTeamMetadata,
): any {
  const existing = host.sessions.find((runtime: any) => runtime.transport === session);
  if (existing) return existing;

  const runtime = new SessionRuntime(session, startTime, {
    onEvent: (event: any) => host.handleSessionRuntimeEvent(runtime, event),
  });
  runtime.team = team;

  if (toolConfigKey) {
    host.sessionToolKeys.set(runtime.id, toolConfigKey);
  }
  host.sessionOriginalArgs.set(runtime.id, args);
  if (worktreePath) {
    host.sessionWorktreePaths.set(runtime.id, worktreePath);
  }
  if (team) {
    host.sessionRoles.delete(runtime.id);
  } else if (role) {
    host.sessionRoles.set(runtime.id, role);
  } else if (!host.sessionRoles.has(runtime.id)) {
    try {
      const teamConfig = loadTeamConfig();
      host.sessionRoles.set(runtime.id, teamConfig.defaultRole);
    } catch {}
  }
  const label = host.offlineSessions.find((offline: any) => offline.id === runtime.id)?.label;
  if (label) {
    host.sessionLabels.set(runtime.id, label);
  }

  host.sessions.push(runtime);
  host.updateContextWatcherSessions();
  if (host.sessions.length === 1) host.contextWatcher.start();
  return runtime;
}

export function handleSessionRuntimeEvent(host: SessionRuntimeHost, runtime: any, event: any): void {
  if (event.type === "output") {
    host.writeStatuslineFile();
    return;
  }

  if (event.type !== "exit") return;
  const code = event.code;

  host.debug?.(`session exited: ${runtime.id} (code=${code})`, "session");

  const uptime = runtime.startTime ? Date.now() - runtime.startTime : Infinity;
  let errorHint = "";
  if (code !== 0 && uptime < 10_000) {
    const sessionCwd = host.sessionWorktreePaths.get(runtime.id);
    const searchDirs = [getProjectStateDir(), sessionCwd ? getAimuxDirFor(sessionCwd) : null].filter(
      Boolean,
    ) as string[];
    for (const dir of searchDirs) {
      if (errorHint) break;
      try {
        const logPath = join(dir, "recordings", `${runtime.id}.log`);
        if (existsSync(logPath)) {
          const raw = readFileSync(logPath, "utf-8");
          const lines = raw
            .split("\n")
            .map((l) => l.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim())
            .filter(Boolean);
          const errorLine = lines.find(
            (l) => l.includes("Error") || l.includes("error") || l.includes("unmatched") || l.includes("not found"),
          );
          if (errorLine) errorHint = `: ${errorLine.slice(0, 60)}`;
        }
      } catch {}
    }
    host.footerFlash = `✗ ${runtime.id} crashed (code ${code})${errorHint}`;
    host.footerFlashTicks = 8;
    host.debug?.(`quick crash: ${runtime.id} (code=${code}, uptime=${uptime}ms)${errorHint}`, "session");
  }

  if (code !== 0) {
    host.publishAlert({
      kind: "task_failed",
      sessionId: runtime.id,
      title: `${runtime.id} failed`,
      message: errorHint ? `Agent exited with code ${code}${errorHint}` : `Agent exited with code ${code}.`,
      dedupeKey: `exit-failed:${runtime.id}`,
      cooldownMs: 15_000,
    });
  }
  captureGitContext(runtime.id, runtime.command).catch(() => {});

  const idx = host.sessions.indexOf(runtime);
  if (idx === -1) return;

  const explicitStop = host.stoppingSessionIds.has(runtime.id);
  const graveyardAfterStop = host.graveyardAfterStopSessionIds?.has?.(runtime.id) ?? false;
  const backendSessionId = runtime.backendSessionId;
  const shouldPreserveOffline = !graveyardAfterStop && (explicitStop || Boolean(backendSessionId) || uptime >= 10_000);
  if (shouldPreserveOffline && !host.offlineSessions.some((entry: any) => entry.id === runtime.id)) {
    host.offlineSessions.push({
      id: runtime.id,
      tool: runtime.command,
      toolConfigKey: host.sessionToolKeys.get(runtime.id) ?? runtime.command,
      command: runtime.command,
      args: host.sessionOriginalArgs.get(runtime.id) ?? [],
      lifecycle: "offline",
      createdAt: runtime.startTime ? new Date(runtime.startTime).toISOString() : undefined,
      backendSessionId,
      team: runtime.team,
      worktreePath: host.sessionWorktreePaths.get(runtime.id),
      label: host.getSessionLabel(runtime.id),
      headline: host.deriveHeadline(runtime.id),
    });
  } else if (!shouldPreserveOffline) {
    host.unpreservedExitedSessionIds ??= new Set<string>();
    host.unpreservedExitedSessionIds.add(runtime.id);
  }

  host.sessions.splice(idx, 1);
  host.stoppingSessionIds.delete(runtime.id);
  host.graveyardAfterStopSessionIds?.delete?.(runtime.id);
  if (graveyardAfterStop) {
    host.offlineSessions = host.offlineSessions.filter((entry: any) => entry.id !== runtime.id);
  }
  host.updateContextWatcherSessions();
  const mappedTarget = host.sessionTmuxTargets.get(runtime.id);
  const runtimeTarget = runtime.transport instanceof TmuxSessionTransport ? runtime.transport.tmuxTarget : undefined;
  if (!mappedTarget || !runtimeTarget || mappedTarget.windowId === runtimeTarget.windowId) {
    host.sessionTmuxTargets.delete(runtime.id);
  }
  host.saveState();

  if (host.sessions.length === 0) {
    if (host.startedInDashboard) {
      host.renderDashboard();
      return;
    }
    host.resolveRun?.(code);
    return;
  }

  if (host.activeIndex >= host.sessions.length) {
    host.activeIndex = host.sessions.length - 1;
  }

  host.renderDashboard();
}

export function buildTmuxWindowMetadata(
  host: SessionRuntimeHost,
  sessionId: string,
  command: string,
  existing?: { team?: SessionTeamMetadata } | null,
): any {
  const sessionMetadata = loadMetadataState().sessions[sessionId];
  const runtime = host.sessions.find((session: any) => session.id === sessionId);
  // Compute the same semantic user label the dashboard shows, from the single source
  // of truth, so Exposé and the dashboard never disagree on an agent's state.
  const semantic = deriveSessionSemantics({
    status: runtime?.status ?? "running",
    activity: sessionMetadata?.derived?.activity,
    attention: sessionMetadata?.derived?.attention,
    unseenCount: sessionMetadata?.derived?.unseenCount,
  });
  const derived = sessionMetadata?.derived;
  const lastOutputAt =
    derived?.lastOutputAt ??
    (derived?.lastEvent && isAgentOutputEventKind(derived.lastEvent.kind) ? derived.lastEvent.ts : undefined);
  const anchor = sessionRecencyAnchor({
    label: semantic.user.label,
    lastOutputAt,
    becameIdleAt: derived?.becameIdleAt,
  });
  return {
    kind: "agent",
    sessionId,
    command,
    args: host.sessionOriginalArgs.get(sessionId) ?? [],
    toolConfigKey: host.sessionToolKeys.get(sessionId) ?? command,
    backendSessionId: runtime?.backendSessionId,
    team: runtime?.team ?? existing?.team,
    worktreePath: host.sessionWorktreePaths.get(sessionId),
    label: getSessionLabel(host, sessionId),
    role: host.sessionRoles.get(sessionId),
    activity: sessionMetadata?.derived?.activity,
    attention: sessionMetadata?.derived?.attention,
    unseenCount: sessionMetadata?.derived?.unseenCount,
    statusText: sessionMetadata?.status?.text,
    userLabel: semantic.user.label,
    recencyAt: anchor?.value,
    recencyLabel: anchor?.label,
  };
}

export function syncTmuxWindowMetadata(host: SessionRuntimeHost, sessionId: string): void {
  const runtime = host.sessions.find((session: any) => session.id === sessionId);
  if (!runtime || !(runtime.transport instanceof TmuxSessionTransport)) return;
  let target = resolveLiveSessionTmuxTarget(host, sessionId, runtime.transport.tmuxTarget);
  if (!target) {
    target = runtime.transport.tmuxTarget;
    const fallbackMetadata = host.tmuxRuntimeManager.getWindowMetadata(target);
    if (fallbackMetadata && fallbackMetadata.sessionId !== sessionId) return;
  }
  const existing = host.tmuxRuntimeManager.getWindowMetadata(target);
  const metadata = buildTmuxWindowMetadata(host, sessionId, runtime.command, existing);
  metadata.createdAt =
    existing?.createdAt ??
    (runtime.startTime ? new Date(runtime.startTime).toISOString() : undefined) ??
    new Date().toISOString();
  runtime.transport.retarget(target);
  host.tmuxRuntimeManager.setWindowMetadata(target, metadata);
  host.tmuxRuntimeManager.applyManagedAgentWindowPolicy(target, metadata.toolConfigKey);
}

export function updateContextWatcherSessions(host: SessionRuntimeHost): void {
  host.contextWatcher.updateSessions(
    host.sessions.map((s: any) => {
      const key = host.sessionToolKeys.get(s.id);
      const tc = key ? loadConfig().tools[key] : undefined;
      return {
        id: s.id,
        command: s.command,
        turnPatterns: tc?.turnPatterns?.map((p: string) => new RegExp(p)),
        tmuxTarget: resolveLiveSessionTmuxTarget(host, s.id),
      };
    }),
  );
}
