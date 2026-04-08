import { execSync } from "node:child_process";

import { loadConfig, type ToolConfig } from "../config.js";
import { parseKeys } from "../key-parser.js";

type ToolPickerHost = any;

export function isToolAvailable(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function renderToolPicker(host: ToolPickerHost): void {
  const config = loadConfig();
  const tools = Object.entries(config.tools).filter(([, t]) => t.enabled);

  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;

  const lines = [
    host.pickerMode === "fork" && host.forkSourceSessionId
      ? `Fork from ${host.forkSourceSessionId}: select tool`
      : "Select tool:",
  ];
  for (let i = 0; i < tools.length; i++) {
    const available = isToolAvailable(tools[i][1].command);
    const label = available ? `  [${i + 1}] ${tools[i][0]}` : `  [${i + 1}] ${tools[i][0]} (not installed)`;
    lines.push(label);
  }
  lines.push("");
  lines.push("  [Esc] Cancel");

  const boxWidth = Math.max(...lines.map((l) => l.length)) + 4;
  const startRow = Math.floor((rows - lines.length - 2) / 2);
  const startCol = Math.floor((cols - boxWidth) / 2);

  let output = "\x1b7";
  for (let i = 0; i < lines.length + 2; i++) {
    const row = startRow + i;
    output += `\x1b[${row};${startCol}H`;
    if (i === 0 || i === lines.length + 1) {
      output += `\x1b[44;97m${"─".repeat(boxWidth)}\x1b[0m`;
    } else {
      const line = lines[i - 1];
      output += `\x1b[44;97m  ${line.padEnd(boxWidth - 2)}\x1b[0m`;
    }
  }
  output += "\x1b8";
  process.stdout.write(output);
}

export function runSelectedTool(host: ToolPickerHost, toolKey: string, tool: ToolConfig): void {
  const wtPath = host.mode === "dashboard" ? host.dashboardState.focusedWorktreePath : undefined;

  if (host.pickerMode === "fork") {
    const sourceSessionId = host.forkSourceSessionId;
    host.pickerMode = "create";
    host.forkSourceSessionId = null;
    if (!sourceSessionId) {
      host.showDashboardError("Cannot fork session", ["Fork source was lost before tool selection. Try again."]);
      return;
    }
    host.startDashboardBusy("Forking agent", [
      `Source: ${sourceSessionId}`,
      `Tool: ${toolKey}`,
      "Seeding carried-over context",
    ]);
    void host
      .forkAgent({
        sourceSessionId,
        targetToolConfigKey: toolKey,
        targetWorktreePath: wtPath,
        open: true,
      })
      .catch((error: unknown) => host.showDashboardError("Cannot fork session", [String(error)]))
      .finally(() => host.clearDashboardBusy());
    return;
  }

  host.pickerMode = "create";
  host.forkSourceSessionId = null;
  const sessionId = host.generateDashboardSessionId(tool.command);
  const shouldRenderPending = host.startedInDashboard && host.mode === "dashboard";
  if (shouldRenderPending) {
    host.setPendingDashboardSessionAction(sessionId, "creating");
  }
  try {
    host.createSession(
      tool.command,
      tool.args,
      tool.preambleFlag,
      toolKey,
      undefined,
      tool.sessionIdFlag,
      wtPath,
      undefined,
      sessionId,
      shouldRenderPending,
    );
    host.settleDashboardCreatePending(sessionId);
  } catch (error) {
    if (shouldRenderPending) {
      host.setPendingDashboardSessionAction(sessionId, null);
    }
    throw error;
  }
}

export function showToolPicker(host: ToolPickerHost, sourceSessionId?: string): void {
  const config = loadConfig();
  const tools = Object.entries(config.tools).filter(([, t]) => t.enabled);
  host.pickerMode = sourceSessionId ? "fork" : "create";
  host.forkSourceSessionId = sourceSessionId ?? null;

  if (tools.length === 1) {
    const [key, tool] = tools[0];
    if (isToolAvailable(tool.command)) {
      runSelectedTool(host, key, tool);
      return;
    }
  }

  host.pickerActive = true;
  renderToolPicker(host);
}

export function handleToolPickerKey(host: ToolPickerHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;

  const event = events[0];
  const key = event.name || event.char;

  host.pickerActive = false;

  if (key === "escape") {
    host.pickerMode = "create";
    host.forkSourceSessionId = null;
    host.restoreDashboardAfterOverlayDismiss();
    return;
  }

  if (key >= "1" && key <= "9") {
    const config = loadConfig();
    const tools = Object.entries(config.tools).filter(([, t]) => t.enabled);
    const idx = parseInt(key) - 1;
    if (idx < tools.length) {
      const [pickedKey, tool] = tools[idx];
      if (!isToolAvailable(tool.command)) {
        process.stdout.write(
          `\x1b7\x1b[${(process.stdout.rows ?? 24) - 2};1H\x1b[41;97m "${tool.command}" is not installed. Install it first. \x1b[0m\x1b8`,
        );
        setTimeout(() => {
          host.pickerActive = false;
          host.restoreDashboardAfterOverlayDismiss();
        }, 2000);
        return;
      }
      runSelectedTool(host, pickedKey, tool);
      return;
    }
  }

  host.pickerMode = "create";
  host.forkSourceSessionId = null;
  host.renderDashboard();
}
