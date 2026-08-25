/**
 * Dashboards left behind by a reload.
 *
 * Reloading a dashboard kills its tmux window, but the window's shell traps the
 * hangup and exits without signalling the node process it launched through a
 * pipeline — so the dashboard survives with no window. It keeps polling, keeps
 * deciding the daemon is on the wrong build, and replaces it with its own.
 *
 * Observed after a day of repeated local installs: 59 orphaned dashboards from 16
 * builds, all fighting over one daemon. That is what a "daemon restart loop"
 * looked like from the outside, and none of the theories about health probes or
 * repair logic came close.
 *
 * The existing orphan sweep does not cover this: it targets *validation* orphans,
 * processes under a test AIMUX_HOME, so it correctly reported zero while 59 real
 * ones ran.
 *
 * Identified by build, not by window. Mapping a process back to a tmux window is
 * unreliable once the window is gone, whereas the install path is right there in
 * argv — and a dashboard from a build that is no longer installed has no business
 * holding an opinion about which daemon should be running.
 */

const DASHBOARD_ARG = "--tmux-dashboard-internal";
const NATIVE_BUILD_PATTERN = /\/\.aimux\/native\/([^/\s]+)\//;

export interface DashboardProcess {
  pid: number;
  args: string;
}

/** The install directory name (`local-abc1234`) a dashboard process runs from. */
export function dashboardBuildOf(args: string): string | null {
  return NATIVE_BUILD_PATTERN.exec(args)?.[1] ?? null;
}

export function isDashboardProcessArgs(args: string): boolean {
  return args.includes(DASHBOARD_ARG);
}

/**
 * Dashboards running a build other than the current one.
 *
 * Never the current build, however many there are: several dashboards on the
 * installed build are legitimate — one per tmux client — and killing those would
 * take the user's live dashboard down with them. Never a process whose build
 * cannot be read either; unknown is not evidence.
 */
export function selectStaleDashboards(
  processes: readonly DashboardProcess[],
  currentBuild: string,
  currentPid = process.pid,
): DashboardProcess[] {
  if (!currentBuild.trim()) return [];
  return processes.filter((entry) => {
    if (entry.pid === currentPid) return false;
    if (!isDashboardProcessArgs(entry.args)) return false;
    const build = dashboardBuildOf(entry.args);
    return build !== null && build !== currentBuild;
  });
}

/**
 * Dashboards whose window is gone, whatever build they run.
 *
 * A live dashboard's shell is a child of tmux; when the window or the server
 * goes away the shell is reparented to init, and the node process under it keeps
 * running with nothing to render to. Two hops, because the node process's parent
 * is the shell and it is the shell that gets reparented.
 *
 * This is the half `selectStaleDashboards` cannot see: dashboards leak on the
 * current build too, and those are the ones a build comparison will never catch.
 */
export function selectOrphanedDashboards(
  processes: readonly DashboardProcess[],
  parents: ReadonlyMap<number, number>,
  currentPid = process.pid,
  livePanePids: ReadonlySet<number> = new Set(),
): DashboardProcess[] {
  const hasLivePaneAncestor = (pid: number): boolean => {
    const seen = new Set<number>();
    let current: number | undefined = pid;
    while (current !== undefined && current > 1 && !seen.has(current)) {
      if (livePanePids.has(current)) return true;
      seen.add(current);
      current = parents.get(current);
    }
    return false;
  };
  return processes.filter((entry) => {
    if (entry.pid === currentPid) return false;
    if (!isDashboardProcessArgs(entry.args)) return false;
    const shell = parents.get(entry.pid);
    // No parent recorded is unknown, not orphaned.
    if (shell === undefined) return false;
    const grandparent = parents.get(shell);
    if (grandparent === 1) return true;
    return livePanePids.size > 0 && !hasLivePaneAncestor(entry.pid);
  });
}
