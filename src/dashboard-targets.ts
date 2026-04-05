import { fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import type { TmuxCommandSpec, TmuxRuntimeManager, TmuxTarget, TmuxSessionRef } from "./tmux-runtime-manager.js";
import { isDashboardWindowName } from "./tmux-runtime-manager.js";

export interface DashboardTargetRef {
  dashboardSession: TmuxSessionRef;
  dashboardTarget: TmuxTarget;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function getDashboardCommandSpec(projectRoot: string): {
  scriptPath: string;
  dashboardBuildStamp: string;
  dashboardCommand: TmuxCommandSpec;
} {
  const scriptPath = fileURLToPath(new URL("./main.js", import.meta.url));
  const wrappedDashboardCommand = [
    "output_file=$(mktemp /tmp/aimux-dashboard-output.XXXXXX)",
    ";",
    "set -o pipefail",
    ";",
    shellQuote(process.execPath),
    shellQuote(scriptPath),
    "--tmux-dashboard-internal",
    "2>&1",
    "|",
    "tee",
    '"$output_file"',
    "|",
    "tee",
    "-a",
    shellQuote("/tmp/aimux-debug.log"),
    ";",
    "code=$?",
    ";",
    "if",
    "[",
    "$code",
    "-ne",
    "0",
    "]",
    ";",
    "then",
    "printf",
    "'\\033[?1049l\\033[H\\033[2J'",
    ";",
    "if",
    "[",
    "-s",
    '"$output_file"',
    "]",
    ";",
    "then",
    "cat",
    '"$output_file"',
    ";",
    "else",
    "printf",
    "%s\\n%s\\n",
    shellQuote("No dashboard stderr/stdout was captured."),
    shellQuote("Last debug log lines:"),
    ";",
    "tail",
    "-n",
    "40",
    shellQuote("/tmp/aimux-debug.log"),
    ";",
    "fi",
    ";",
    "printf",
    "%s\\n",
    shellQuote(""),
    ";",
    "printf",
    "%s\\n%s\\n%s\\n%s\\n%s\\n",
    shellQuote("aimux dashboard failed to start."),
    shellQuote("The error above was captured from the dashboard process."),
    shellQuote("If that output is empty, the last debug-log lines were shown instead."),
    shellQuote("Press q, Enter, or Ctrl+C to close this pane."),
    shellQuote(""),
    ";",
    "printf",
    "%s\\n",
    '"exit code: $code"',
    ";",
    "while",
    "IFS= read -rsn1 key",
    ";",
    "do",
    "if",
    "[",
    "-z",
    '"$key"',
    "]",
    "||",
    "[",
    '"$key"',
    "=",
    shellQuote("q"),
    "]",
    ";",
    "then",
    "rm",
    "-f",
    '"$output_file"',
    ";",
    "exit 0",
    ";",
    "fi",
    ";",
    "done",
    ";",
    "else",
    "rm",
    "-f",
    '"$output_file"',
    ";",
    "fi",
  ].join(" ");
  return {
    scriptPath,
    dashboardBuildStamp: String(statSync(scriptPath).mtimeMs),
    dashboardCommand: {
      cwd: projectRoot,
      command: "bash",
      args: ["-lc", wrappedDashboardCommand],
    },
  };
}

function isUsableDashboardTarget(
  tmux: TmuxRuntimeManager,
  dashboardBuildStamp: string,
  dashboardTarget: TmuxTarget,
): boolean {
  const currentBuildStamp = tmux.getWindowOption(dashboardTarget, "@aimux-dashboard-build");
  const paneCommand = tmux.displayMessage("#{pane_current_command}", dashboardTarget.windowId);
  return (
    tmux.isWindowAlive(dashboardTarget) &&
    currentBuildStamp === dashboardBuildStamp &&
    paneCommand !== "cat" &&
    paneCommand !== "tail"
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
  const candidateSessions = [
    tmux.currentClientSession(),
    tmux.peekOpenSessionName(dashboardSession.sessionName, tmux.isInsideTmux()),
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
      if (!isUsableDashboardTarget(tmux, dashboardBuildStamp, target)) continue;
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
