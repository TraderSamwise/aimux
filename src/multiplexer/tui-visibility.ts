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
export type TmuxPaneListQuery = () => string | null | undefined;
export type ProcessListQuery = () => string | null | undefined;

export const DASHBOARD_TUI_VISIBILITY_CACHE_MS = 250;

export interface TmuxPaneRow {
  paneId: string;
  panePid: number;
  attachedRaw: string;
  activeWindowRaw: string;
}

interface TmuxProcessVisibilityResolution {
  snapshot: TuiVisibilitySnapshot;
  matched: boolean;
}

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

export function parseTmuxPaneRows(raw: string | null | undefined): TmuxPaneRow[] {
  return String(raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [paneId, panePidRaw, attachedRaw, activeWindowRaw] = line.split("\t");
      const panePid = Number(panePidRaw);
      if (!paneId || !Number.isFinite(panePid) || !attachedRaw || !activeWindowRaw) return [];
      return [{ paneId, panePid, attachedRaw, activeWindowRaw }];
    });
}

export function parseProcessParents(raw: string | null | undefined): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of String(raw ?? "").split("\n")) {
    const [pidRaw, ppidRaw] = line.trim().split(/\s+/);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) parents.set(pid, ppid);
  }
  return parents;
}

export function findTmuxPaneForProcess(
  panes: TmuxPaneRow[],
  parents: Map<number, number>,
  pid: number,
): TmuxPaneRow | undefined {
  const panePids = new Set(panes.map((pane) => pane.panePid));
  const seen = new Set<number>();
  let current = pid;
  while (Number.isFinite(current) && current > 0 && !seen.has(current)) {
    if (panePids.has(current)) return panes.find((pane) => pane.panePid === current);
    seen.add(current);
    const parent = parents.get(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return undefined;
}

function readTmuxPaneList(query?: TmuxPaneListQuery): string | null | undefined {
  const listPanes =
    query ??
    (() =>
      execFileSync(
        "tmux",
        ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}\t#{session_attached}\t#{window_active}"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 500,
        },
      ));
  return listPanes();
}

function readProcessList(query?: ProcessListQuery): string | null | undefined {
  const listProcesses =
    query ??
    (() =>
      execFileSync("ps", ["-axo", "pid=,ppid="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 500,
      }));
  return listProcesses();
}

function readTmuxTuiVisibilityFromProcess(
  options: {
    listPanes?: TmuxPaneListQuery;
    listProcesses?: ProcessListQuery;
    pid?: number;
    stalePaneId?: string;
  } = {},
): TmuxProcessVisibilityResolution | null {
  const panes = parseTmuxPaneRows(readTmuxPaneList(options.listPanes));
  if (panes.length === 0) return null;
  const parents = parseProcessParents(readProcessList(options.listProcesses));
  const pane = findTmuxPaneForProcess(panes, parents, options.pid ?? process.pid);
  if (pane) {
    return {
      snapshot: parseTmuxVisibility(`${pane.attachedRaw}\t${pane.activeWindowRaw}`, pane.paneId),
      matched: true,
    };
  }
  if (options.stalePaneId && panes.some((row) => row.paneId === options.stalePaneId)) {
    return {
      snapshot: visibleFallback(options.stalePaneId, "query-failed"),
      matched: false,
    };
  }
  return {
    snapshot: {
      paneId: options.stalePaneId,
      attached: false,
      activeWindow: false,
      visible: false,
      reason: "detached",
    },
    matched: false,
  };
}

export function readTmuxTuiVisibility(
  options: {
    env?: NodeJS.ProcessEnv;
    query?: TmuxVisibilityQuery;
    listPanes?: TmuxPaneListQuery;
    listProcesses?: ProcessListQuery;
    pid?: number;
  } = {},
): TuiVisibilitySnapshot {
  const env = options.env ?? process.env;
  const paneId = env.TMUX_PANE?.trim();
  if (!paneId) return visibleFallback(undefined, "not-tmux");
  let directSnapshot: TuiVisibilitySnapshot | null = null;
  try {
    const query =
      options.query ??
      ((targetPaneId: string) =>
        execFileSync("tmux", ["display-message", "-p", "-t", targetPaneId, "#{session_attached}\t#{window_active}"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 500,
        }));
    directSnapshot = parseTmuxVisibility(query(paneId), paneId);
  } catch {
    // Fall through to process-tree recovery below. Dashboard reloads can leave
    // an old node process with a stale TMUX_PANE that tmux no longer knows.
  }
  try {
    const processResolution = readTmuxTuiVisibilityFromProcess({
      listPanes: options.listPanes,
      listProcesses: options.listProcesses,
      pid: options.pid,
      stalePaneId: paneId,
    });
    if (processResolution?.matched) return processResolution.snapshot;
    if (directSnapshot?.reason && directSnapshot.reason !== "query-failed") return directSnapshot;
    if (processResolution) return processResolution.snapshot;
  } catch {
    if (directSnapshot?.reason && directSnapshot.reason !== "query-failed") return directSnapshot;
  }
  return visibleFallback(paneId, "query-failed");
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
