import {
  MANAGED_TMUX_AGENT_WINDOW_OPTIONS,
  MANAGED_TMUX_SESSION_OPTIONS,
  MANAGED_TMUX_TERMINAL_FEATURES,
  TmuxRuntimeManager,
} from "./runtime-manager.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDashboardCommandSpec } from "../dashboard/command-spec.js";
import { resolveDashboardTarget } from "../dashboard/targets.js";
import { getProjectStateDirFor } from "../paths.js";

export interface TmuxDoctorOptions {
  projectRoot: string;
  sessionName?: string;
  windowId?: string;
  env?: NodeJS.ProcessEnv;
}

export interface TmuxDoctorCheck {
  expected: string;
  observed: string | null;
  ok: boolean;
}

export interface TmuxDoctorReport {
  env: {
    term: string | null;
    termProgram: string | null;
    insideTmux: boolean;
  };
  tmux: {
    available: boolean;
    version: string | null;
    currentClientSession: string | null;
    currentWindowId: string | null;
    currentWindowName: string | null;
  };
  managedSession: {
    sessionName: string;
    exists: boolean;
    options: Record<string, TmuxDoctorCheck>;
    terminalFeatures: Record<string, TmuxDoctorCheck>;
  };
  activeWindow: null | {
    windowId: string;
    windowName: string | null;
    tool: string | null;
    options: Record<string, TmuxDoctorCheck>;
  };
  managedWindows: Array<{
    windowId: string;
    windowIndex: number;
    windowName: string;
    tool: string;
    allowPassthrough: string | null;
  }>;
  statusline: {
    scriptPath: string;
    scriptExists: boolean;
    projectStateDir: string;
    statuslineJsonExists: boolean;
    tmuxStatuslineDirExists: boolean;
    bottomDashboardExists: boolean;
    bottomDashboardClientExists: boolean;
    sessionFormat: string | null;
    windowFormat: string | null;
    helperPreview: string | null;
    helperError: string | null;
  };
}

export interface TmuxRepairResult {
  projectRoot: string;
  sessionName: string;
  repairedSessions: string[];
  repairedWindows: string[];
  dashboardWindowId: string;
  dashboardSessionName: string;
}

function buildCheck(expected: string, observed: string | null): TmuxDoctorCheck {
  return { expected, observed, ok: observed === expected };
}

function resolveStatuslineScriptPath(): string {
  return fileURLToPath(new URL("../../scripts/tmux-statusline.sh", import.meta.url));
}

function previewStatuslineHelper(input: {
  scriptPath: string;
  projectStateDir: string;
  currentSession: string | null;
  currentWindow: string | null;
  currentWindowId: string | null;
}): { output: string | null; error: string | null } {
  if (!existsSync(input.scriptPath)) {
    return { output: null, error: `missing script: ${input.scriptPath}` };
  }
  try {
    const output = execFileSync(
      "sh",
      [
        input.scriptPath,
        "--line",
        "bottom",
        "--project-state-dir",
        input.projectStateDir,
        "--current-session",
        input.currentSession ?? "",
        "--current-window",
        input.currentWindow ?? "",
        "--current-window-id",
        input.currentWindowId ?? "",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    return { output: output || null, error: null };
  } catch (error) {
    return {
      output: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildTmuxDoctorReport(
  tmux: TmuxRuntimeManager,
  { projectRoot, sessionName, windowId, env = process.env }: TmuxDoctorOptions,
): TmuxDoctorReport {
  const available = tmux.isAvailable();
  const insideTmux = tmux.isInsideTmux(env);
  const currentClientSession = available && insideTmux ? tmux.currentClientSession() : null;
  const resolvedSessionName =
    sessionName ??
    (insideTmux && currentClientSession && tmux.isManagedSessionName(currentClientSession)
      ? currentClientSession
      : tmux.getProjectSession(projectRoot).sessionName);
  const currentWindowId = available ? (windowId ?? (insideTmux ? tmux.displayMessage("#{window_id}") : null)) : null;
  const currentWindowName = available ? (insideTmux ? tmux.displayMessage("#{window_name}") : null) : null;
  const sessionExists = available ? tmux.hasSession(resolvedSessionName) : false;

  const sessionOptions: TmuxDoctorReport["managedSession"]["options"] = {
    prefix: buildCheck(
      MANAGED_TMUX_SESSION_OPTIONS.prefix,
      sessionExists ? tmux.getSessionOption(resolvedSessionName, "prefix") : null,
    ),
    prefix2: buildCheck(
      MANAGED_TMUX_SESSION_OPTIONS.prefix2,
      sessionExists ? tmux.getSessionOption(resolvedSessionName, "prefix2") : null,
    ),
    mouse: buildCheck(
      MANAGED_TMUX_SESSION_OPTIONS.mouse,
      sessionExists ? tmux.getSessionOption(resolvedSessionName, "mouse") : null,
    ),
    "extended-keys": buildCheck(
      MANAGED_TMUX_SESSION_OPTIONS.extendedKeys,
      sessionExists ? tmux.getSessionOption(resolvedSessionName, "extended-keys") : null,
    ),
    "extended-keys-format": buildCheck(
      MANAGED_TMUX_SESSION_OPTIONS.extendedKeysFormat,
      sessionExists ? tmux.getSessionOption(resolvedSessionName, "extended-keys-format") : null,
    ),
  };

  const featureText = sessionExists ? tmux.getSessionOption(resolvedSessionName, "terminal-features") : null;
  const featureSet = new Set(
    featureText
      ?.split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [],
  );
  const terminalFeatures = Object.fromEntries(
    MANAGED_TMUX_TERMINAL_FEATURES.map((feature) => [
      feature,
      { expected: "present", observed: featureSet.has(feature) ? "present" : null, ok: featureSet.has(feature) },
    ]),
  );

  const activeWindow =
    available && currentWindowId
      ? {
          windowId: currentWindowId,
          windowName: currentWindowName,
          tool: tmux.getWindowOption(currentWindowId, "@aimux-tool"),
          options: {
            "allow-passthrough": buildCheck(
              MANAGED_TMUX_AGENT_WINDOW_OPTIONS.allowPassthrough,
              tmux.getWindowOption(currentWindowId, "allow-passthrough"),
            ),
          },
        }
      : null;

  const managedWindows = sessionExists
    ? tmux.listManagedWindows(resolvedSessionName).map(({ target, metadata }) => ({
        windowId: target.windowId,
        windowIndex: target.windowIndex,
        windowName: target.windowName,
        tool: metadata.toolConfigKey,
        allowPassthrough: tmux.getWindowOption(target, "allow-passthrough"),
      }))
    : [];

  const projectStateDir = getProjectStateDirFor(projectRoot);
  const statuslineScript = resolveStatuslineScriptPath();
  const bottomDashboardClientPath = currentClientSession
    ? `${projectStateDir}/tmux-statusline/bottom-dashboard-${currentClientSession}.txt`
    : null;
  const helperPreview = previewStatuslineHelper({
    scriptPath: statuslineScript,
    projectStateDir,
    currentSession: currentClientSession,
    currentWindow: currentWindowName,
    currentWindowId,
  });

  return {
    env: {
      term: env.TERM || null,
      termProgram: env.TERM_PROGRAM || null,
      insideTmux,
    },
    tmux: {
      available,
      version: available ? tmux.getVersion() : null,
      currentClientSession,
      currentWindowId,
      currentWindowName,
    },
    managedSession: {
      sessionName: resolvedSessionName,
      exists: sessionExists,
      options: sessionOptions,
      terminalFeatures,
    },
    activeWindow,
    managedWindows,
    statusline: {
      scriptPath: statuslineScript,
      scriptExists: existsSync(statuslineScript),
      projectStateDir,
      statuslineJsonExists: existsSync(`${projectStateDir}/statusline.json`),
      tmuxStatuslineDirExists: existsSync(`${projectStateDir}/tmux-statusline`),
      bottomDashboardExists: existsSync(`${projectStateDir}/tmux-statusline/bottom-dashboard.txt`),
      bottomDashboardClientExists: bottomDashboardClientPath ? existsSync(bottomDashboardClientPath) : false,
      sessionFormat: sessionExists ? tmux.getSessionOption(resolvedSessionName, "status-format[0]") : null,
      windowFormat: sessionExists ? tmux.getSessionOption(resolvedSessionName, "status-format[1]") : null,
      helperPreview: helperPreview.output,
      helperError: helperPreview.error,
    },
  };
}

export function renderTmuxDoctorReport(report: TmuxDoctorReport): string {
  const lines = [
    "Tmux Doctor",
    `  TERM: ${report.env.term ?? "(unset)"}`,
    `  TERM_PROGRAM: ${report.env.termProgram ?? "(unset)"}`,
    `  inside tmux: ${report.env.insideTmux ? "yes" : "no"}`,
    `  tmux available: ${report.tmux.available ? "yes" : "no"}`,
    `  tmux version: ${report.tmux.version ?? "(unavailable)"}`,
    `  current client session: ${report.tmux.currentClientSession ?? "(none)"}`,
    `  managed session: ${report.managedSession.sessionName}`,
    `  managed session exists: ${report.managedSession.exists ? "yes" : "no"}`,
    "  managed session options:",
  ];

  for (const [key, check] of Object.entries(report.managedSession.options)) {
    lines.push(
      `    ${key}: ${check.observed ?? "(missing)"} (expected ${check.expected}) [${check.ok ? "ok" : "mismatch"}]`,
    );
  }
  lines.push("  managed terminal features:");
  for (const [feature, check] of Object.entries(report.managedSession.terminalFeatures)) {
    lines.push(`    ${feature}: ${check.ok ? "present" : "missing"} [${check.ok ? "ok" : "mismatch"}]`);
  }

  if (report.activeWindow) {
    lines.push(`  active window: ${report.activeWindow.windowId} (${report.activeWindow.windowName ?? "unknown"})`);
    lines.push(`    @aimux-tool: ${report.activeWindow.tool ?? "(unset)"}`);
    for (const [key, check] of Object.entries(report.activeWindow.options)) {
      lines.push(
        `    ${key}: ${check.observed ?? "(missing)"} (expected ${check.expected}) [${check.ok ? "ok" : "mismatch"}]`,
      );
    }
  } else {
    lines.push("  active window: (none)");
  }

  if (report.managedWindows.length > 0) {
    lines.push("  managed windows:");
    for (const window of report.managedWindows) {
      lines.push(
        `    ${window.windowId} ${window.windowName} tool=${window.tool} allow-passthrough=${window.allowPassthrough ?? "(unset)"}`,
      );
    }
  }

  lines.push("  statusline:");
  lines.push(`    script: ${report.statusline.scriptPath}`);
  lines.push(`    script exists: ${report.statusline.scriptExists ? "yes" : "no"}`);
  lines.push(`    project state dir: ${report.statusline.projectStateDir}`);
  lines.push(`    statusline.json: ${report.statusline.statuslineJsonExists ? "yes" : "no"}`);
  lines.push(`    tmux-statusline dir: ${report.statusline.tmuxStatuslineDirExists ? "yes" : "no"}`);
  lines.push(`    bottom-dashboard.txt: ${report.statusline.bottomDashboardExists ? "yes" : "no"}`);
  lines.push(`    bottom-dashboard-<client>.txt: ${report.statusline.bottomDashboardClientExists ? "yes" : "no"}`);
  lines.push(`    status-format[0]: ${report.statusline.sessionFormat ?? "(missing)"}`);
  lines.push(`    status-format[1]: ${report.statusline.windowFormat ?? "(missing)"}`);
  lines.push(`    helper preview: ${report.statusline.helperPreview ?? "(empty)"}`);
  lines.push(`    helper error: ${report.statusline.helperError ?? "(none)"}`);

  return lines.join("\n");
}

export function repairTmuxRuntime(
  tmux: TmuxRuntimeManager,
  { projectRoot, env = process.env }: TmuxDoctorOptions,
): TmuxRepairResult {
  if (!tmux.isAvailable()) {
    throw new Error("tmux is not installed or not available in PATH");
  }

  const hostSession = tmux.getProjectSession(projectRoot).sessionName;
  const { dashboardCommand } = getDashboardCommandSpec(projectRoot);
  const currentClientSession = tmux.isInsideTmux(env) ? tmux.currentClientSession() : null;
  const managedSessions = new Set<string>([hostSession]);

  for (const sessionName of tmux.listSessionNames()) {
    if (sessionName === hostSession || sessionName.startsWith(`${hostSession}-client-`)) {
      managedSessions.add(sessionName);
    }
  }
  if (
    currentClientSession &&
    (currentClientSession === hostSession || currentClientSession.startsWith(`${hostSession}-client-`))
  ) {
    managedSessions.add(currentClientSession);
  }

  tmux.ensureProjectSession(projectRoot, dashboardCommand);
  for (const sessionName of managedSessions) {
    if (!tmux.hasSession(sessionName)) continue;
    tmux.configureManagedSession(sessionName, projectRoot);
  }

  const { dashboardSession, dashboardTarget } = resolveDashboardTarget(projectRoot, tmux, { forceReload: true });
  managedSessions.add(dashboardSession.sessionName);
  managedSessions.add(dashboardTarget.sessionName);
  for (const sessionName of managedSessions) {
    if (!tmux.hasSession(sessionName)) continue;
    tmux.configureManagedSession(sessionName, projectRoot);
  }

  const repairedWindows = new Set<string>();
  for (const sessionName of managedSessions) {
    if (!tmux.hasSession(sessionName)) continue;
    for (const { target, metadata } of tmux.listManagedWindows(sessionName)) {
      tmux.applyManagedAgentWindowPolicy(target, metadata.toolConfigKey);
      repairedWindows.add(target.windowId);
    }
  }

  return {
    projectRoot,
    sessionName: hostSession,
    repairedSessions: [...managedSessions].filter((sessionName) => tmux.hasSession(sessionName)),
    repairedWindows: [...repairedWindows],
    dashboardWindowId: dashboardTarget.windowId,
    dashboardSessionName: dashboardTarget.sessionName,
  };
}

export function renderTmuxRepairResult(result: TmuxRepairResult): string {
  return [
    "Tmux Repair",
    `  project root: ${result.projectRoot}`,
    `  host session: ${result.sessionName}`,
    `  repaired sessions: ${result.repairedSessions.length}`,
    ...result.repairedSessions.map((sessionName) => `    ${sessionName}`),
    `  repaired windows: ${result.repairedWindows.length}`,
    ...result.repairedWindows.map((windowId) => `    ${windowId}`),
    `  dashboard target: ${result.dashboardSessionName}:${result.dashboardWindowId}`,
  ].join("\n");
}
