import { basename } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { getProjectStateDirFor } from "./paths.js";

export type TmuxStatusSide = "left" | "right";

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
  sessions?: StatuslineSession[];
  metadata?: Record<
    string,
    {
      status?: { text: string; tone?: string };
      progress?: { current: number; total: number; label?: string };
      logs?: Array<{ message: string; source?: string; tone?: string; ts: string }>;
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

function renderLeft(projectRoot: string): string {
  return `aimux ${basename(projectRoot)}`;
}

function normalizePath(path: string | undefined, projectRoot: string): string {
  return path?.trim() || projectRoot;
}

function renderDashboardScreens(): string[] {
  return ["[dashboard]", "plans", "graveyard"];
}

function sessionWindowIdentity(session: StatuslineSession): string {
  return session.windowName?.trim() || session.label?.trim() || session.tool || session.id;
}

function renderScopedSessions(
  data: StatuslineData,
  projectRoot: string,
  currentWindow?: string,
  currentPath?: string,
): string[] {
  const sessions = data.sessions ?? [];
  const normalizedCurrentPath = normalizePath(currentPath, projectRoot);
  const scoped = sessions.filter(
    (session) => normalizePath(session.worktreePath, projectRoot) === normalizedCurrentPath,
  );
  return scoped.slice(0, 5).map((session) => {
    const status = session.status ?? "unknown";
    const icon = status === "idle" ? "·" : status === "running" ? "●" : status === "waiting" ? "◌" : "○";
    const identity = trim(sessionIdentity(session), 18);
    const isCurrent = currentWindow ? sessionWindowIdentity(session) === currentWindow : session.active;
    return isCurrent ? `${icon}${identity}*` : `${icon}${identity}`;
  });
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

function renderActiveMetadata(data: StatuslineData): string | null {
  const active = (data.sessions ?? []).find((session) => session.active);
  if (!active) return null;
  const metadata = data.metadata?.[active.id];
  if (!metadata) return null;
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

function renderRight(projectRoot: string, currentWindow?: string, currentPath?: string): string {
  const data = loadStatusline(projectRoot);
  if (!data) return "";
  const sessionSegments =
    currentWindow === "dashboard"
      ? renderDashboardScreens()
      : renderScopedSessions(data, projectRoot, currentWindow, currentPath);
  const segments = [
    ...sessionSegments,
    renderTasks(data),
    renderActiveMetadata(data),
    renderActiveHeadline(data),
    renderFlash(data),
  ].filter((segment): segment is string => Boolean(segment));
  return segments.join("  ·  ");
}

export function renderTmuxStatusline(
  projectRoot: string,
  side: TmuxStatusSide,
  options: { currentWindow?: string; currentPath?: string } = {},
): string {
  return side === "left"
    ? renderLeft(projectRoot)
    : renderRight(projectRoot, options.currentWindow, options.currentPath);
}
