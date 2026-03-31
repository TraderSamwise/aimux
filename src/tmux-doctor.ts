import {
  MANAGED_TMUX_AGENT_WINDOW_OPTIONS,
  MANAGED_TMUX_SESSION_OPTIONS,
  MANAGED_TMUX_TERMINAL_FEATURES,
  TmuxRuntimeManager,
} from "./tmux-runtime-manager.js";

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
}

function buildCheck(expected: string, observed: string | null): TmuxDoctorCheck {
  return { expected, observed, ok: observed === expected };
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

  return lines.join("\n");
}
