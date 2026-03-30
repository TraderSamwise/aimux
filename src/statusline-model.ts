import { basename } from "node:path";
import { execSync } from "node:child_process";
import type { AgentActivityState, AgentAttentionState } from "./agent-events.js";
import type { TmuxRuntimeManager } from "./tmux-runtime-manager.js";

export interface StatuslineSession {
  id: string;
  tool: string;
  label?: string;
  windowName?: string;
  headline?: string;
  status?: string;
  role?: string;
  active?: boolean;
  worktreePath?: string;
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
  dashboardScreen?: "dashboard" | "plans" | "graveyard" | "activity" | "help";
  sessions?: StatuslineSession[];
  metadata?: Record<string, StatuslineMetadataEntry>;
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

export function renderDashboardScreens(activeScreen: StatuslineData["dashboardScreen"]): string[] {
  const active = activeScreen ?? "dashboard";
  const screens: Array<{ key: StatuslineData["dashboardScreen"]; label: string }> = [
    { key: "dashboard", label: "dashboard" },
    { key: "activity", label: "activity" },
    { key: "plans", label: "plans" },
    { key: "graveyard", label: "graveyard" },
  ];
  return screens.map((screen) => (screen.key === active ? `[${screen.label}]` : screen.label));
}

function gitOutput(cwd: string, command: string): string | null {
  try {
    return execSync(command, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function currentPathContext(currentPath: string | undefined): { worktreeName?: string; branch?: string } | null {
  if (!currentPath) return null;
  const worktreeName = basename(currentPath);
  const branch = gitOutput(currentPath, "git rev-parse --abbrev-ref HEAD") || undefined;
  return {
    worktreeName: worktreeName || undefined,
    branch,
  };
}

export function resolveCurrentSessionId(
  data: StatuslineData,
  tmuxRuntimeManager: TmuxRuntimeManager,
  currentSession?: string,
  currentWindow?: string,
  currentPath?: string,
  projectRoot?: string,
): string | undefined {
  if (currentSession && currentWindow && projectRoot) {
    try {
      const normalizedCurrentPath = normalizePath(currentPath, projectRoot);
      const windows = tmuxRuntimeManager.listManagedWindows(currentSession);
      const current = windows.find(({ target, metadata }) => {
        const metadataPath = normalizePath(metadata.worktreePath, projectRoot);
        return (
          metadataPath === normalizedCurrentPath &&
          (target.windowName === currentWindow || metadata.label === currentWindow)
        );
      });
      if (current?.metadata.sessionId) return current.metadata.sessionId;
    } catch {}
  }
  return data.sessions?.find((session) => session.active)?.id;
}

export function resolveScopedSessions(
  data: StatuslineData,
  tmuxRuntimeManager: TmuxRuntimeManager,
  projectRoot: string,
  currentSession?: string,
  currentWindow?: string,
  currentPath?: string,
): ResolvedStatuslineSession[] {
  if (!currentSession) return [];
  const normalizedCurrentPath = normalizePath(currentPath, projectRoot);
  let windows: ReturnType<TmuxRuntimeManager["listManagedWindows"]> = [];
  try {
    windows = tmuxRuntimeManager.listManagedWindows(currentSession);
  } catch {
    return [];
  }

  const sessionMap = new Map((data.sessions ?? []).map((session) => [session.id, session]));
  return windows
    .filter(({ target, metadata }) => {
      if (target.windowName === "dashboard" || target.windowIndex === 0) return false;
      return normalizePath(metadata.worktreePath, projectRoot) === normalizedCurrentPath;
    })
    .slice(0, 5)
    .map(({ target, metadata }) => {
      const session =
        sessionMap.get(metadata.sessionId) ??
        ({
          id: metadata.sessionId,
          tool: metadata.command,
          label: metadata.label,
          role: metadata.role,
        } satisfies StatuslineSession);
      const metadataPath = normalizePath(metadata.worktreePath, projectRoot);
      const matchesCurrentPath = metadataPath === normalizedCurrentPath;
      return {
        ...session,
        derived: data.metadata?.[metadata.sessionId]?.derived,
        metadata: data.metadata?.[metadata.sessionId],
        isCurrent: currentWindow
          ? matchesCurrentPath && (target.windowName === currentWindow || metadata.label === currentWindow)
          : Boolean(session.active),
      };
    });
}
