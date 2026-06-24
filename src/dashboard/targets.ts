import type { TmuxRuntimeManager, TmuxTarget, TmuxSessionRef } from "../tmux/runtime-manager.js";
import { isDashboardWindowName } from "../tmux/runtime-manager.js";
import { getDashboardCommandSpec } from "./command-spec.js";
import { getRuntimeOwnerId, TMUX_DASHBOARD_OWNER_OPTION, TMUX_RUNTIME_OWNER_OPTION } from "../runtime-owner.js";

export interface DashboardTargetRef {
  dashboardSession: TmuxSessionRef;
  dashboardTarget: TmuxTarget;
}

export function isUsableDashboardTarget(
  tmux: TmuxRuntimeManager,
  projectRoot: string,
  dashboardBuildStamp: string,
  dashboardTarget: TmuxTarget,
): boolean {
  const currentBuildStamp = tmux.getWindowOption(dashboardTarget, "@aimux-dashboard-build");
  const currentOwner = getRuntimeOwnerId();
  const targetRuntimeOwner = tmux.getSessionOption(dashboardTarget.sessionName, TMUX_RUNTIME_OWNER_OPTION);
  const targetDashboardOwner = tmux.getWindowOption(dashboardTarget, TMUX_DASHBOARD_OWNER_OPTION);
  const targetProjectRoot = tmux.getSessionOption(dashboardTarget.sessionName, "@aimux-project-root");
  const paneCommand = tmux.displayMessage("#{pane_current_command}", dashboardTarget.windowId);
  const paneTail = paneCommand === "bash" ? tmux.captureTarget(dashboardTarget, { startLine: -40 }) : "";
  return (
    tmux.isWindowAlive(dashboardTarget) &&
    targetProjectRoot === projectRoot &&
    targetRuntimeOwner === currentOwner &&
    targetDashboardOwner === currentOwner &&
    currentBuildStamp === dashboardBuildStamp &&
    paneCommand !== "cat" &&
    paneCommand !== "tail" &&
    !paneTail.includes("aimux dashboard failed to start.")
  );
}

export function findLiveDashboardTarget(projectRoot: string, tmux: TmuxRuntimeManager): DashboardTargetRef | null {
  const { dashboardBuildStamp } = getDashboardCommandSpec(projectRoot);
  const dashboardSession = tmux.getProjectSession(projectRoot);
  const preferredOpenSession = tmux.getOpenSessionName(dashboardSession.sessionName, tmux.isInsideTmux());
  const currentClientSession = tmux.currentClientSession();
  const sameProjectCurrentClientSession =
    currentClientSession &&
    (currentClientSession === dashboardSession.sessionName ||
      currentClientSession.startsWith(`${dashboardSession.sessionName}-client-`))
      ? currentClientSession
      : null;
  const candidateSessions = [
    preferredOpenSession,
    sameProjectCurrentClientSession,
    dashboardSession.sessionName,
    ...tmux
      .listSessionNames()
      .filter((sessionName) => sessionName.startsWith(`${dashboardSession.sessionName}-client-`)),
  ].filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);

  for (const sessionName of candidateSessions) {
    if (!tmux.hasSession(sessionName)) continue;
    for (const window of tmux.listWindows(sessionName)) {
      if (!isDashboardWindowName(window.name)) continue;
      const target: TmuxTarget = {
        sessionName,
        windowId: window.id,
        windowIndex: window.index,
        windowName: window.name,
      };
      if (!isUsableDashboardTarget(tmux, projectRoot, dashboardBuildStamp, target)) continue;
      return { dashboardSession, dashboardTarget: target };
    }
  }

  return null;
}

export function resolveDashboardTarget(
  projectRoot: string,
  tmux: TmuxRuntimeManager,
  options: { forceReload?: boolean; openInHostSession?: boolean } = {},
): DashboardTargetRef {
  const { dashboardBuildStamp, dashboardCommand } = getDashboardCommandSpec(projectRoot);

  if (!options.forceReload) {
    const live = findLiveDashboardTarget(projectRoot, tmux);
    if (live) return live;
  }

  const dashboardSession = tmux.ensureProjectSession(projectRoot, {
    cwd: dashboardCommand.cwd,
    command: dashboardCommand.command,
    args: dashboardCommand.args,
  });
  const openSessionName = options.openInHostSession
    ? dashboardSession.sessionName
    : tmux.getOpenSessionName(dashboardSession.sessionName, tmux.isInsideTmux());
  const dashboardTarget = tmux.ensureDashboardWindow(openSessionName, projectRoot, dashboardCommand);
  const currentBuildStamp = tmux.getWindowOption(dashboardTarget, "@aimux-dashboard-build");
  const currentOwner = getRuntimeOwnerId();
  const currentDashboardOwner = tmux.getWindowOption(dashboardTarget, TMUX_DASHBOARD_OWNER_OPTION);
  const shouldRespawn =
    options.forceReload === true ||
    !tmux.isWindowAlive(dashboardTarget) ||
    currentBuildStamp !== dashboardBuildStamp ||
    currentDashboardOwner !== currentOwner;
  if (shouldRespawn) {
    tmux.respawnWindow(dashboardTarget, dashboardCommand);
  }
  tmux.setSessionOption(dashboardSession.sessionName, "@aimux-dashboard-build", dashboardBuildStamp);
  tmux.setWindowOption(dashboardTarget, "@aimux-dashboard-build", dashboardBuildStamp);
  tmux.setWindowOption(dashboardTarget, TMUX_DASHBOARD_OWNER_OPTION, currentOwner);
  return { dashboardSession, dashboardTarget };
}

export function openDashboardTarget(
  projectRoot: string,
  tmux: TmuxRuntimeManager,
  options: { forceReload?: boolean } = {},
): DashboardTargetRef {
  const resolved = resolveDashboardTarget(projectRoot, tmux, options);
  tmux.openTarget(resolved.dashboardTarget, {
    insideTmux: tmux.isInsideTmux(),
    alreadyResolved: true,
  });
  return resolved;
}
