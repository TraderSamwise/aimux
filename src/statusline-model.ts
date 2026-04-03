import { basename } from "node:path";
import type { AgentActivityState, AgentAttentionState } from "./agent-events.js";
import type { SessionSemanticState } from "./session-semantics.js";
import { sessionSemanticCompactHint } from "./session-semantics.js";

export interface StatuslineSession {
  id: string;
  tool: string;
  label?: string;
  tmuxWindowId?: string;
  windowName?: string;
  headline?: string;
  status?: string;
  role?: string;
  active?: boolean;
  worktreePath?: string;
  semantic?: SessionSemanticState;
}

export interface StatuslineMetadataEntry {
  status?: { text: string; tone?: string };
  progress?: { current: number; total: number; label?: string };
  logs?: Array<{ message: string; source?: string; tone?: string; ts: string }>;
  context?: {
    cwd?: string;
    worktreePath?: string;
    worktreeName?: string;
    branch?: string;
    pr?: { number?: number; title?: string; url?: string; headRef?: string; baseRef?: string };
    repo?: { owner?: string; name?: string; remote?: string };
  };
  derived?: {
    activity?: AgentActivityState;
    attention?: AgentAttentionState;
    unseenCount?: number;
    services?: Array<{ label?: string; url?: string; port?: number }>;
  };
  updatedAt?: string;
}

export interface StatuslineData {
  project?: string;
  dashboardScreen?: "dashboard" | "plans" | "graveyard" | "activity" | "threads" | "help";
  sessions?: StatuslineSession[];
  metadata?: Record<string, StatuslineMetadataEntry>;
  controlPlane?: {
    daemonAlive?: boolean;
    projectServiceAlive?: boolean;
    projectServiceOutdated?: boolean;
  };
  tasks?: {
    pending?: number;
    assigned?: number;
  };
  flash?: string | null;
  updatedAt?: string;
}

export interface ResolvedStatuslineSession extends StatuslineSession {
  derived?: StatuslineMetadataEntry["derived"];
  metadata?: StatuslineMetadataEntry;
  isCurrent: boolean;
}

export function trim(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function normalizePath(path: string | undefined, projectRoot: string): string {
  return path?.trim() || projectRoot;
}

export function sessionIdentity(session: Pick<StatuslineSession, "id" | "tool" | "label" | "role">): string {
  const base = session.label || session.tool || session.id;
  return session.role ? `${base}(${session.role})` : base;
}

export function renderDerivedBadge(derived: StatuslineMetadataEntry["derived"]): string | null {
  if (!derived) return null;
  if (derived.attention === "error") return "✗";
  if (derived.attention === "needs_input") return "?";
  if (derived.attention === "blocked") return "!";
  if ((derived.unseenCount ?? 0) > 0) return String(Math.min(derived.unseenCount ?? 0, 9));
  if (derived.activity === "done") return "✓";
  if (derived.activity === "running") return "↻";
  if (derived.activity === "waiting") return "…";
  return null;
}

export function renderSessionCompactHint(session: {
  semantic?: SessionSemanticState;
  derived?: StatuslineMetadataEntry["derived"];
}): string | null {
  if (session.semantic) {
    return sessionSemanticCompactHint(session.semantic);
  }
  if (session.derived?.attention === "error") return "error";
  if (session.derived?.attention === "needs_input") return "on you";
  if (session.derived?.attention === "blocked") return "blocked";
  if ((session.derived?.unseenCount ?? 0) > 0) {
    return `${Math.min(session.derived?.unseenCount ?? 0, 99)} unread`;
  }
  return null;
}

export function renderDashboardScreens(activeScreen: StatuslineData["dashboardScreen"]): string[] {
  const active = activeScreen ?? "dashboard";
  const screens: Array<{ key: StatuslineData["dashboardScreen"]; label: string }> = [
    { key: "dashboard", label: "dashboard" },
    { key: "activity", label: "activity" },
    { key: "threads", label: "threads" },
    { key: "plans", label: "plans" },
    { key: "graveyard", label: "graveyard" },
  ];
  return screens.map((screen) => (screen.key === active ? `[${screen.label}]` : screen.label));
}

export function currentPathContext(currentPath: string | undefined): { worktreeName?: string; branch?: string } | null {
  if (!currentPath) return null;
  const worktreeName = basename(currentPath);
  return {
    worktreeName: worktreeName || undefined,
  };
}

export function resolveCurrentSessionId(
  data: StatuslineData,
  currentSession?: string,
  currentWindow?: string,
  currentWindowId?: string,
  currentPath?: string,
  projectRoot?: string,
): string | undefined {
  const sessions = data.sessions ?? [];
  if (currentWindowId) {
    const byWindow = sessions.find((session) => session.tmuxWindowId === currentWindowId);
    if (byWindow?.id) return byWindow.id;
  }
  if (currentWindow && projectRoot) {
    const normalizedCurrentPath = normalizePath(currentPath, projectRoot);
    const byScopedWindow = sessions.find((session) => {
      if (normalizePath(session.worktreePath, projectRoot) !== normalizedCurrentPath) return false;
      return session.windowName === currentWindow || session.label === currentWindow || session.tool === currentWindow;
    });
    if (byScopedWindow?.id) return byScopedWindow.id;
  }
  return data.sessions?.find((session) => session.active)?.id;
}

export function resolveScopedSessions(
  data: StatuslineData,
  projectRoot: string,
  currentSession?: string,
  currentWindow?: string,
  currentWindowId?: string,
  currentPath?: string,
): ResolvedStatuslineSession[] {
  const normalizedCurrentPath = normalizePath(currentPath, projectRoot);
  return (data.sessions ?? [])
    .filter((session) => normalizePath(session.worktreePath, projectRoot) === normalizedCurrentPath)
    .slice(0, 5)
    .map((session) => {
      const resolvedMetadata = data.metadata?.[session.id];
      return {
        ...session,
        derived: resolvedMetadata?.derived,
        semantic: session.semantic,
        metadata: resolvedMetadata,
        isCurrent: currentWindowId ? session.tmuxWindowId === currentWindowId : Boolean(session.active),
      };
    });
}

export function resolveSessionMetadata(
  data: StatuslineData,
  projectRoot: string,
  currentSession?: string,
  currentWindow?: string,
  currentWindowId?: string,
  currentPath?: string,
): StatuslineMetadataEntry | undefined {
  const activeSessionId = resolveCurrentSessionId(
    data,
    currentSession,
    currentWindow,
    currentWindowId,
    currentPath,
    projectRoot,
  );
  if (!activeSessionId) return undefined;
  return data.metadata?.[activeSessionId];
}
