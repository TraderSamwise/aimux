import { execFileSync } from "node:child_process";

export type TuiVisibilityReason = "not-tmux" | "visible" | "hidden" | "detached" | "query-failed";

export interface TuiVisibilitySnapshot {
  paneId?: string;
  attached: boolean;
  activeWindow: boolean;
  visible: boolean;
  reason: TuiVisibilityReason;
}

export type TmuxVisibilityQuery = (paneId: string) => string | null | undefined;

export const DASHBOARD_TUI_VISIBILITY_CACHE_MS = 250;

export function parseTmuxVisibility(raw: string | null | undefined, paneId?: string): TuiVisibilitySnapshot {
  const [attachedRaw, activeWindowRaw] = String(raw ?? "")
    .trim()
    .split("\t");
  const attachedCount = Number(attachedRaw);
  if (!Number.isFinite(attachedCount) || (activeWindowRaw !== "0" && activeWindowRaw !== "1")) {
    return visibleFallback(paneId, "query-failed");
  }
  const attached = attachedCount > 0;
  const activeWindow = activeWindowRaw === "1";
  return {
    paneId,
    attached,
    activeWindow,
    visible: attached && activeWindow,
    reason: attached && activeWindow ? "visible" : attached ? "hidden" : "detached",
  };
}

export function visibleFallback(paneId: string | undefined, reason: TuiVisibilityReason): TuiVisibilitySnapshot {
  return {
    paneId,
    attached: true,
    activeWindow: true,
    visible: true,
    reason,
  };
}

export function readTmuxTuiVisibility(
  options: {
    env?: NodeJS.ProcessEnv;
    query?: TmuxVisibilityQuery;
  } = {},
): TuiVisibilitySnapshot {
  const env = options.env ?? process.env;
  const paneId = env.TMUX_PANE?.trim();
  if (!paneId) return visibleFallback(undefined, "not-tmux");
  try {
    const query =
      options.query ??
      ((targetPaneId: string) =>
        execFileSync("tmux", ["display-message", "-p", "-t", targetPaneId, "#{session_attached}\t#{window_active}"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 500,
        }));
    return parseTmuxVisibility(query(paneId), paneId);
  } catch {
    return visibleFallback(paneId, "query-failed");
  }
}

export function readDashboardTuiVisibilityForHost(
  host: any,
  options: {
    force?: boolean;
    now?: number;
    readVisibility?: () => TuiVisibilitySnapshot;
  } = {},
): TuiVisibilitySnapshot {
  if (!host?.startedInDashboard) return visibleFallback(undefined, "not-tmux");
  const now = options.now ?? Date.now();
  const cached = host.dashboardTuiVisibility as TuiVisibilitySnapshot | null | undefined;
  const checkedAt = typeof host.dashboardTuiVisibilityCheckedAt === "number" ? host.dashboardTuiVisibilityCheckedAt : 0;
  if (!options.force && cached && now - checkedAt < DASHBOARD_TUI_VISIBILITY_CACHE_MS) return cached;
  const previousVisible = cached?.visible ?? true;
  const snapshot =
    typeof host.isDashboardTuiVisible === "function"
      ? (() => {
          const visible = host.isDashboardTuiVisible();
          return {
            paneId: cached?.paneId,
            attached: visible,
            activeWindow: visible,
            visible,
            reason: visible ? ("visible" as const) : ("hidden" as const),
          };
        })()
      : (options.readVisibility ?? readTmuxTuiVisibility)();
  host.dashboardTuiVisibility = snapshot;
  host.dashboardTuiVisibilityCheckedAt = now;
  if (!previousVisible && snapshot.visible) {
    host.dashboardTuiVisibilityWakePending = true;
  }
  return snapshot;
}

export function isDashboardTuiVisible(host: any, options: { force?: boolean } = {}): boolean {
  if (typeof host?.isDashboardTuiVisible === "function") {
    return host.isDashboardTuiVisible();
  }
  return readDashboardTuiVisibilityForHost(host, options).visible;
}

export function consumeDashboardTuiVisibilityWake(host: any): boolean {
  const pending = host?.dashboardTuiVisibilityWakePending === true;
  if (host) host.dashboardTuiVisibilityWakePending = false;
  return pending;
}
