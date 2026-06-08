import { loadConfig, type ToolConfig } from "../config.js";
import { parseKeys } from "../key-parser.js";
import { parseLaunchCommandLine, type LaunchOverride } from "../shell-args.js";
import { forkDashboardAgentWithFeedback, spawnDashboardAgentWithFeedback } from "./dashboard-ops.js";

type ToolPickerHost = any;
type ToolEntry = [string, ToolConfig];

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

function renderBox(lines: string[], color = "44;97"): string {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const width = Math.min(cols - 4, Math.max(...lines.map((l) => l.length)) + 4);
  const startRow = Math.max(1, Math.floor((rows - lines.length - 2) / 2));
  const startCol = Math.max(1, Math.floor((cols - width) / 2));

  let output = "\x1b7";
  for (let i = 0; i < lines.length + 2; i++) {
    const row = startRow + i;
    output += `\x1b[${row};${startCol}H`;
    if (i === 0 || i === lines.length + 1) {
      output += `\x1b[${color}m${"─".repeat(width)}\x1b[0m`;
    } else {
      const line = lines[i - 1].slice(0, width - 4);
      output += `\x1b[${color}m  ${line.padEnd(width - 2)}\x1b[0m`;
    }
  }
  output += "\x1b8";
  return output;
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
  const selected = tools.find(([key]) => key === host.toolOptionsToolKey) ?? tools[clampPickerIndex(host, tools)];
  if (!selected) {
    return renderBox(["No enabled tools", "", "  [Esc] back"], "41;97");
  }

  const [toolKey, tool] = selected;
  const buffer = host.toolOptionsBuffer ?? "";
  let override: LaunchOverride | undefined;
  let parseError = host.toolOptionsError;
  if (!parseError) {
    try {
      override = parseLaunchCommandLine(buffer);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  const lines = [
    host.pickerMode === "fork" && host.forkSourceSessionId
      ? `Fork ${toolKey}: launch command`
      : `${toolKey}: launch command`,
    "",
    `  ${buffer}_`,
  ];
  if (override) {
    lines.push("");
    if (override.env) {
      const envStr = Object.entries(override.env)
        .map(([key, value]) => `${key}=${quoteShellArg(value)}`)
        .join(" ");
      lines.push(`  Env:    ${envStr}`);
    }
    lines.push(`  Launch: ${commandPreview(override.command, override.args)}`);
    lines.push("");
    lines.push(
      override.command === tool.command
        ? "  aimux hooks + session tracking applied"
        : "  custom binary — launched without aimux hooks",
    );
  }
  if (parseError) {
    lines.push("");
    lines.push(`  Error: ${parseError}`);
  }
  lines.push("");
  lines.push("  [Enter] start   [Esc] back");

  return renderBox(lines, parseError ? "41;97" : "44;97");
}

export function renderToolPicker(host: ToolPickerHost): void {
  if (host.mode === "dashboard" && typeof host.redrawDashboardWithOverlay === "function") {
    host.redrawDashboardWithOverlay();
    return;
  }
  process.stdout.write(buildToolPickerOverlayOutput(host));
}

export function runSelectedTool(
  host: ToolPickerHost,
  toolKey: string,
  tool: ToolConfig,
  opts: { override?: LaunchOverride } = {},
): void {
  const wtPath = host.mode === "dashboard" ? host.dashboardState.focusedWorktreePath : undefined;
  const override = opts.override;

  if (host.pickerMode === "fork") {
    const sourceSessionId = host.forkSourceSessionId;
    host.pickerMode = "create";
    host.forkSourceSessionId = null;
    host.toolOptionsToolKey = null;
    host.toolOptionsBuffer = "";
    host.toolOptionsError = null;
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
  host.toolOptionsToolKey = null;
  host.toolOptionsBuffer = "";
  host.toolOptionsError = null;
  const sessionId = host.generateDashboardSessionId(tool.command);
  const shouldRenderPending = host.startedInDashboard && host.mode === "dashboard";
  if (shouldRenderPending) {
    void spawnDashboardAgentWithFeedback(host, {
      sessionId,
      tool: toolKey,
      worktreePath: wtPath,
      launchOverride: override,
    });
    return;
  }
  host.createSession(
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
    undefined,
    override?.env,
  );
}

export function showToolPicker(host: ToolPickerHost, sourceSessionId?: string): void {
  host.pickerMode = sourceSessionId ? "fork" : "create";
  host.forkSourceSessionId = sourceSessionId ?? null;
  host.toolPickerIndex = 0;
  host.toolOptionsToolKey = null;
  host.toolOptionsBuffer = "";
  host.toolOptionsError = null;

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
    host.toolOptionsToolKey = null;
    host.toolOptionsBuffer = "";
    host.toolOptionsError = null;
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
    host.toolOptionsToolKey = picked[0];
    host.toolOptionsBuffer = commandPreview(picked[1].command, picked[1].args);
    host.toolOptionsError = null;
    host.openDashboardOverlay("tool-options");
    if (typeof host.redrawDashboardWithOverlay === "function") {
      host.redrawDashboardWithOverlay();
    } else {
      process.stdout.write(buildToolOptionsOverlayOutput(host));
    }
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

  if (key === "escape") {
    host.toolOptionsToolKey = null;
    host.toolOptionsBuffer = "";
    host.toolOptionsError = null;
    host.openDashboardOverlay("tool-picker");
    renderToolPicker(host);
    return;
  }

  if (key === "backspace") {
    host.toolOptionsBuffer = (host.toolOptionsBuffer ?? "").slice(0, -1);
    host.toolOptionsError = null;
    if (typeof host.redrawDashboardWithOverlay === "function") {
      host.redrawDashboardWithOverlay();
    } else {
      process.stdout.write(buildToolOptionsOverlayOutput(host));
    }
    return;
  }

  if (key === "enter" || key === "return") {
    const tools = enabledTools();
    const selected = tools.find(([toolKey]) => toolKey === host.toolOptionsToolKey);
    if (!selected) {
      host.openDashboardOverlay("tool-picker");
      renderToolPicker(host);
      return;
    }
    const [toolKey, tool] = selected;
    let override: LaunchOverride;
    try {
      override = parseLaunchCommandLine(host.toolOptionsBuffer ?? "");
    } catch (error) {
      host.toolOptionsError = error instanceof Error ? error.message : String(error);
      if (typeof host.redrawDashboardWithOverlay === "function") {
        host.redrawDashboardWithOverlay();
      } else {
        process.stdout.write(buildToolOptionsOverlayOutput(host));
      }
      return;
    }
    host.clearDashboardOverlay();
    runSelectedTool(host, toolKey, tool, { override });
    return;
  }

  if (event.name === "paste" || event.char) {
    host.toolOptionsBuffer = `${host.toolOptionsBuffer ?? ""}${event.char}`;
    host.toolOptionsError = null;
    if (typeof host.redrawDashboardWithOverlay === "function") {
      host.redrawDashboardWithOverlay();
    } else {
      process.stdout.write(buildToolOptionsOverlayOutput(host));
    }
  }
}
