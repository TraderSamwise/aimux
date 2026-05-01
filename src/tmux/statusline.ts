import { basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getProjectStateDirFor } from "../paths.js";
import { isDashboardWindowName } from "./runtime-manager.js";
import {
  compactSessionTitle,
  currentPathContext,
  renderDashboardScreens,
  renderDerivedBadge,
  renderSemanticBadge,
  renderSessionCompactHint,
  resolveExactCurrentSessionId,
  resolveExactSessionMetadata,
  resolveScopedSessions,
  trim,
  type StatuslineData,
} from "../statusline-model.js";

export type TmuxStatusLine = "top" | "bottom";

function renderStatusRange(range: string, label: string): string {
  return `#[range=user|${range}]${label}#[norange]`;
}

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

function renderPluginSegment(segment: { text: string; tone?: string }): string {
  const text = trim(segment.text, 18);
  if (!segment.tone || segment.tone === "neutral") return text;
  if (segment.tone === "info") return `#[fg=cyan]${text}#[default]`;
  if (segment.tone === "success") return `#[fg=green]${text}#[default]`;
  if (segment.tone === "warn") return `#[fg=yellow]${text}#[default]`;
  if (segment.tone === "error") return `#[fg=red]${text}#[default]`;
  return text;
}

function renderPluginSegments(
  data: StatuslineData,
  projectRoot: string,
  line: "top" | "bottom",
  currentSession?: string,
  currentWindow?: string,
  currentWindowId?: string,
  currentPath?: string,
): string[] {
  const metadata = resolveExactSessionMetadata(
    data,
    projectRoot,
    currentSession,
    currentWindow,
    currentWindowId,
    currentPath,
  );
  return (metadata?.statusline?.[line] ?? []).map(renderPluginSegment).filter(Boolean);
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
  const pr =
    context?.pr?.number && context?.pr?.url
      ? renderStatusRange("pr", `PR #${context.pr.number}`)
      : context?.pr?.number
        ? `PR #${context.pr.number}`
        : null;
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
  const activeSessionId = resolveExactCurrentSessionId(
    data,
    currentSession,
    currentWindow,
    currentWindowId,
    currentPath,
    projectRoot,
  );
  const activeSession = activeSessionId
    ? (data.sessions ?? []).find((entry) => entry.id === activeSessionId)
    : undefined;
  const metadata = resolveExactSessionMetadata(
    data,
    projectRoot,
    currentSession,
    currentWindow,
    currentWindowId,
    currentPath,
  );
  if (!metadata) return null;
  if (activeSession?.semantic?.presentation.statusLabel) {
    const label = activeSession.semantic.presentation.statusLabel;
    if (label !== "idle" && label !== "offline") return label;
  }
  if ((activeSession?.semantic?.notifications.unreadCount ?? 0) > 0) {
    return `${activeSession?.semantic?.notifications.unreadCount} unread`;
  }
  if ((activeSession?.semantic?.activityNewCount ?? 0) > 0) {
    return `new ${activeSession?.semantic?.activityNewCount}`;
  }
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
    ...(data
      ? renderPluginSegments(data, projectRoot, "top", currentSession, currentWindow, currentWindowId, currentPath)
      : []),
  ].filter((segment): segment is string => Boolean(segment));
  const separator = "  ·  ";
  const joined = segments.join(separator);
  return width ? trim(joined, Math.max(24, width - 2)) : joined;
}

function renderSessionChip(session: ReturnType<typeof resolveScopedSessions>[number]): string {
  const identity = trim(compactSessionTitle(session), 18);
  const hint = renderSessionCompactHint(session);
  const badge =
    hint?.includes(" unread") || hint?.includes(" new")
      ? null
      : (renderSemanticBadge(session.semantic) ?? renderDerivedBadge(session.derived));
  const label = trim(`${identity}${hint ? ` ${hint}` : ""}${badge ? ` ${badge}` : ""}`, 28);
  return session.isCurrent ? `#[fg=black,bg=yellow] ${label} #[default]` : label;
}

function visibleSegmentLength(segment: string): number {
  return segment.replace(/#\[[^\]]*]/g, "").length;
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
  const maxWidth = Math.max(24, (width ?? 120) - 2);
  if (currentWindow && isDashboardWindowName(currentWindow)) {
    const separator = "  ·  ";
    const chosen: string[] = [];
    let used = 0;
    for (const segment of renderDashboardScreens(data.dashboardScreen)) {
      const next = visibleSegmentLength(segment) + (chosen.length > 0 ? separator.length : 0);
      if (used + next > maxWidth) break;
      chosen.push(segment);
      used += next;
    }
    return chosen.join(separator);
  }

  const chips = resolveScopedSessions(
    data,
    projectRoot,
    currentSession,
    currentWindow,
    currentWindowId,
    currentPath,
  ).map(renderSessionChip);
  const headline = renderExactHeadline(data, projectRoot, currentSession, currentWindow, currentWindowId, currentPath);
  const pluginSegments = renderPluginSegments(
    data,
    projectRoot,
    "bottom",
    currentSession,
    currentWindow,
    currentWindowId,
    currentPath,
  );
  const chipSeparator = "  ·  ";
  const detailSeparator = "  |  ";

  const chosenChips: string[] = [];
  let used = 0;
  for (const chip of chips) {
    const next = visibleSegmentLength(chip) + (chosenChips.length > 0 ? chipSeparator.length : 0);
    if (used + next > maxWidth) break;
    chosenChips.push(chip);
    used += next;
  }

  const detailParts = [headline, ...pluginSegments].filter((segment): segment is string => Boolean(segment));
  const detail = detailParts.join("  ·  ");

  if (detail) {
    const headlineWidth = visibleSegmentLength(detail);
    const separatorWidth = chosenChips.length > 0 ? detailSeparator.length : 0;
    if (used + separatorWidth + headlineWidth <= maxWidth) {
      return chosenChips.length > 0 ? `${chosenChips.join(chipSeparator)}${detailSeparator}${detail}` : detail;
    }
  }

  return chosenChips.join(chipSeparator);
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
