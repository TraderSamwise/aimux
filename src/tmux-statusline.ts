import { basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getProjectStateDirFor } from "./paths.js";
import { isDashboardWindowName } from "./tmux-runtime-manager.js";
import {
  compactSessionTitle,
  currentPathContext,
  renderDashboardScreens,
  renderDerivedBadge,
  renderSessionCompactHint,
  resolveExactCurrentSessionId,
  resolveExactSessionMetadata,
  resolveScopedSessions,
  sessionIdentity,
  trim,
  type StatuslineData,
} from "./statusline-model.js";

export type TmuxStatusLine = "top" | "bottom";

export function loadStatusline(projectRoot: string): StatuslineData | null {
  try {
    const path = `${getProjectStateDirFor(projectRoot)}/statusline.json`;
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as StatuslineData;
  } catch {
    return null;
  }
}

function isStatuslineStale(data: StatuslineData): boolean {
  const updatedAt = data.updatedAt ? Date.parse(data.updatedAt) : Number.NaN;
  if (!Number.isFinite(updatedAt)) return true;
  return Date.now() - updatedAt > 8_000;
}

function renderControlPlane(data: StatuslineData): string {
  if (isStatuslineStale(data)) return "ctl stale";
  if (data.controlPlane?.projectServiceAlive === false) return "ctl svc↓";
  if (data.controlPlane?.daemonAlive === false) return "ctl daemon↓";
  return "ctl ok";
}

function renderProjectIdentity(projectRoot: string): string {
  return `aimux ${basename(projectRoot)}`;
}

function renderActiveContext(
  data: StatuslineData,
  projectRoot: string,
  currentSession?: string,
  currentWindow?: string,
  currentWindowId?: string,
  currentPath?: string,
): string | null {
  if (currentWindow && isDashboardWindowName(currentWindow)) return null;
  const activeSessionId = resolveExactCurrentSessionId(
    data,
    currentSession,
    currentWindow,
    currentWindowId,
    currentPath,
    projectRoot,
  );
  if (!activeSessionId) return null;
  const context = data.metadata?.[activeSessionId]?.context;
  const services = data.metadata?.[activeSessionId]?.derived?.services ?? [];
  const liveContext = currentPathContext(currentPath);
  const worktree = liveContext?.worktreeName
    ? trim(liveContext.worktreeName, 16)
    : context?.worktreeName
      ? trim(context.worktreeName, 16)
      : null;
  const branch = liveContext?.branch ? trim(liveContext.branch, 18) : context?.branch ? trim(context.branch, 18) : null;
  const pr = context?.pr?.number ? `PR #${context.pr.number}` : null;
  const service =
    services.length > 0
      ? services[0]?.port
        ? `:${services[0].port}`
        : services[0]?.url
          ? trim(services[0].url.replace(/^https?:\/\//, ""), 18)
          : null
      : null;
  if (!worktree && !branch && !pr && !service) return null;
  if (worktree && branch && pr) return [`${worktree}@${branch}`, pr, service].filter(Boolean).join("  ·  ");
  if (worktree && branch) return [`${worktree}@${branch}`, service].filter(Boolean).join("  ·  ");
  return [worktree, branch, pr, service].filter((segment): segment is string => Boolean(segment)).join("  ·  ");
}

function renderTasks(data: StatuslineData): string | null {
  const pending = data.tasks?.pending ?? 0;
  const assigned = data.tasks?.assigned ?? 0;
  if (pending === 0 && assigned === 0) return null;
  return `tasks ${pending}/${assigned}`;
}

function renderExactHeadline(
  data: StatuslineData,
  projectRoot: string,
  currentSession?: string,
  currentWindow?: string,
  currentWindowId?: string,
  currentPath?: string,
): string | null {
  const activeSessionId = resolveExactCurrentSessionId(
    data,
    currentSession,
    currentWindow,
    currentWindowId,
    currentPath,
    projectRoot,
  );
  if (!activeSessionId) return null;
  const session = (data.sessions ?? []).find((entry) => entry.id === activeSessionId);
  const headline = session?.headline?.trim();
  if (!headline) return null;
  return trim(headline, 42);
}

function renderActiveMetadata(
  data: StatuslineData,
  projectRoot: string,
  currentSession?: string,
  currentWindow?: string,
  currentWindowId?: string,
  currentPath?: string,
): string | null {
  if (currentWindow && isDashboardWindowName(currentWindow)) return null;
  const metadata = resolveExactSessionMetadata(
    data,
    projectRoot,
    currentSession,
    currentWindow,
    currentWindowId,
    currentPath,
  );
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
  data: StatuslineData | null,
  projectRoot: string,
  currentWindow?: string,
  currentWindowId?: string,
  currentPath?: string,
  currentSession?: string,
  width?: number,
): string {
  const segments = [
    renderProjectIdentity(projectRoot),
    data ? renderControlPlane(data) : "ctl down",
    data ? renderActiveContext(data, projectRoot, currentSession, currentWindow, currentWindowId, currentPath) : null,
    data ? renderTasks(data) : null,
    data ? renderActiveMetadata(data, projectRoot, currentSession, currentWindow, currentWindowId, currentPath) : null,
  ].filter((segment): segment is string => Boolean(segment));
  const separator = "  ·  ";
  const joined = segments.join(separator);
  return width ? trim(joined, Math.max(24, width - 2)) : joined;
}

function renderSessionChip(session: ReturnType<typeof resolveScopedSessions>[number]): string {
  const identity = trim(compactSessionTitle(session), 18);
  const badge = renderDerivedBadge(session.derived);
  const hint = renderSessionCompactHint(session);
  const label = trim(`${identity}${hint ? ` ${hint}` : ""}${badge ? ` ${badge}` : ""}`, 28);
  return session.isCurrent ? `[${label}]` : label;
}

function renderBottomLine(
  data: StatuslineData | null,
  projectRoot: string,
  currentWindow?: string,
  currentWindowId?: string,
  currentPath?: string,
  currentSession?: string,
  width?: number,
): string {
  if (!data) return "";
  const segments =
    currentWindow && isDashboardWindowName(currentWindow)
      ? renderDashboardScreens(data.dashboardScreen)
      : [
          ...resolveScopedSessions(data, projectRoot, currentSession, currentWindow, currentWindowId, currentPath).map(
            renderSessionChip,
          ),
          renderExactHeadline(data, projectRoot, currentSession, currentWindow, currentWindowId, currentPath),
        ].filter((segment): segment is string => Boolean(segment));
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

export function renderTmuxStatuslineFromData(
  data: StatuslineData | null,
  projectRoot: string,
  line: TmuxStatusLine,
  options: {
    currentWindow?: string;
    currentWindowId?: string;
    currentPath?: string;
    currentSession?: string;
    width?: number;
  } = {},
): string {
  return line === "top"
    ? renderTopLine(
        data,
        projectRoot,
        options.currentWindow,
        options.currentWindowId,
        options.currentPath,
        options.currentSession,
        options.width,
      )
    : renderBottomLine(
        data,
        projectRoot,
        options.currentWindow,
        options.currentWindowId,
        options.currentPath,
        options.currentSession,
        options.width,
      );
}

export function renderTmuxStatusline(
  projectRoot: string,
  line: TmuxStatusLine,
  options: {
    currentWindow?: string;
    currentWindowId?: string;
    currentPath?: string;
    currentSession?: string;
    width?: number;
  } = {},
): string {
  return renderTmuxStatuslineFromData(loadStatusline(projectRoot), projectRoot, line, options);
}
