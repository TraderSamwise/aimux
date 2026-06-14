import { loadConfig, type ToolConfig } from "../config.js";
import { parseKeys } from "../key-parser.js";
import { parseEnvAssignments, parseShellArgs, type LaunchOverride } from "../shell-args.js";
import { applyLineEdit, createLineState, renderLineWindow, type LineState } from "../line-editor.js";
import { stripAnsi, truncateAnsi } from "../tui/render/text.js";
import { forkDashboardAgentWithFeedback, spawnDashboardAgentWithFeedback } from "./dashboard-ops.js";
import { findMainRepo } from "../worktree.js";
import { setSessionOverseer } from "../metadata-store.js";

type ToolPickerHost = any;
type ToolEntry = [string, ToolConfig];

/** Editing state for the structured "o" launch-options overlay. */
export interface LaunchOptionsState {
  toolKey: string;
  args: LineState;
  env: LineState;
  activeField: "args" | "env";
  error: string | null;
}

/** Render configured default env as an editable "KEY=VALUE KEY=VALUE" string. */
export function formatEnvDefaults(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .map(([key, value]) => `${key}=${quoteShellArg(value)}`)
    .join(" ");
}

/** Build the launch override implied by a tool's configured defaults, or undefined if it has none. */
export function defaultsLaunchOverride(tool: ToolConfig): LaunchOverride | undefined {
  const defaultArgs = tool.defaultArgs ?? [];
  const hasEnv = tool.defaultEnv && Object.keys(tool.defaultEnv).length > 0;
  if (defaultArgs.length === 0 && !hasEnv) return undefined;
  return {
    command: tool.command,
    args: [...tool.args, ...defaultArgs],
    env: hasEnv ? tool.defaultEnv : undefined,
  };
}

function initStructuredOptions(toolKey: string, tool: ToolConfig): LaunchOptionsState {
  return {
    toolKey,
    args: createLineState((tool.defaultArgs ?? []).map(quoteShellArg).join(" ")),
    env: createLineState(formatEnvDefaults(tool.defaultEnv)),
    activeField: "args",
    error: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function enabledTools(): ToolEntry[] {
  const config = loadConfig();
  return Object.entries(config.tools).filter(([, t]) => t.enabled);
}

function clampPickerIndex(host: ToolPickerHost, tools: ToolEntry[]): number {
  const max = Math.max(0, tools.length - 1);
  const index = typeof host.toolPickerIndex === "number" ? host.toolPickerIndex : 0;
  host.toolPickerIndex = Math.min(Math.max(index, 0), max);
  return host.toolPickerIndex;
}

function quoteShellArg(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

function commandPreview(command: string, args: string[]): string {
  return [command, ...args].map(quoteShellArg).join(" ");
}

function envPrefix(env: Record<string, string>): string {
  const keys = Object.keys(env);
  if (keys.length === 0) return "";
  return `env ${keys.map((k) => `${k}=${quoteShellArg(env[k])}`).join(" ")} `;
}

function fieldWidth(): number {
  return Math.max(12, (process.stdout.columns ?? 80) - 28);
}

function renderBox(lines: string[], color = "44;97"): string {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const width = Math.max(1, Math.min(cols - 4, Math.max(...lines.map((l) => stripAnsi(l).length)) + 4));
  const startRow = Math.max(1, Math.floor((rows - lines.length - 2) / 2));
  const startCol = Math.max(1, Math.floor((cols - width) / 2));

  let output = "\x1b7";
  for (let i = 0; i < lines.length + 2; i++) {
    const row = startRow + i;
    output += `\x1b[${row};${startCol}H`;
    if (i === 0 || i === lines.length + 1) {
      output += `\x1b[${color}m${"─".repeat(width)}\x1b[0m`;
    } else {
      const line = truncateAnsi(lines[i - 1], width - 4);
      const pad = " ".repeat(Math.max(0, width - 2 - stripAnsi(line).length));
      output += `\x1b[${color}m  ${line}${pad}\x1b[0m`;
    }
  }
  output += "\x1b8";
  return output;
}

function redrawOverlay(host: ToolPickerHost, build: (host: ToolPickerHost) => string): void {
  if (typeof host.redrawDashboardWithOverlay === "function") {
    host.redrawDashboardWithOverlay();
  } else {
    process.stdout.write(build(host));
  }
}

export function buildToolPickerOverlayOutput(host: ToolPickerHost): string {
  const tools = enabledTools();
  const selectedIndex = clampPickerIndex(host, tools);

  const lines = [
    host.pickerMode === "fork" && host.forkSourceSessionId
      ? `Fork from ${host.forkSourceSessionId}: select tool`
      : "Select tool:",
  ];
  for (let i = 0; i < tools.length; i++) {
    const cursor = i === selectedIndex ? "▸" : " ";
    lines.push(`${cursor} [${i + 1}] ${tools[i][0]}`);
  }
  lines.push("");
  lines.push("  [Enter/1-9] start   [o] options   [Esc] cancel");

  return renderBox(lines);
}

export function buildToolOptionsOverlayOutput(host: ToolPickerHost): string {
  const tools = enabledTools();
  const state: LaunchOptionsState | null = host.launchOptionsState;
  const selected = state ? tools.find(([key]) => key === state.toolKey) : undefined;
  if (!state || !selected) {
    return renderBox(["No enabled tools", "", "  [Esc] back"], "41;97");
  }

  const [toolKey, tool] = selected;
  const width = fieldWidth();

  let extraArgs: string[] = [];
  let env: Record<string, string> = {};
  let parseError = state.error;
  try {
    extraArgs = parseShellArgs(state.args.text);
  } catch (error) {
    parseError = parseError ?? errorMessage(error);
  }
  if (!parseError) {
    try {
      env = parseEnvAssignments(state.env.text);
    } catch (error) {
      parseError = errorMessage(error);
    }
  }

  const argsValue =
    state.activeField === "args" ? renderLineWindow(state.args, width) : truncateAnsi(state.args.text, width);
  const envValue =
    state.activeField === "env" ? renderLineWindow(state.env, width) : truncateAnsi(state.env.text, width);
  const argMarker = state.activeField === "args" ? "▸" : " ";
  const envMarker = state.activeField === "env" ? "▸" : " ";

  const lines = [
    host.pickerMode === "fork" && host.forkSourceSessionId
      ? `Fork ${toolKey}: launch options`
      : `${toolKey}: launch options`,
    "",
    `  Defaults: ${commandPreview(tool.command, tool.args)}`,
    "",
    `${argMarker} ${"Extra args:".padEnd(11)} ${argsValue}`,
    `${envMarker} ${"Env vars:".padEnd(11)} ${envValue}`,
    "",
    `  Launch: ${envPrefix(parseError ? {} : env)}${commandPreview(tool.command, [...tool.args, ...extraArgs])}`,
  ];
  if (parseError) {
    lines.push("");
    lines.push(`  Error: ${parseError}`);
  }
  lines.push("");
  lines.push("  [Tab] switch field   [Enter] start   [Esc] back");

  return renderBox(lines, parseError ? "41;97" : "44;97");
}

export function renderToolPicker(host: ToolPickerHost): void {
  redrawOverlay(host, buildToolPickerOverlayOutput);
}

export function runSelectedTool(
  host: ToolPickerHost,
  toolKey: string,
  tool: ToolConfig,
  opts: { override?: LaunchOverride } = {},
): void {
  // The overseer is project-wide: it ignores the focused worktree and roots at the main repo.
  const overseer = host.toolPickerOverseer === true;
  host.toolPickerOverseer = false;
  const wtPath = overseer
    ? findMainRepo()
    : host.mode === "dashboard"
      ? host.dashboardState.focusedWorktreePath
      : undefined;
  // A plain launch (no explicit override) still applies the tool's configured defaults.
  const override = opts.override ?? defaultsLaunchOverride(tool);
  host.launchOptionsState = null;

  if (host.pickerMode === "fork") {
    const sourceSessionId = host.forkSourceSessionId;
    host.pickerMode = "create";
    host.forkSourceSessionId = null;
    if (!sourceSessionId) {
      host.showDashboardError("Cannot fork session", ["Fork source was lost before tool selection. Try again."]);
      return;
    }
    const targetSessionId = host.generateDashboardSessionId(tool.command);
    const shouldRenderPending = host.startedInDashboard && host.mode === "dashboard";
    if (shouldRenderPending) {
      void forkDashboardAgentWithFeedback(host, {
        sourceSessionId,
        targetSessionId,
        tool: toolKey,
        worktreePath: wtPath,
        launchOverride: override,
      });
      return;
    }
    void host.forkAgent({
      sourceSessionId,
      targetToolConfigKey: toolKey,
      targetSessionId,
      targetWorktreePath: wtPath,
      open: false,
      launchOverride: override,
    });
    return;
  }

  host.pickerMode = "create";
  host.forkSourceSessionId = null;
  const sessionId = host.generateDashboardSessionId(tool.command);
  const shouldRenderPending = host.startedInDashboard && host.mode === "dashboard";
  if (shouldRenderPending) {
    void spawnDashboardAgentWithFeedback(host, {
      sessionId,
      tool: toolKey,
      worktreePath: wtPath,
      launchOverride: override,
      overseer,
    });
    return;
  }
  const transport = host.createSession(
    override?.command ?? tool.command,
    override?.args ?? tool.args,
    tool.preambleFlag,
    toolKey,
    undefined,
    tool.sessionIdFlag,
    wtPath,
    undefined,
    sessionId,
    false,
    false,
    overseer ? { teamId: "overseer", parentSessionId: "", role: "overseer" } : undefined,
    override?.env,
  );
  if (overseer && transport?.id) {
    setSessionOverseer(transport.id, true);
  }
}

export function showToolPicker(host: ToolPickerHost, sourceSessionId?: string, opts?: { overseer?: boolean }): void {
  host.pickerMode = sourceSessionId ? "fork" : "create";
  host.forkSourceSessionId = sourceSessionId ?? null;
  host.toolPickerOverseer = opts?.overseer === true;
  host.toolPickerIndex = 0;
  host.launchOptionsState = null;

  host.openDashboardOverlay("tool-picker");
  renderToolPicker(host);
}

export function handleToolPickerKey(host: ToolPickerHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  const event = events[0];
  const key = event.name || event.char;
  const tools = enabledTools();
  const selectedIndex = clampPickerIndex(host, tools);

  if (key === "escape") {
    host.clearDashboardOverlay();
    host.pickerMode = "create";
    host.forkSourceSessionId = null;
    host.launchOptionsState = null;
    host.restoreDashboardAfterOverlayDismiss();
    return;
  }

  if (key === "up" || key === "k") {
    host.toolPickerIndex = Math.max(0, selectedIndex - 1);
    renderToolPicker(host);
    return;
  }

  if (key === "down" || key === "j") {
    host.toolPickerIndex = Math.min(tools.length - 1, selectedIndex + 1);
    renderToolPicker(host);
    return;
  }

  if (key === "o") {
    const picked = tools[selectedIndex];
    if (!picked) {
      renderToolPicker(host);
      return;
    }
    host.launchOptionsState = initStructuredOptions(picked[0], picked[1]);
    host.openDashboardOverlay("tool-options");
    redrawOverlay(host, buildToolOptionsOverlayOutput);
    return;
  }

  if (key === "enter" || key === "return") {
    const picked = tools[selectedIndex];
    if (!picked) {
      renderToolPicker(host);
      return;
    }
    const [pickedKey, tool] = picked;
    host.clearDashboardOverlay();
    runSelectedTool(host, pickedKey, tool);
    return;
  }

  if (key >= "1" && key <= "9") {
    const idx = parseInt(key) - 1;
    if (idx < tools.length) {
      const [pickedKey, tool] = tools[idx];
      host.clearDashboardOverlay();
      runSelectedTool(host, pickedKey, tool);
      return;
    }
  }

  renderToolPicker(host);
}

export function handleToolOptionsKey(host: ToolPickerHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  const event = events[0];
  const key = event.name || event.char;
  const state: LaunchOptionsState | null = host.launchOptionsState;

  const backToPicker = () => {
    host.launchOptionsState = null;
    host.openDashboardOverlay("tool-picker");
    renderToolPicker(host);
  };

  if (!state || key === "escape") {
    backToPicker();
    return;
  }

  if (key === "tab" || key === "up" || key === "down") {
    state.activeField = state.activeField === "args" ? "env" : "args";
    redrawOverlay(host, buildToolOptionsOverlayOutput);
    return;
  }

  if (key === "enter" || key === "return") {
    const selected = enabledTools().find(([toolKey]) => toolKey === state.toolKey);
    if (!selected) {
      backToPicker();
      return;
    }
    const [toolKey, tool] = selected;
    let extraArgs: string[];
    let env: Record<string, string>;
    try {
      extraArgs = parseShellArgs(state.args.text);
      env = parseEnvAssignments(state.env.text);
    } catch (error) {
      state.error = errorMessage(error);
      redrawOverlay(host, buildToolOptionsOverlayOutput);
      return;
    }
    const override: LaunchOverride = {
      command: tool.command,
      args: [...tool.args, ...extraArgs],
      env: Object.keys(env).length ? env : undefined,
    };
    host.clearDashboardOverlay();
    runSelectedTool(host, toolKey, tool, { override });
    return;
  }

  const field = state.activeField === "args" ? state.args : state.env;
  if (applyLineEdit(field, event)) {
    state.error = null;
    redrawOverlay(host, buildToolOptionsOverlayOutput);
  }
}
