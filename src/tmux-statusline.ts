import { basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getProjectStateDirFor } from "./paths.js";
import { isDashboardWindowName } from "./tmux-runtime-manager.js";
import { renderDashboardScreens, trim, type StatuslineData } from "./statusline-model.js";

export type TmuxStatusLine = "top" | "bottom";

function loadStatusline(projectRoot: string): StatuslineData | null {
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

function renderTopLine(
  projectRoot: string,
  currentWindow?: string,
  currentWindowId?: string,
  currentPath?: string,
  currentSession?: string,
  width?: number,
): string {
  const data = loadStatusline(projectRoot);
  const segments = [renderProjectIdentity(projectRoot), data ? renderControlPlane(data) : "ctl down"].filter(
    (segment): segment is string => Boolean(segment),
  );
  const separator = "  ·  ";
  const joined = segments.join(separator);
  return width ? trim(joined, Math.max(24, width - 2)) : joined;
}

function renderBottomLine(
  projectRoot: string,
  currentWindow?: string,
  currentWindowId?: string,
  currentPath?: string,
  currentSession?: string,
  width?: number,
): string {
  const data = loadStatusline(projectRoot);
  if (!data) return "";
  const segments =
    currentWindow && isDashboardWindowName(currentWindow)
      ? renderDashboardScreens(data.dashboardScreen)
      : currentWindow
        ? [`[${trim(currentWindow, 24)}]`]
        : [];
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
        projectRoot,
        options.currentWindow,
        options.currentWindowId,
        options.currentPath,
        options.currentSession,
        options.width,
      )
    : renderBottomLine(
        projectRoot,
        options.currentWindow,
        options.currentWindowId,
        options.currentPath,
        options.currentSession,
        options.width,
      );
}
