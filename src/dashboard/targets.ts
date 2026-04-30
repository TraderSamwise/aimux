import type { TmuxRuntimeManager, TmuxTarget, TmuxSessionRef } from "../tmux/runtime-manager.js";
import { isDashboardWindowName } from "../tmux/runtime-manager.js";
import { getDashboardCommandSpec } from "./command-spec.js";

export interface DashboardTargetRef {
  dashboardSession: TmuxSessionRef;
  dashboardTarget: TmuxTarget;
}

function isUsableDashboardTarget(
  tmux: TmuxRuntimeManager,
  projectRoot: string,
  dashboardBuildStamp: string,
  dashboardTarget: TmuxTarget,
): boolean {
  const currentBuildStamp = tmux.getWindowOption(dashboardTarget, "@aimux-dashboard-build");
  const targetProjectRoot = tmux.getSessionOption(dashboardTarget.sessionName, "@aimux-project-root");
  const paneCommand = tmux.displayMessage("#{pane_current_command}", dashboardTarget.windowId);
  const paneTail = paneCommand === "bash" ? tmux.captureTarget(dashboardTarget, { startLine: -40 }) : "";
  return (
    tmux.isWindowAlive(dashboardTarget) &&
    targetProjectRoot === projectRoot &&
    currentBuildStamp === dashboardBuildStamp &&
    paneCommand !== "cat" &&
    paneCommand !== "tail" &&
    !paneTail.includes("aimux dashboard failed to start.")
  );
}

export function pruneDashboardArtifacts(
  projectRoot: string,
  dashboardBuildStamp: string,
  tmux: TmuxRuntimeManager,
): void {
  const hostSession = tmux.getProjectSession(projectRoot).sessionName;
  const sessions = tmux
    .listSessionNames()
    .filter((sessionName) => sessionName === hostSession || sessionName.startsWith(`${hostSession}-client-`));
  for (const sessionName of sessions) {
    const windows = tmux.listWindows(sessionName);
    const dashboardWindows = windows.filter((window) => isDashboardWindowName(window.name));
    for (const window of dashboardWindows) {
      const target: TmuxTarget = {
        sessionName,
        windowId: window.id,
        windowIndex: window.index,
        windowName: window.name,
      };
      const paneCommand = tmux.displayMessage("#{pane_current_command}", window.id);
      const currentBuildStamp = tmux.getWindowOption(target, "@aimux-dashboard-build");
      const invalid =
        !tmux.isWindowAlive(target) ||
        paneCommand === "cat" ||
        paneCommand === "tail" ||
        !currentBuildStamp ||
        currentBuildStamp !== dashboardBuildStamp;
      if (!invalid) continue;
      try {
        tmux.killWindow(target);
      } catch {}
    }
    if (sessionName === hostSession || !tmux.hasSession(sessionName)) continue;
    const remaining = tmux.listWindows(sessionName);
    const hasValidDashboard = remaining.some((window) => isDashboardWindowName(window.name));
    if (hasValidDashboard) continue;
    const hasNonDashboardWindows = remaining.some((window) => !isDashboardWindowName(window.name));
    if (hasNonDashboardWindows) continue;
    try {
      tmux.killSession(sessionName);
    } catch {}
  }
}

export function findLiveDashboardTarget(projectRoot: string, tmux: TmuxRuntimeManager): DashboardTargetRef | null {
  const { dashboardBuildStamp } = getDashboardCommandSpec(projectRoot);
  pruneDashboardArtifacts(projectRoot, dashboardBuildStamp, tmux);
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
  options: { forceReload?: boolean } = {},
): DashboardTargetRef {
  const { dashboardBuildStamp, dashboardCommand } = getDashboardCommandSpec(projectRoot);
  pruneDashboardArtifacts(projectRoot, dashboardBuildStamp, tmux);

  if (!options.forceReload) {
    const live = findLiveDashboardTarget(projectRoot, tmux);
    if (live) return live;
  }

  const dashboardSession = tmux.ensureProjectSession(projectRoot, {
    cwd: dashboardCommand.cwd,
    command: dashboardCommand.command,
    args: dashboardCommand.args,
  });
  const openSessionName = tmux.getOpenSessionName(dashboardSession.sessionName, tmux.isInsideTmux());
  const dashboardTarget = tmux.ensureDashboardWindow(openSessionName, projectRoot, dashboardCommand);
  const currentBuildStamp = tmux.getWindowOption(dashboardTarget, "@aimux-dashboard-build");
  const shouldRespawn =
    options.forceReload === true || !tmux.isWindowAlive(dashboardTarget) || currentBuildStamp !== dashboardBuildStamp;
  if (shouldRespawn) {
    tmux.respawnWindow(dashboardTarget, dashboardCommand);
    tmux.setWindowOption(dashboardTarget, "@aimux-dashboard-build", dashboardBuildStamp);
  }
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
