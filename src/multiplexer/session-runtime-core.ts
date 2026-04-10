import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../config.js";
import { readHistory } from "../context/history.js";
import { getAimuxDirFor, getProjectStateDir, getStatusDir } from "../paths.js";
import { loadTeamConfig } from "../team.js";
import { SessionRuntime } from "../session-runtime.js";
import { TmuxSessionTransport } from "../tmux/session-transport.js";
import { loadMetadataState } from "../metadata-store.js";
import { parseAgentOutput } from "../agent-output-parser.js";
import { serializeAgentInput } from "../agent-message-parts.js";
import { resolveAttachmentPath } from "../attachment-store.js";
import { appendSessionMessage, readSessionMessages } from "../session-message-history.js";
import { captureGitContext } from "../context/context-bridge.js";

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
    applySessionLabel(host, sessionId, label);
    applyDashboardSessionLabel(host, sessionId, label);
    host.setPendingDashboardSessionAction(sessionId, "renaming");
    host.writeStatuslineFile();
    host.renderCurrentDashboardView();
    void host
      .postToProjectService("/agents/rename", { sessionId, label })
      .then(() => {
        host.invalidateDesktopStateSnapshot();
        host.setPendingDashboardSessionAction(sessionId, null);
        host.writeStatuslineFile();
        host.renderCurrentDashboardView();
      })
      .catch((err: unknown) => {
        host.setPendingDashboardSessionAction(sessionId, null);
        host.footerFlash = `Rename failed: ${err instanceof Error ? err.message : String(err)}`;
        host.footerFlashTicks = 4;
        host.writeStatuslineFile();
        host.renderCurrentDashboardView();
      });
    return;
  }

  applySessionLabel(host, sessionId, label);
  host.invalidateDesktopStateSnapshot();

  const localSession = host.sessions.find((session: any) => session.id === sessionId)?.transport;
  if (localSession instanceof TmuxSessionTransport) {
    localSession.renameWindow(localSession.command);
    const target = localSession.tmuxTarget;
    host.sessionTmuxTargets.set(sessionId, target);
    host.syncTmuxWindowMetadata(sessionId);
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
  const taskDescription = host.taskDispatcher?.getSessionTask(sessionId);
  if (taskDescription) return taskDescription.slice(0, 80);

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

export function writeTmuxAgentInput(
  host: SessionRuntimeHost,
  sessionId: string,
  transport: TmuxSessionTransport,
  data: string,
): void {
  const target = host.sessionTmuxTargets.get(sessionId) ?? transport.tmuxTarget;
  let textBuffer = "";
  const flushText = () => {
    if (!textBuffer) return;
    host.tmuxRuntimeManager.sendText(target, textBuffer);
    textBuffer = "";
  };

  for (const ch of data) {
    if (ch === "\r") {
      flushText();
      host.tmuxRuntimeManager.sendEnter(target);
      continue;
    }
    if (ch === "\n") {
      flushText();
      host.tmuxRuntimeManager.sendKey(target, "C-j");
      continue;
    }
    textBuffer += ch;
  }

  flushText();
}

export function normalizeAgentInput(_host: SessionRuntimeHost, data: string, submit: boolean): string {
  if (!submit) return data;
  return data.replace(/(?:\r\n|\r|\n)+$/g, "");
}

export function paneStillContainsAgentDraft(host: SessionRuntimeHost, target: any, draft: string): boolean {
  try {
    const pane = host.tmuxRuntimeManager.captureTarget(target, { startLine: -60 });
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
    const normalizedDraft = normalize(draft);
    if (!normalizedDraft) return false;
    return normalize(pane).includes(normalizedDraft);
  } catch {
    return false;
  }
}

export function scheduleTmuxAgentSubmit(host: SessionRuntimeHost, sessionId: string, target: any, draft: string): void {
  const submitOnce = () => {
    try {
      host.tmuxRuntimeManager.sendEnter(target);
    } catch {}
  };

  const step = (attempt = 1) => {
    if (attempt > 4) return;
    setTimeout(
      () => {
        try {
          const currentTarget = host.sessionTmuxTargets.get(sessionId);
          if (!currentTarget || currentTarget.windowId !== target.windowId) {
            return;
          }
          submitOnce();
          if (attempt >= 4) return;
          setTimeout(() => {
            try {
              if (paneStillContainsAgentDraft(host, target, draft)) {
                step(attempt + 1);
              }
            } catch {}
          }, 700);
        } catch {}
      },
      attempt === 1 ? 150 : 700,
    );
  };

  step();
}

export async function writeAgentInput(
  host: SessionRuntimeHost,
  sessionId: string,
  data = "",
  parts?: any[],
  clientMessageId?: string,
  submit = false,
): Promise<{ sessionId: string }> {
  const session = resolveRunningSession(host, sessionId);
  appendSessionMessage(sessionId, { data, parts, clientMessageId });
  const serializedData = serializeAgentInput(
    { data, parts },
    {
      tool: host.sessionToolKeys.get(sessionId),
      resolveAttachmentPath,
    },
  );
  const normalizedData = normalizeAgentInput(host, serializedData, submit);
  if (!normalizedData && !submit) {
    throw new Error("input data is required");
  }
  if (session.transport instanceof TmuxSessionTransport) {
    if (normalizedData) {
      writeTmuxAgentInput(host, sessionId, session.transport, normalizedData);
    }
    if (submit) {
      const target = host.sessionTmuxTargets.get(sessionId) ?? session.transport.tmuxTarget;
      scheduleTmuxAgentSubmit(host, sessionId, target, normalizedData);
    }
  } else {
    session.write(submit ? `${normalizedData}\r` : normalizedData);
  }
  return { sessionId };
}

export async function readAgentHistory(
  host: SessionRuntimeHost,
  sessionId: string,
  lastN?: number,
): Promise<{ sessionId: string; messages: ReturnType<typeof readSessionMessages>; lastN?: number }> {
  resolveRunningSession(host, sessionId);
  return {
    sessionId,
    messages: readSessionMessages(sessionId, { lastN: lastN ?? 20 }),
    lastN: lastN ?? 20,
  };
}

export async function interruptAgent(host: SessionRuntimeHost, sessionId: string): Promise<{ sessionId: string }> {
  const session = resolveRunningSession(host, sessionId);
  if (session.transport instanceof TmuxSessionTransport) {
    const target = host.sessionTmuxTargets.get(sessionId) ?? session.transport.tmuxTarget;
    host.tmuxRuntimeManager.sendEscape(target);
  } else {
    session.write("\x1b");
  }
  return { sessionId };
}

export async function readAgentOutput(
  host: SessionRuntimeHost,
  sessionId: string,
  startLine?: number,
): Promise<{ sessionId: string; output: string; startLine?: number; parsed: any }> {
  resolveRunningSession(host, sessionId);
  const target = host.sessionTmuxTargets.get(sessionId);
  if (!target) {
    throw new Error(`Session "${sessionId}" does not have a tmux target`);
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
): any {
  const existing = host.sessions.find((runtime: any) => runtime.transport === session);
  if (existing) return existing;

  const runtime = new SessionRuntime(session, startTime, {
    onEvent: (event: any) => host.handleSessionRuntimeEvent(runtime, event),
  });

  if (toolConfigKey) {
    host.sessionToolKeys.set(runtime.id, toolConfigKey);
  }
  host.sessionOriginalArgs.set(runtime.id, args);
  if (worktreePath) {
    host.sessionWorktreePaths.set(runtime.id, worktreePath);
  }
  if (role) {
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
  host.writeSessionsFile();
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

  host.sessions.splice(idx, 1);
  host.stoppingSessionIds.delete(runtime.id);
  host.writeSessionsFile();
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

export function buildTmuxWindowMetadata(host: SessionRuntimeHost, sessionId: string, command: string): any {
  const sessionMetadata = loadMetadataState().sessions[sessionId];
  return {
    kind: "agent",
    sessionId,
    command,
    args: host.sessionOriginalArgs.get(sessionId) ?? [],
    toolConfigKey: host.sessionToolKeys.get(sessionId) ?? command,
    backendSessionId: host.sessions.find((session: any) => session.id === sessionId)?.backendSessionId,
    worktreePath: host.sessionWorktreePaths.get(sessionId),
    label: getSessionLabel(host, sessionId),
    role: host.sessionRoles.get(sessionId),
    activity: sessionMetadata?.derived?.activity,
    attention: sessionMetadata?.derived?.attention,
    unseenCount: sessionMetadata?.derived?.unseenCount,
    statusText: sessionMetadata?.status?.text,
  };
}

export function syncTmuxWindowMetadata(host: SessionRuntimeHost, sessionId: string): void {
  const runtime = host.sessions.find((session: any) => session.id === sessionId);
  if (!runtime || !(runtime.transport instanceof TmuxSessionTransport)) return;
  const metadata = buildTmuxWindowMetadata(host, sessionId, runtime.command);
  host.tmuxRuntimeManager.setWindowMetadata(runtime.transport.tmuxTarget, metadata);
  host.tmuxRuntimeManager.applyManagedAgentWindowPolicy(runtime.transport.tmuxTarget, metadata.toolConfigKey);
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
        tmuxTarget: host.sessionTmuxTargets.get(s.id),
      };
    }),
  );
}
