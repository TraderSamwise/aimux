import { basename } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { getProjectStateDirFor } from "./paths.js";
import { TmuxRuntimeManager } from "./tmux-runtime-manager.js";
import type { AgentActivityState, AgentAttentionState } from "./agent-events.js";

export type TmuxStatusLine = "top" | "bottom";

interface StatuslineSession {
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

interface StatuslineData {
  project?: string;
  dashboardScreen?: "dashboard" | "plans" | "graveyard" | "all" | "help";
  sessions?: StatuslineSession[];
  metadata?: Record<
    string,
    {
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
      };
      updatedAt?: string;
    }
  >;
  tasks?: {
    pending?: number;
    assigned?: number;
  };
  flash?: string | null;
  updatedAt?: string;
}

const STALE_SECONDS = 10;

function loadStatusline(projectRoot: string): StatuslineData | null {
  try {
    const path = `${getProjectStateDirFor(projectRoot)}/statusline.json`;
    if (!existsSync(path)) return null;
    const age = Date.now() / 1000 - statSync(path).mtimeMs / 1000;
    if (age > STALE_SECONDS) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as StatuslineData;
  } catch {
    return null;
  }
}

function trim(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function sessionIdentity(session: StatuslineSession): string {
  const base = session.label || session.tool || session.id;
  return session.role ? `${base}(${session.role})` : base;
}

function renderProjectIdentity(projectRoot: string): string {
  return `aimux ${basename(projectRoot)}`;
}

function normalizePath(path: string | undefined, projectRoot: string): string {
  return path?.trim() || projectRoot;
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

function currentPathContext(currentPath: string | undefined): { worktreeName?: string; branch?: string } | null {
  if (!currentPath) return null;
  const worktreeName = basename(currentPath);
  const branch = gitOutput(currentPath, "git rev-parse --abbrev-ref HEAD") || undefined;
  return {
    worktreeName: worktreeName || undefined,
    branch,
  };
}

function renderDashboardScreens(activeScreen: StatuslineData["dashboardScreen"]): string[] {
  const active = activeScreen ?? "dashboard";
  const screens: Array<{ key: StatuslineData["dashboardScreen"]; label: string }> = [
    { key: "dashboard", label: "dashboard" },
    { key: "plans", label: "plans" },
    { key: "graveyard", label: "graveyard" },
  ];
  return screens.map((screen) => (screen.key === active ? `[${screen.label}]` : screen.label));
}

function renderScopedSessionsFromTmux(
  data: StatuslineData,
  currentSession: string | undefined,
  projectRoot: string,
  currentWindow?: string,
  currentPath?: string,
): string[] {
  if (!currentSession) return [];
  const normalizedCurrentPath = normalizePath(currentPath, projectRoot);
  let windows: ReturnType<TmuxRuntimeManager["listManagedWindows"]> = [];
  try {
    windows = new TmuxRuntimeManager().listManagedWindows(currentSession);
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
      const session = sessionMap.get(metadata.sessionId);
      const derived = data.metadata?.[metadata.sessionId]?.derived;
      const status = session?.status ?? "unknown";
      const icon = status === "idle" ? "·" : status === "running" ? "●" : status === "waiting" ? "◌" : "○";
      const identity = trim(
        sessionIdentity(session ?? { id: metadata.sessionId, tool: metadata.command, label: metadata.label }),
        16,
      );
      const isCurrent = currentWindow
        ? target.windowName === currentWindow || metadata.label === currentWindow
        : session?.active;
      const badge = renderDerivedBadge(derived);
      const rendered = `${icon}${identity}${badge ? ` ${badge}` : ""}`;
      return isCurrent ? `${rendered}*` : rendered;
    });
}

function renderDerivedBadge(
  derived:
    | {
        activity?: AgentActivityState;
        attention?: AgentAttentionState;
        unseenCount?: number;
      }
    | undefined,
): string | null {
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

function getCurrentSessionId(
  data: StatuslineData,
  currentSession: string | undefined,
  currentWindow?: string,
): string | undefined {
  if (currentSession && currentWindow) {
    try {
      const windows = new TmuxRuntimeManager().listManagedWindows(currentSession);
      const current = windows.find(
        ({ target, metadata }) => target.windowName === currentWindow || metadata.label === currentWindow,
      );
      if (current?.metadata.sessionId) return current.metadata.sessionId;
    } catch {}
  }
  return data.sessions?.find((session) => session.active)?.id;
}

function renderActiveContext(
  data: StatuslineData,
  currentSession: string | undefined,
  currentWindow?: string,
  currentPath?: string,
): string | null {
  const activeSessionId = getCurrentSessionId(data, currentSession, currentWindow);
  if (!activeSessionId) return null;
  const context = data.metadata?.[activeSessionId]?.context;
  const liveContext = currentPathContext(currentPath);
  const worktree = liveContext?.worktreeName
    ? trim(liveContext.worktreeName, 16)
    : context?.worktreeName
      ? trim(context.worktreeName, 16)
      : null;
  const branch = liveContext?.branch ? trim(liveContext.branch, 18) : context?.branch ? trim(context.branch, 18) : null;
  const pr = context?.pr?.number ? `PR #${context.pr.number}` : null;
  if (!worktree && !branch && !pr) return null;
  if (worktree && branch && pr) return `${worktree}@${branch}  ·  ${pr}`;
  if (worktree && branch) return `${worktree}@${branch}`;
  return [worktree, branch, pr].filter((segment): segment is string => Boolean(segment)).join("  ·  ");
}

function renderTasks(data: StatuslineData): string | null {
  const pending = data.tasks?.pending ?? 0;
  const assigned = data.tasks?.assigned ?? 0;
  if (pending === 0 && assigned === 0) return null;
  return `tasks ${pending}/${assigned}`;
}

function renderFlash(data: StatuslineData): string | null {
  const flash = data.flash?.trim();
  if (!flash) return null;
  return trim(flash, 36);
}

function renderActiveHeadline(data: StatuslineData): string | null {
  const active = (data.sessions ?? []).find((session) => session.active);
  const headline = active?.headline?.trim();
  if (!headline) return null;
  return trim(headline, 42);
}

function renderActiveMetadata(
  data: StatuslineData,
  currentSession: string | undefined,
  currentWindow?: string,
): string | null {
  const activeSessionId = getCurrentSessionId(data, currentSession, currentWindow);
  if (!activeSessionId) return null;
  const metadata = data.metadata?.[activeSessionId];
  if (!metadata) return null;
  if (metadata.derived?.attention === "error") return "error";
  if (metadata.derived?.attention === "needs_input") return "needs input";
  if (metadata.derived?.attention === "blocked") return "blocked";
  if (metadata.derived?.activity === "running") return "running";
  if (metadata.derived?.activity === "waiting") return "waiting";
  if (metadata.derived?.activity === "done") return "done";
  if ((metadata.derived?.unseenCount ?? 0) > 0) return `unseen ${metadata.derived?.unseenCount}`;
  if (metadata.status?.text) return trim(metadata.status.text, 28);
  if (metadata.progress && metadata.progress.total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((metadata.progress.current / metadata.progress.total) * 100)));
    return trim(
      `${metadata.progress.label ?? "plan"} ${metadata.progress.current}/${metadata.progress.total} ${pct}%`,
      28,
    );
  }
  const lastLog = metadata.logs?.at(-1)?.message;
  if (lastLog) return trim(lastLog, 28);
  return null;
}

function renderTopLine(
  projectRoot: string,
  currentWindow?: string,
  currentPath?: string,
  currentSession?: string,
  width?: number,
): string {
  const data = loadStatusline(projectRoot);
  const segments = [
    renderProjectIdentity(projectRoot),
    data ? renderActiveContext(data, currentSession, currentWindow, currentPath) : null,
    data ? renderTasks(data) : null,
    data ? renderActiveMetadata(data, currentSession, currentWindow) : null,
    data ? renderFlash(data) : null,
  ].filter((segment): segment is string => Boolean(segment));
  const separator = "  ·  ";
  const joined = segments.join(separator);
  return width ? trim(joined, Math.max(24, width - 2)) : joined;
}

function renderBottomLine(
  projectRoot: string,
  currentWindow?: string,
  currentPath?: string,
  currentSession?: string,
  width?: number,
): string {
  const data = loadStatusline(projectRoot);
  if (!data) return "";
  const sessionSegments =
    currentWindow === "dashboard"
      ? renderDashboardScreens(data.dashboardScreen)
      : renderScopedSessionsFromTmux(data, currentSession, projectRoot, currentWindow, currentPath);
  const segments = [...sessionSegments, renderActiveHeadline(data)].filter((segment): segment is string =>
    Boolean(segment),
  );
  const maxWidth = Math.max(24, (width ?? 120) - 2);
  const separator = "  ·  ";
  const chosen: string[] = [];
  let used = 0;
  for (const segment of segments) {
    const next = segment.length + (chosen.length > 0 ? separator.length : 0);
    if (used + next > maxWidth) break;
    chosen.push(segment);
    used += next;
  }
  return chosen.join(separator);
}

export function renderTmuxStatusline(
  projectRoot: string,
  line: TmuxStatusLine,
  options: { currentWindow?: string; currentPath?: string; currentSession?: string; width?: number } = {},
): string {
  return line === "top"
    ? renderTopLine(projectRoot, options.currentWindow, options.currentPath, options.currentSession, options.width)
    : renderBottomLine(projectRoot, options.currentWindow, options.currentPath, options.currentSession, options.width);
}
